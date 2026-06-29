/**
 * Parse the Житомиробленерго (ZTOE) outage page into a `DisconSchedule`-shaped
 * snapshot, so it can reuse the very same normalizer as the DTEK sources.
 *
 * The page https://www.ztoe.com.ua/unhooking-search.php renders, per published
 * date, an HTML table whose rows are the queues 1.1..6.2 and whose 48 cells are
 * the half-hour slots 00:00..24:00. A red cell means power is off in that slot,
 * white means on. There is no weekly template — only concrete dates (today and,
 * once published, tomorrow) — so everything is emitted under `fact.data`,
 * keyed by the Kyiv-midnight unix timestamp of each date, exactly like DTEK's
 * `fact` branch. Hour codes use the same vocabulary the normalizer understands:
 * `no` (both half-hours off), `first`/`second` (one half off) and `yes` (on).
 */

import { kyivWallToInstant, kyivDateParts } from '../../core/time.js';

/** Red blackout cell: high red channel, low green/blue (handles #ff0000, #ff3333…). */
function isBlackout(hex) {
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return false;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return r > 200 && g < 80 && b < 80;
}

/** Collapse 48 half-hour off-flags into 24 hourly DisconSchedule codes. */
function halvesToHours(off) {
  const hours = {};
  for (let h = 1; h <= 24; h += 1) {
    const a = off[(h - 1) * 2];
    const b = off[(h - 1) * 2 + 1];
    let code;
    if (a && b) code = 'no';
    else if (a) code = 'first';
    else if (b) code = 'second';
    else code = 'yes';
    hours[String(h)] = code;
  }
  return hours;
}

/** Kyiv-midnight unix-seconds key for a date (matches normalize's resolveFactDate). */
function dateTimestamp(year, month, day) {
  return Math.floor(kyivWallToInstant(year, month, day, 0).getTime() / 1000);
}

/** Parse one `<table>` block: its date header + the 12 queue rows. */
function parseTableBlock(block) {
  const dateMatch = block.match(/<b[^>]*>\s*(\d{2})\.(\d{2})\.(\d{4})\s*<\/b>/i);
  if (!dateMatch) return null;
  const day = +dateMatch[1];
  const month = +dateMatch[2];
  const year = +dateMatch[3];

  const groups = {};
  const rows = block.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const label = row.match(/pidcherga_id=\d+[^>]*>\s*<b[^>]*>\s*(\d+\.\d+)\s*<\/b>/i);
    if (!label) continue;
    const hexes = [...row.matchAll(/background:\s*#([0-9a-fA-F]{6})/gi)].map((m) => m[1]);
    if (hexes.length < 48) continue;
    // Decorative leading cells, if any, are not coloured; keep the 48 slot cells.
    const slots = hexes.slice(-48).map(isBlackout);
    groups[`GPV${label[1]}`] = halvesToHours(slots);
  }

  if (Object.keys(groups).length === 0) return null;
  return { ts: dateTimestamp(year, month, day), groups };
}

/**
 * @param {string} html  Full page HTML (already decoded to UTF-8 by the browser).
 * @param {Date} [now]   Injectable clock for deterministic tests.
 * @returns {import('../../core/schema.js').RawSnapshot & {preset: object, fact: object}}
 */
export function parseZtoeHtml(html, now = new Date()) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  const data = {};
  for (const table of tables) {
    if (!/pidcherga_id/i.test(table)) continue;
    const parsed = parseTableBlock(table);
    if (parsed) data[String(parsed.ts)] = parsed.groups;
  }

  const upd = html.match(/оновлен[^<]*?(\d{2}):(\d{2})\s+(\d{2})\.(\d{2})\.(\d{4})/i);
  const update = upd ? `${upd[3]}.${upd[4]}.${upd[5]} ${upd[1]}:${upd[2]}` : null;

  const today = kyivDateParts(now);

  // Synthesize human labels ("GPV1.1" -> "Черга 1.1") so schedules carry names.
  const schNames = {};
  for (const groups of Object.values(data)) {
    for (const key of Object.keys(groups)) schNames[key] = `Черга ${key.replace(/^GPV/, '')}`;
  }

  return {
    preset: { data: {}, sch_names: schNames },
    fact: { data, update, today: dateTimestamp(today.year, today.month, today.day) },
    sourceUpdatedAt: update,
  };
}
