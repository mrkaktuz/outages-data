/**
 * Чернігівобленерго (ЧОЕ) adapter.
 *
 * The schedule comes from a JSON API rather than an embedded global:
 *   POST https://interruptions.energy.cn.ua/api/info_schedule_part
 *        {"queue": "1/1", "curr_dt": "YYYY-MM-DD"}
 * returning a per-queue, per-day list of state intervals (see {@link normalizeChernihiv}).
 *
 * We collect every queue ("1/1".."6/2") for today and tomorrow. The requests run
 * *inside* a page loaded on the site's own origin, for two reasons: they are then
 * same-origin (the API only answers its own front-end), and Chromium's network
 * stack completes the host's incomplete TLS certificate chain (via AIA) that a
 * bare Node request rejects — so we never have to disable TLS verification.
 */

import { CollectError, STATUS } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import { kyivWallToInstant, kyivDateOffset } from '../../core/time.js';
import { normalizeChernihiv } from './parse.js';

const NAV_TIMEOUT_MS = Number(process.env.CHERNIHIV_NAV_TIMEOUT_MS || process.env.DTEK_NAV_TIMEOUT_MS || 45000);

const ORIGIN = 'https://interruptions.energy.cn.ua';
const PAGE_URL = `${ORIGIN}/interruptions`;
const API_PATH = '/api/info_schedule_part';

/** Queues as the API expects them ("1/1") paired with our output label ("1.1"). */
function queueList() {
  const queues = [];
  for (let g = 1; g <= 6; g += 1) {
    for (let s = 1; s <= 2; s += 1) queues.push({ param: `${g}/${s}`, label: `${g}.${s}` });
  }
  return queues;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Today + tomorrow as {str: "YYYY-MM-DD", ts: <kyiv-midnight unix seconds>}. */
function targetDates(now = new Date()) {
  return [0, 1].map((offset) => {
    const d = kyivDateOffset(offset, now);
    return {
      str: `${d.year}-${pad(d.month)}-${pad(d.day)}`,
      ts: Math.floor(kyivWallToInstant(d.year, d.month, d.day, 0).getTime() / 1000),
    };
  });
}

async function fetchSnapshot(page) {
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  // The API is captcha-gated (HTTP 400 {"error":"No captcha"}). The site's own
  // front-end mints a token for each request; we do the same from inside the page.
  // Give its captcha script time to initialize before probing.
  await page
    .waitForFunction(() => window.grecaptcha || window.hcaptcha || window.turnstile, { timeout: 12000 })
    .catch(() => {});

  const queues = queueList();
  const dates = targetDates();

  const collected = await page.evaluate(
    async ({ apiPath, queues, dateStrs }) => {
      // Detect which captcha system the page uses and its site key.
      const scriptSrcs = [...document.querySelectorAll('script[src]')]
        .map((s) => s.src)
        .filter((s) => /recaptcha|hcaptcha|captcha|turnstile/i.test(s));
      let siteKey = (document.querySelector('[data-sitekey]') || {}).getAttribute?.('data-sitekey') || null;
      for (const s of scriptSrcs) {
        const m = s.match(/[?&]render=([\w-]+)/);
        if (m) siteKey = m[1];
      }
      const env = {
        hasGrecaptcha: typeof window.grecaptcha !== 'undefined',
        hasHcaptcha: typeof window.hcaptcha !== 'undefined',
        hasTurnstile: typeof window.turnstile !== 'undefined',
        siteKey,
        scriptSrcs: scriptSrcs.slice(0, 4),
      };

      // Mint a reCAPTCHA v3 token the same way the site's front-end does.
      async function captchaToken(action) {
        try {
          if (window.grecaptcha && siteKey && typeof grecaptcha.execute === 'function') {
            await new Promise((r) => (grecaptcha.ready ? grecaptcha.ready(r) : r()));
            return await grecaptcha.execute(siteKey, { action });
          }
        } catch {
          /* fall through */
        }
        return null;
      }

      const out = {};
      let aState = null;
      let okCount = 0;
      const diag = [];
      for (const dt of dateStrs) {
        out[dt] = {};
        const responses = await Promise.all(
          queues.map(async (q) => {
            try {
              const captcha = await captchaToken('schedule');
              const body = { queue: q.param, curr_dt: dt };
              if (captcha) body.captcha = captcha;
              const res = await fetch(apiPath, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: '*/*' },
                body: JSON.stringify(body),
              });
              const text = await res.text();
              let json = null;
              try {
                json = JSON.parse(text);
              } catch {
                /* non-JSON body */
              }
              return { label: q.label, ok: res.ok, status: res.status, hadCaptcha: !!captcha, json, snippet: text.slice(0, 160) };
            } catch (e) {
              return { label: q.label, ok: false, status: 0, err: String(e && e.message) };
            }
          }),
        );
        for (const r of responses) {
          if (r.json && Array.isArray(r.json.aData)) {
            out[dt][r.label] = r.json.aData;
            if (!aState && r.json.aState) aState = r.json.aState;
            okCount += 1;
          }
          if (diag.length < 3) diag.push({ dt, label: r.label, ok: r.ok, status: r.status, hadCaptcha: r.hadCaptcha, err: r.err, snippet: r.snippet });
        }
      }
      return { out, aState, okCount, diag, env };
    },
    { apiPath: API_PATH, queues, dateStrs: dates.map((d) => d.str) },
  );

  // Surface the captcha env + what the API actually returned — invaluable in CI.
  log.info('chernihiv api probe', { okCount: collected.okCount, env: collected.env, diag: collected.diag });

  const data = {};
  let total = 0;
  for (const date of dates) {
    const perQueue = collected.out[date.str] || {};
    const labels = Object.keys(perQueue);
    if (labels.length === 0) continue;
    data[String(date.ts)] = perQueue;
    total += labels.length;
  }

  if (collected.okCount === 0) {
    throw new CollectError(
      STATUS.NO_DATA,
      `Chernihiv API returned no valid response (diag: ${JSON.stringify(collected.diag)})`,
    );
  }

  log.info('chernihiv parsed', { dates: Object.keys(data).length, queueDays: total });
  return {
    preset: { aState: collected.aState || null },
    fact: { data, update: null },
    sourceUpdatedAt: null,
  };
}

/** @type {import('../../core/schema.js').SourceAdapter} */
const adapter = {
  id: 'chernihiv',
  displayName: 'Чернігівобленерго',
  region: 'Чернігівська область',
  url: PAGE_URL,
  fetch: (page) => fetchSnapshot(page),
  parse: (raw) => normalizeChernihiv(raw),
};

export default adapter;
export const __test__ = { queueList, targetDates };
