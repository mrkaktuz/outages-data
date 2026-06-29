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
    return {
      preset: JSON.parse(presetText),
      fact: factText ? JSON.parse(factText) : null,
      sourceUpdatedAt: null,
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

/** Navigate, clear the challenge, and return the raw DisconSchedule snapshot. */
async function fetchSnapshot(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  // A promo/info modal sometimes covers the page; dismiss it if present.
  await page
    .locator('[data-micromodal-close]')
    .first()
    .click({ timeout: 2000 })
    .catch(() => {});

  try {
    await page.waitForFunction(
      () =>
        !!(
          window.DisconSchedule &&
          window.DisconSchedule.preset &&
          Object.keys(window.DisconSchedule.preset).length > 0
        ),
      { timeout: DATA_TIMEOUT_MS, polling: 2000 },
    );
  } catch {
    const html = await page.content();
    if (html.length < 2000 || html.includes('_Incapsula_Resource')) {
      throw new CollectError(STATUS.WAF_BLOCKED, 'Incapsula challenge did not clear');
    }
    const fallback = extractFromHtml(html);
    if (fallback) {
      log.info('used HTML fallback extraction', { url });
      return fallback;
    }
    throw new CollectError(STATUS.TIMEOUT, 'DisconSchedule did not populate in time');
  }

  const raw = await page.evaluate(() => {
    const ds = window.DisconSchedule || {};
    return { preset: ds.preset ?? null, fact: ds.fact ?? null };
  });
  if (!raw.preset || Object.keys(raw.preset).length === 0) {
    throw new CollectError(STATUS.NO_DATA, 'preset is empty after page load');
  }
  raw.sourceUpdatedAt = await readUpdatedLabel(page);
  return raw;
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

export const __test__ = { sliceBalanced, extractFromHtml };
