/**
 * Translate the DTEK `DisconSchedule` payload into the normalized schema.
 *
 * Upstream shape:
 *   preset[group][dow][hour]            -> weekly template (dow "1".."7", hour "1".."24")
 *   fact[timestamp].day_data[group][hour] -> actual outages for specific dates
 *
 * Hour-slot codes (see docs/SPEC.md):
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

const GROUP_LABEL_RE = /^\d+(\.\d+)?$/;

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

/** Resolve the calendar date a fact entry refers to. */
function resolveFactDate(timestampKey, entry) {
  const candidate = entry && (entry.date || entry.day || entry.dt);
  if (typeof candidate === 'string') {
    const dmy = candidate.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (dmy) return { year: +dmy[3], month: +dmy[2], day: +dmy[1] };
    const ymd = candidate.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (ymd) return { year: +ymd[1], month: +ymd[2], day: +ymd[3] };
  }
  const numeric = Number(timestampKey);
  if (Number.isFinite(numeric) && numeric > 0) {
    const ms = numeric > 1e12 ? numeric : numeric * 1000;
    return kyivDateParts(new Date(ms));
  }
  return null;
}

/** Map a fact entry's type label onto our outage-type vocabulary. */
function resolveFactType(entry) {
  const raw = entry && (entry.type || entry.sub_type || entry.subType || entry.disconType);
  if (typeof raw !== 'string') return null;
  const value = raw.toLowerCase();
  if (value.includes('emerg') || value.includes('аварій')) return OUTAGE_TYPE.EMERGENCY;
  if (value.includes('stab') || value.includes('стабіл')) return OUTAGE_TYPE.STABILIZATION;
  if (value.includes('plan') || value.includes('планов')) return OUTAGE_TYPE.PLANNED;
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
  const preset = raw && typeof raw.preset === 'object' && raw.preset ? raw.preset : {};
  const factRoot = raw && typeof raw.fact === 'object' && raw.fact ? raw.fact : {};

  const factEntries = [];
  for (const [timestampKey, entry] of Object.entries(factRoot)) {
    if (!entry || typeof entry !== 'object') continue;
    const date = resolveFactDate(timestampKey, entry);
    const dayData = entry.day_data || entry.dayData || entry.data;
    if (!date || !dayData || typeof dayData !== 'object') continue;
    factEntries.push({ date, dayData, type: resolveFactType(entry) });
  }

  const groupLabels = new Set(Object.keys(preset));
  for (const fact of factEntries) {
    for (const label of Object.keys(fact.dayData)) groupLabels.add(label);
  }

  const horizon = [];
  for (let offset = 0; offset < HORIZON_DAYS; offset++) horizon.push(kyivDateOffset(offset, now));
  const horizonKeys = new Set(horizon.map(dateKey));

  const schedules = {};
  const groups = [];

  for (const label of groupLabels) {
    if (!GROUP_LABEL_RE.test(label)) continue;
    const [group, subgroup = ''] = label.split('.');

    const factByDate = new Map();
    for (const fact of factEntries) {
      const hoursMap = fact.dayData[label];
      if (!hoursMap) continue;
      const key = dateKey(fact.date);
      const segs = buildDaySegments(hoursMap, fact.date, 'fact', fact.type);
      factByDate.set(key, (factByDate.get(key) || []).concat(segs));
    }

    let segments = [];
    for (const date of horizon) {
      const key = dateKey(date);
      if (factByDate.has(key)) {
        segments = segments.concat(factByDate.get(key));
        continue;
      }
      const weekdayMap = preset[label] && preset[label][String(isoWeekday(date))];
      segments = segments.concat(buildDaySegments(weekdayMap, date, 'preset'));
    }
    // Fact dates outside the horizon window (defensive — normally none).
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

    schedules[label] = { group, subgroup, intervals };
    groups.push(label);
  }

  groups.sort(compareGroupLabels);
  const ordered = {};
  for (const label of groups) ordered[label] = schedules[label];

  return { groups, schedules: ordered };
}
