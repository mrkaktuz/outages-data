/**
 * Time helpers around the Europe/Kyiv wall clock.
 *
 * The upstream schedules are expressed in local Kyiv time (weekday + hour
 * slots). We convert them to absolute instants and emit ISO 8601 strings that
 * carry the correct offset, including across DST boundaries, using only the
 * built-in Intl machinery (no external dependencies).
 */

export const ZONE = 'Europe/Kyiv';

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Offset of the zone, in minutes, at the given absolute instant. */
export function zoneOffsetMinutes(instant) {
  const p = partsFormatter.formatToParts(instant).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/**
 * Convert a Kyiv wall-clock moment into the matching absolute instant.
 * Minutes may exceed 24h (e.g. hour slot 24 -> next-day midnight).
 *
 * @param {number} year
 * @param {number} month  1-12
 * @param {number} day
 * @param {number} minutesFromMidnight
 * @returns {Date}
 */
export function kyivWallToInstant(year, month, day, minutesFromMidnight) {
  const wallAsUtc = Date.UTC(year, month - 1, day, 0, 0) + minutesFromMidnight * 60000;
  let offset = zoneOffsetMinutes(new Date(wallAsUtc));
  let instant = wallAsUtc - offset * 60000;
  // Re-check once: the first guess can land on the wrong side of a DST switch.
  const corrected = zoneOffsetMinutes(new Date(instant));
  if (corrected !== offset) instant = wallAsUtc - corrected * 60000;
  return new Date(instant);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Format an absolute instant as ISO 8601 in the Kyiv offset. */
export function toKyivIso(instant) {
  const offset = zoneOffsetMinutes(instant);
  const local = new Date(instant.getTime() + offset * 60000);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** Calendar date (in Kyiv) of an instant, as {year, month, day}. */
export function kyivDateParts(instant) {
  const p = partsFormatter.formatToParts(instant).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return { year: +p.year, month: +p.month, day: +p.day };
}

/** ISO weekday 1..7 (Mon..Sun) for a {year, month, day} in Kyiv. */
export function isoWeekday({ year, month, day }) {
  const jsDow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun
  return jsDow === 0 ? 7 : jsDow;
}

/** Today's Kyiv date plus `offsetDays`, as {year, month, day}. */
export function kyivDateOffset(offsetDays, now = new Date()) {
  const today = kyivDateParts(now);
  const base = Date.UTC(today.year, today.month - 1, today.day);
  return kyivDateParts(new Date(base + offsetDays * 86400000));
}

/** `YYYY-MM-DD` key for a {year, month, day}. */
export function dateKey({ year, month, day }) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Merge time-ordered intervals that touch and share kind+type.
 * Each interval is {startMs, endMs, kind, type, origin}; returns the same shape.
 */
export function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const out = [];
  for (const cur of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.endMs >= cur.startMs && prev.kind === cur.kind && prev.type === cur.type) {
      prev.endMs = Math.max(prev.endMs, cur.endMs);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}
