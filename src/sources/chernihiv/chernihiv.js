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

  const queues = queueList();
  const dates = targetDates();

  const collected = await page.evaluate(
    async ({ apiPath, queues, dateStrs }) => {
      const out = {};
      let aState = null;
      for (const dt of dateStrs) {
        out[dt] = {};
        const responses = await Promise.all(
          queues.map(async (q) => {
            try {
              const res = await fetch(apiPath, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: '*/*' },
                body: JSON.stringify({ queue: q.param, curr_dt: dt }),
              });
              if (!res.ok) return { label: q.label, json: null };
              return { label: q.label, json: await res.json() };
            } catch {
              return { label: q.label, json: null };
            }
          }),
        );
        for (const { label, json } of responses) {
          if (!json || !Array.isArray(json.aData)) continue;
          out[dt][label] = json.aData;
          if (!aState && json.aState) aState = json.aState;
        }
      }
      return { out, aState };
    },
    { apiPath: API_PATH, queues, dateStrs: dates.map((d) => d.str) },
  );

  const data = {};
  let total = 0;
  for (const date of dates) {
    const perQueue = collected.out[date.str] || {};
    const labels = Object.keys(perQueue);
    if (labels.length === 0) continue;
    data[String(date.ts)] = perQueue;
    total += labels.length;
  }

  if (total === 0) {
    throw new CollectError(STATUS.NO_DATA, 'Chernihiv API returned no schedule for any queue');
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
