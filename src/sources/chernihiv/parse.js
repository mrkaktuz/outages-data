/**
 * Normalize the Чернігівобленерго schedule into the shared output schema.
 *
 * Source: the interruptions.energy.cn.ua JSON API. For one queue and one date
 * `POST /api/info_schedule_part {queue, curr_dt}` returns:
 *   { status: "ok",
 *     aData: [ { time_from: "HH:MM", time_to: "HH:MM", queue: <state> }, … ],
 *     aState: { "1": {name,color}, "2": {…}, "3": {…} } }
 * where the per-interval `queue` field is actually a STATE code:
 *   1 — "Не відключається" (power on)        -> no interval
 *   2 — "Розмін черги/підчерги" (transition)  -> possible
 *   3 — "Відключення" (outage)               -> off / planned
 *
 * The adapter collects every queue ("1.1".."6.2") for today and tomorrow into
 * `raw.fact.data[<kyiv-midnight-unix>][label] = aData[]`; here we flatten those
 * intervals onto absolute Kyiv instants, identical in shape to the DTEK output.
 */

import { KIND, OUTAGE_TYPE } from '../../core/schema.js';
import { kyivWallToInstant, kyivDateParts, mergeIntervals, toKyivIso } from '../../core/time.js';

/** State code (the API's misnamed `queue` field) -> interval kind/type, or null for "on". */
function stateToInterval(state) {
  switch (Number(state)) {
    case 3:
      return { kind: KIND.OFF, type: OUTAGE_TYPE.PLANNED };
    case 2:
      return { kind: KIND.POSSIBLE, type: OUTAGE_TYPE.POSSIBLE };
    default:
      return null; // 1 (on) or unknown -> no interval
  }
}

/** "HH:MM" -> minutes from midnight; a trailing "00:00" means end-of-day (1440). */
function toMinutes(value, isEnd) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  let mins = Number(m[1]) * 60 + Number(m[2]);
  if (isEnd && mins === 0) mins = 24 * 60;
  return mins;
}

function groupParts(label) {
  const [group, subgroup = ''] = label.split('.');
  return { group, subgroup };
}

function compareLabels(a, b) {
  const [ag, asg = '0'] = a.split('.');
  const [bg, bsg = '0'] = b.split('.');
  return Number(ag) - Number(bg) || Number(asg) - Number(bsg);
}

/** Resolve a fact timestamp key (Kyiv-midnight unix seconds) to {year,month,day}. */
function resolveDate(key) {
  const numeric = Number(key);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const ms = numeric > 1e12 ? numeric : numeric * 1000;
  return kyivDateParts(new Date(ms));
}

/**
 * @param {{fact: {data: Object}}} raw
 * @returns {{groups: string[], schedules: Object.<string, import('../../core/schema.js').GroupSchedule>}}
 */
export function normalizeChernihiv(raw) {
  const factData = raw && raw.fact && raw.fact.data && typeof raw.fact.data === 'object' ? raw.fact.data : {};

  /** @type {Map<string, Array>} label -> segments */
  const byLabel = new Map();

  for (const [tsKey, queues] of Object.entries(factData)) {
    if (!queues || typeof queues !== 'object') continue;
    const date = resolveDate(tsKey);
    if (!date) continue;

    for (const [label, intervals] of Object.entries(queues)) {
      if (!Array.isArray(intervals)) continue;
      const segments = byLabel.get(label) || [];

      for (const item of intervals) {
        if (!item) continue;
        const mapped = stateToInterval(item.queue);
        if (!mapped) continue;
        const from = toMinutes(item.time_from, false);
        const to = toMinutes(item.time_to, true);
        if (from === null || to === null || to <= from) continue;

        segments.push({
          startMs: kyivWallToInstant(date.year, date.month, date.day, from).getTime(),
          endMs: kyivWallToInstant(date.year, date.month, date.day, to).getTime(),
          kind: mapped.kind,
          type: mapped.type,
          origin: 'fact',
        });
      }

      byLabel.set(label, segments);
    }
  }

  const groups = [...byLabel.keys()].sort(compareLabels);
  const schedules = {};
  for (const label of groups) {
    const { group, subgroup } = groupParts(label);
    const intervals = mergeIntervals(byLabel.get(label)).map((s) => ({
      start: toKyivIso(new Date(s.startMs)),
      end: toKyivIso(new Date(s.endMs)),
      kind: s.kind,
      type: s.type,
      origin: s.origin,
    }));
    schedules[label] = { group, subgroup, name: `Черга ${label}`, intervals };
  }

  return { groups, schedules };
}
