/**
 * Shared DTEK adapter. All DTEK regional sites expose the same
 * `window.DisconSchedule` global, so a single fetch+parse implementation is
 * parameterized per region by {@link createDtekAdapter}.
 */

import { CollectError, STATUS } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import { normalize } from './normalize.js';

const NAV_TIMEOUT_MS = Number(process.env.DTEK_NAV_TIMEOUT_MS || 45000);
const DATA_TIMEOUT_MS = Number(process.env.DTEK_DATA_TIMEOUT_MS || 180000);
/** How long to sit on DTEK's "heavy load" page, counted from when it first shows. */
const OVERLOAD_WAIT_MS = Number(process.env.DTEK_OVERLOAD_WAIT_MS || 300000);
/** The waiting room's own reload flashes a tiny document by; leave it this long before reloading. */
const OVERLOAD_RELOAD_GRACE_MS = 30000;
const FRAME_READ_TIMEOUT_MS = 2000;

/** Read a `DisconSchedule.<key> = {…}` literal from raw HTML via brace matching. */
function sliceBalanced(html, marker) {
  const markerIdx = html.indexOf(marker);
  if (markerIdx < 0) return null;
  let i = html.indexOf('=', markerIdx);
  if (i < 0) return null;
  i += 1;
  while (i < html.length && /\s/.test(html[i])) i += 1;
  const open = html[i];
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (!close) return null;

  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let j = i; j < html.length; j += 1) {
    const ch = html[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    } else if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) return html.slice(i, j + 1);
    }
  }
  return null;
}

/** Fallback extraction straight from the served HTML if the global is absent. */
function extractFromHtml(html) {
  const presetText = sliceBalanced(html, 'DisconSchedule.preset');
  if (!presetText) return null;
  const factText = sliceBalanced(html, 'DisconSchedule.fact');
  try {
    const preset = JSON.parse(presetText);
    const fact = factText ? JSON.parse(factText) : null;
    return {
      preset,
      fact,
      sourceUpdatedAt: (fact && fact.update) || (preset && preset.updateFact) || null,
    };
  } catch {
    return null;
  }
}

async function readUpdatedLabel(page) {
  return page
    .evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const match = text.match(/оновлен[оа][^\d]*(\d{2}\.\d{2}\.\d{4}[^\d]*\d{2}:\d{2})/i);
      return match ? match[1].replace(/\s+/g, ' ').trim() : null;
    })
    .catch(() => null);
}

/**
 * DTEK's "under heavy load" page ("Сайт працює, але через велике навантаження
 * треба трохи зачекати…") is an Imperva Waiting Room. Seen live 2026-11-03: the
 * main document is a ~1 KB shell, the text sits in an iframe
 * (`/_Incapsula_Resource?CWUDNSAI=43&…&edet=47&…&wrid=378`) and its `wr.js` polls
 * the queue, then reloads the parent by itself once we are let in. So we must NOT
 * reload it (that would only re-queue us and add load) — just keep waiting, up to
 * OVERLOAD_WAIT_MS.
 */
const OVERLOAD_RE = /велике\s+навантаження|трохи\s+зачекати/i;
const WAITING_ROOM_SHELL_RE = /_Incapsula_Resource\?[^"'>]*\b(?:edet=47|wrid=\d)/;
function looksLikeOverload(html) {
  if (!html || html.includes('DisconSchedule')) return false;
  return OVERLOAD_RE.test(html) || WAITING_ROOM_SHELL_RE.test(html);
}

/** A frame that is mid-navigation must not stall the wait loop. */
function readFrame(frame) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve(''), FRAME_READ_TIMEOUT_MS));
  return Promise.race([frame.content().catch(() => ''), timeout]);
}

/** True while the page shows the waiting room, in its main document or in an iframe. */
async function onWaitingRoom(page, mainHtml) {
  if (looksLikeOverload(mainHtml)) return true;
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame() && looksLikeOverload(await readFrame(frame))) return true;
  }
  return false;
}

/** Dismiss the promo/info modal that sometimes covers the page. */
async function dismissModal(page) {
  await page.locator('[data-micromodal-close]').first().click({ timeout: 1500 }).catch(() => {});
}

/** Read the live DisconSchedule snapshot, or null if preset.data is still empty. */
async function readSnapshot(page) {
  const raw = await page
    .evaluate(() => {
      const ds = window.DisconSchedule || {};
      return { preset: ds.preset ?? null, fact: ds.fact ?? null };
    })
    .catch(() => null);
  if (!raw || !raw.preset || !raw.preset.data || Object.keys(raw.preset.data).length === 0) return null;
  raw.sourceUpdatedAt =
    (raw.fact && raw.fact.update) ||
    (raw.preset && raw.preset.updateFact) ||
    (await readUpdatedLabel(page));
  return raw;
}

/**
 * Navigate and clear the Incapsula challenge, then return the raw snapshot.
 *
 * Incapsula serves a tiny stub whose script sets `visid_incap_*`/`incap_ses_*`
 * cookies and reloads; under load it may also show a "please wait" page. Rather
 * than a single wait that dies the moment the page reloads, we poll patiently:
 * if we are still on a challenge/stub page we let its script run and reload with
 * the fresh cookies; if the real page is up we wait for its JS to populate
 * `DisconSchedule`. This keeps trying for the whole `DATA_TIMEOUT_MS` budget.
 */
async function fetchSnapshot(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await dismissModal(page);

  // The tiny Incapsula challenge stub is ~1 KB; the real page is tens of KB.
  // (The real page ALSO embeds an `_Incapsula_Resource` telemetry script, so
  // that marker alone is NOT a reliable "still challenged" signal — only size is.)
  const looksLikeStub = (html) => !html || html.length < 2500;

  let deadline = Date.now() + DATA_TIMEOUT_MS;
  let sawChallenge = false;
  let overloadSince = null;
  let overloadLastSeen = 0;
  let reachedRealPage = false;
  let reloads = 0;

  const loaded = (snapshot) => {
    if (sawChallenge || overloadSince !== null) {
      log.info('DTEK page loaded', {
        url,
        reloads,
        sawOverload: overloadSince !== null,
        waitedMs: overloadSince === null ? 0 : Date.now() - overloadSince,
      });
    }
    return snapshot;
  };

  while (Date.now() < deadline) {
    // 1) Fast path: the app JS populated the live global.
    const raw = await readSnapshot(page).catch(() => null);
    if (raw) return loaded(raw);

    // 2) The cleared page embeds preset/fact inline — parse straight from HTML
    //    the moment the real page is served, without waiting for its JS.
    const html = await page.content().catch(() => '');
    const overloaded = await onWaitingRoom(page, html);
    const stub = looksLikeStub(html);
    if (!stub && !overloaded) {
      reachedRealPage = true;
      const fallback = extractFromHtml(html);
      if (fallback) return loaded(fallback);
    }

    // 3) Overload page → wait patiently, never reload; give it the full
    //    OVERLOAD_WAIT_MS from the moment it first appeared.
    if (overloaded) {
      overloadLastSeen = Date.now();
      if (overloadSince === null) {
        overloadSince = overloadLastSeen;
        deadline = Math.max(deadline, overloadSince + OVERLOAD_WAIT_MS);
        log.info('DTEK overload page, waiting for it to load', { url, waitMs: OVERLOAD_WAIT_MS });
      }
      await page.waitForTimeout(3000);
      continue;
    }

    // 4) Still on the stub → let its script set cookies, then reload so the
    //    follow-up request carries them; on a real-but-not-ready page just wait.
    sawChallenge = sawChallenge || stub;
    await page.waitForTimeout(stub ? 3000 : 1500);
    if (!stub) continue;

    // The page may have moved on by itself during that pause: never reload a
    // page that has already loaded, turned out to be the waiting room, or is
    // mid-navigation.
    const current = await page.content().catch(() => '');
    if (!current || !looksLikeStub(current) || (await onWaitingRoom(page, current))) continue;
    if (overloadSince !== null && Date.now() - overloadLastSeen < OVERLOAD_RELOAD_GRACE_MS) continue;

    reloads += 1;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {});
    await dismissModal(page);
  }

  // Budget exhausted — one last parse, otherwise classify the block.
  const html = await page.content().catch(() => '');
  const fallback = extractFromHtml(html);
  if (fallback) {
    log.info('used HTML fallback extraction', { url });
    return fallback;
  }
  if (overloadSince !== null) {
    // Already waited minutes; an immediate retry would only re-queue us and
    // stall the whole run. The next scheduled run will try again.
    const err = new CollectError(STATUS.TIMEOUT, 'DTEK overload page did not load in time');
    err.retryable = false;
    throw err;
  }
  if (!reachedRealPage && looksLikeStub(html)) {
    throw new CollectError(STATUS.WAF_BLOCKED, 'Incapsula challenge did not clear');
  }
  throw new CollectError(STATUS.TIMEOUT, 'DisconSchedule did not populate in time');
}

/**
 * @param {{id: string, displayName: string, region: string, url: string}} config
 * @returns {import('../../core/schema.js').SourceAdapter}
 */
export function createDtekAdapter(config) {
  return {
    id: config.id,
    displayName: config.displayName,
    region: config.region,
    url: config.url,
    fetch: (page) => fetchSnapshot(page, config.url),
    parse: (raw) => normalize(raw),
  };
}

export const __test__ = { sliceBalanced, extractFromHtml, looksLikeOverload, fetchSnapshot };
