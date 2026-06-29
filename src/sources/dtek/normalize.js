/**
 * Translate the DTEK `DisconSchedule` payload into the normalized schema.
 *
 * Upstream shape (confirmed against live data):
 *   preset.data[groupKey][dow][hour]   -> weekly template
 *   fact.data[unixSeconds][groupKey][hour] -> actual outages for specific dates
 *   preset.sch_names[groupKey]         -> human label ("Черга 1.1")
 *   fact.update                        -> "DD.MM.YYYY HH:mm" upstream timestamp
 * where groupKey looks like "GPV1.1", dow is "1".."7", hour is "1".."24".
 *
 * Hour-slot codes (preset.time_type, see docs/SPEC.md):
 *   yes      -> power on (no interval)
 *   no       -> full-hour outage
 *   maybe    -> full-hour possible outage
 *   first    -> outage in first half-hour
 *   second   -> outage in second half-hour
 *   mfirst   -> possible outage in first half-hour
 *   msecond  -> possible outage in second half-hour
 *
 * The weekly preset is expanded onto concrete dates over a rolling horizon;
 * fact entries override the preset for the dates they cover.
 */

import { KIND, OUTAGE_TYPE } from '../../core/schema.js';
import {
  kyivWallToInstant,
  kyivDateOffset,
  kyivDateParts,
  isoWeekday,
  dateKey,
  mergeIntervals,
  toKyivIso,
} from '../../core/time.js';

export const HORIZON_DAYS = 7;

const HOUR_SEGMENTS = {
  no: [{ from: 0, to: 60, kind: KIND.OFF }],
  maybe: [{ from: 0, to: 60, kind: KIND.POSSIBLE }],
  first: [{ from: 0, to: 30, kind: KIND.OFF }],
  second: [{ from: 30, to: 60, kind: KIND.OFF }],
  mfirst: [{ from: 0, to: 30, kind: KIND.POSSIBLE }],
  msecond: [{ from: 30, to: 60, kind: KIND.POSSIBLE }],
};

/** Pull the "1.1" label out of a "GPV1.1" group key. */
function groupLabel(key) {
  const match = String(key).match(/(\d+(?:\.\d+)?)\s*$/);
  return match ? match[1] : null;
}

function defaultType(kind) {
  return kind === KIND.OFF ? OUTAGE_TYPE.PLANNED : OUTAGE_TYPE.POSSIBLE;
}

/** Build outage segments for one day from an hour->code map. */
function buildDaySegments(hoursMap, date, origin, explicitType) {
  if (!hoursMap || typeof hoursMap !== 'object') return [];
  const segments = [];
  for (const [hourKey, code] of Object.entries(hoursMap)) {
    const hour = Number(hourKey);
    if (!Number.isInteger(hour) || hour < 1 || hour > 24) continue;
    const pieces = HOUR_SEGMENTS[code];
    if (!pieces) continue; // "yes" or unknown -> skip
    const base = (hour - 1) * 60;
    for (const piece of pieces) {
      segments.push({
        startMs: kyivWallToInstant(date.year, date.month, date.day, base + piece.from).getTime(),
        endMs: kyivWallToInstant(date.year, date.month, date.day, base + piece.to).getTime(),
        kind: piece.kind,
        type: explicitType || defaultType(piece.kind),
        origin,
      });
    }
  }
  return segments;
}

/** Resolve the calendar date for a fact timestamp key (unix seconds). */
function resolveFactDate(timestampKey) {
  const numeric = Number(timestampKey);
  if (Number.isFinite(numeric) && numeric > 0) {
    const ms = numeric > 1e12 ? numeric : numeric * 1000;
    return kyivDateParts(new Date(ms));
  }
  const dmy = String(timestampKey).match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (dmy) return { year: +dmy[3], month: +dmy[2], day: +dmy[1] };
  return null;
}

function compareGroupLabels(a, b) {
  const [ag, asg = '0'] = a.split('.');
  const [bg, bsg = '0'] = b.split('.');
  return Number(ag) - Number(bg) || Number(asg) - Number(bsg);
}

/**
 * @param {{preset: unknown, fact: unknown}} raw
 * @param {Date} [now]  Injectable clock for deterministic tests.
 * @returns {{groups: string[], schedules: Object.<string, import('../../core/schema.js').GroupSchedule>}}
 */
export function normalize(raw, now = new Date()) {
  const presetData =
    raw && raw.preset && typeof raw.preset.data === 'object' && raw.preset.data ? raw.preset.data : {};
  const schNames = (raw && raw.preset && raw.preset.sch_names) || {};
  const factData =
    raw && raw.fact && typeof raw.fact.data === 'object' && raw.fact.data ? raw.fact.data : {};

  const factEntries = [];
  for (const [timestampKey, groupMap] of Object.entries(factData)) {
    if (!groupMap || typeof groupMap !== 'object') continue;
    const date = resolveFactDate(timestampKey);
    if (date) factEntries.push({ date, groupMap });
  }

  const rawGroupKeys = new Set(Object.keys(presetData));
  for (const fact of factEntries) {
    for (const key of Object.keys(fact.groupMap)) rawGroupKeys.add(key);
  }

  const horizon = [];
  for (let offset = 0; offset < HORIZON_DAYS; offset++) horizon.push(kyivDateOffset(offset, now));
  const horizonKeys = new Set(horizon.map(dateKey));

  const byLabel = new Map();
  for (const rawKey of rawGroupKeys) {
    const label = groupLabel(rawKey);
    if (!label) continue;
    const [group, subgroup = ''] = label.split('.');

    const factByDate = new Map();
    for (const fact of factEntries) {
      const hoursMap = fact.groupMap[rawKey];
      if (!hoursMap) continue;
      const key = dateKey(fact.date);
      const segs = buildDaySegments(hoursMap, fact.date, 'fact', null);
      factByDate.set(key, (factByDate.get(key) || []).concat(segs));
    }

    let segments = [];
    for (const date of horizon) {
      const key = dateKey(date);
      if (factByDate.has(key)) {
        segments = segments.concat(factByDate.get(key));
        continue;
      }
      const weekdayMap = presetData[rawKey] && presetData[rawKey][String(isoWeekday(date))];
      segments = segments.concat(buildDaySegments(weekdayMap, date, 'preset'));
    }
    for (const [key, segs] of factByDate) {
      if (!horizonKeys.has(key)) segments = segments.concat(segs);
    }

    const intervals = mergeIntervals(segments).map((s) => ({
      start: toKyivIso(new Date(s.startMs)),
      end: toKyivIso(new Date(s.endMs)),
      kind: s.kind,
      type: s.type,
      origin: s.origin,
    }));

    byLabel.set(label, {
      group,
      subgroup,
      name: schNames[rawKey] || null,
      intervals,
    });
  }

  const groups = [...byLabel.keys()].sort(compareGroupLabels);
  const schedules = {};
  for (const label of groups) schedules[label] = byLabel.get(label);

  return { groups, schedules };
}
