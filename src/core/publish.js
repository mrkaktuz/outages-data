/**
 * Build and persist the published documents.
 *
 * On a failed run we keep the last good `groups`/`schedules`/`raw` and only
 * refresh `status` + `updatedAt`, so consumers see stale-but-usable data
 * instead of an empty file.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_VERSION, STATUS } from './schema.js';
import { toKyivIso } from './time.js';

// Matches ANSI SGR sequences (ESC [ … m); ESC is built via char code to keep
// the source free of literal control characters.
const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

/** Strip ANSI codes and collapse whitespace so messages stay JSON-clean. */
function cleanMessage(message) {
  if (!message) return null;
  return String(message).replace(ANSI_RE, '').replace(/\s+/g, ' ').trim();
}

function sourceMeta(adapter) {
  return {
    id: adapter.id,
    name: adapter.displayName,
    region: adapter.region,
    url: adapter.url,
  };
}

/** Stable sha256 over the data-bearing parts of a document. */
export function computeHash({ groups, schedules, raw }) {
  const json = JSON.stringify({ groups, schedules, raw });
  return 'sha256:' + createHash('sha256').update(json).digest('hex');
}

/** Read a previously published JSON file, or null if none/unreadable. */
async function loadJson(outDir, file) {
  try {
    return JSON.parse(await readFile(path.join(outDir, file), 'utf8'));
  } catch {
    return null;
  }
}

/** Read a previously published document, or null if none/unreadable. */
export function loadDocument(outDir, id) {
  return loadJson(outDir, `${id}.json`);
}

/** Read the previously published index, or null. */
export function loadIndex(outDir) {
  return loadJson(outDir, 'index.json');
}

/** How many run-log entries to retain (JSON Lines, newest at the end). */
export const MAX_LOG_ENTRIES = 1000;

/** Append one run entry to log.jsonl, trimming to the most recent entries. */
export async function appendRunLog(outDir, entry, maxEntries = MAX_LOG_ENTRIES) {
  const file = path.join(outDir, 'log.jsonl');
  let lines = [];
  try {
    lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  } catch {
    lines = [];
  }
  lines.push(JSON.stringify(entry));
  if (lines.length > maxEntries) lines = lines.slice(lines.length - maxEntries);
  await mkdir(outDir, { recursive: true });
  await writeFile(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

/** Deep-equal two objects after dropping volatile keys. */
function equalIgnoring(a, b, ignoreKeys) {
  const strip = (obj) => {
    const clone = JSON.parse(JSON.stringify(obj));
    for (const key of ignoreKeys) delete clone[key];
    return JSON.stringify(clone);
  };
  return Boolean(a) && Boolean(b) && strip(a) === strip(b);
}

/**
 * The data-bearing view of a document: the actual schedule plus health. A real
 * change is a change here — NOT a change in the upstream "last updated" label
 * (`status.sourceUpdatedAt`), the run timestamp (`updatedAt`) or the raw snapshot.
 * Some operators (e.g. ztoe) bump their "оновлено" stamp every ~30 min while the
 * grid stays identical; keying off that would spam a pointless update every poll.
 */
function meaningfulView(doc) {
  return JSON.stringify({
    groups: doc.groups,
    schedules: doc.schedules,
    ok: doc.status && doc.status.ok,
    code: doc.status && doc.status.code,
  });
}

/**
 * Avoid churn: if the new document carries the same schedule and health as the
 * previous one, keep the previous one so the file (and git) stays unchanged and
 * no spurious "updated" notification fires.
 */
export function reconcileDocument(candidate, previous) {
  if (previous && meaningfulView(candidate) === meaningfulView(previous)) return previous;
  // Operator data unchanged but the rolling horizon re-dated the schedule (day
  // rollover): publish the fresh dates but keep the previous "last real change"
  // timestamp, so `updatedAt` stays meaningful instead of ticking every midnight.
  if (
    previous &&
    candidate.status.ok &&
    previous.status &&
    previous.status.ok &&
    candidate.status.code === previous.status.code &&
    candidate.status.sourceUpdatedAt != null &&
    candidate.status.sourceUpdatedAt === previous.status.sourceUpdatedAt
  ) {
    return { ...candidate, updatedAt: previous.updatedAt };
  }
  return candidate;
}

/** Same idea for the index, ignoring its generation timestamp. */
export function reconcileIndex(candidate, previous) {
  return equalIgnoring(candidate, previous, ['generatedAt']) ? previous : candidate;
}

/** Document for a successful collection. */
export function buildSuccessDocument(adapter, parsed, raw, now = new Date()) {
  const groups = parsed.groups;
  const schedules = parsed.schedules;
  const rawSnapshot = { preset: raw.preset ?? null, fact: raw.fact ?? null };
  return {
    schemaVersion: SCHEMA_VERSION,
    source: sourceMeta(adapter),
    updatedAt: toKyivIso(now),
    status: {
      ok: true,
      code: STATUS.OK,
      message: null,
      contentHash: computeHash({ groups, schedules, raw: rawSnapshot }),
      sourceUpdatedAt: raw.sourceUpdatedAt ?? null,
    },
    groups,
    schedules,
    raw: rawSnapshot,
  };
}

/** Document for a failed collection — reuses previous data when available. */
export function buildFailureDocument(adapter, previous, code, message, now = new Date()) {
  const groups = previous?.groups ?? [];
  const schedules = previous?.schedules ?? {};
  const raw = previous?.raw ?? { preset: null, fact: null };
  return {
    schemaVersion: SCHEMA_VERSION,
    source: sourceMeta(adapter),
    updatedAt: toKyivIso(now),
    status: {
      ok: false,
      code,
      message: cleanMessage(message),
      contentHash: previous?.status?.contentHash ?? null,
      sourceUpdatedAt: previous?.status?.sourceUpdatedAt ?? null,
    },
    groups,
    schedules,
    raw,
  };
}

const BADGE_COLORS = {
  ok: 'brightgreen',
  waf_blocked: 'orange',
  timeout: 'orange',
  no_data: 'red',
  parse_error: 'red',
};

/**
 * Build a Shields.io "endpoint" badge object for a source. Content is kept
 * stable (no timestamps) so the badge file only changes on a real status/size
 * change, not every run.
 */
export function buildBadge(doc) {
  const code = doc.status.code;
  return {
    schemaVersion: 1,
    label: doc.source.id,
    message: doc.status.ok ? `ok · ${doc.groups.length} груп` : code,
    color: BADGE_COLORS[code] || 'lightgrey',
  };
}

// Hex values for the Shields.io colour names used above.
const BADGE_HEX = {
  brightgreen: '#4c1',
  orange: '#fe7d37',
  red: '#e05d44',
  lightgrey: '#9f9f9f',
};

const escapeXml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Rough Verdana 11px advance widths; textLength in the SVG stretches the text
// to the estimate, so being a pixel off is invisible.
function textWidth(text) {
  let w = 0;
  for (const ch of String(text)) {
    if (/[ ·.,:;!'|iIljt1]/.test(ch)) w += 4;
    else if (/[mwMW@ДЖШЩЮМФ]/.test(ch)) w += 11;
    else w += 7;
  }
  return w;
}

/**
 * Render a flat Shields-style badge as standalone SVG so the README can embed
 * it straight from raw.githubusercontent.com — img.shields.io/endpoint proved
 * unreliable (GitHub rate-limits Shields' shared fetch IPs → "resource not
 * found" even though the JSON is fine).
 */
export function renderBadgeSvg({ label, message, color }) {
  const hex = BADGE_HEX[color] || BADGE_HEX.lightgrey;
  const lw = textWidth(label) + 10;
  const mw = textWidth(message) + 10;
  const w = lw + mw;
  const title = escapeXml(`${label}: ${message}`);
  const text = (str, x, len) =>
    `<text aria-hidden="true" x="${x * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${len * 10}">${str}</text>` +
    `<text x="${x * 10}" y="140" transform="scale(.1)" fill="#fff" textLength="${len * 10}">${str}</text>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${title}">` +
    `<title>${title}</title>` +
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
    `<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)">` +
    `<rect width="${lw}" height="20" fill="#555"/>` +
    `<rect x="${lw}" width="${mw}" height="20" fill="${hex}"/>` +
    `<rect width="${w}" height="20" fill="url(#s)"/>` +
    `</g>` +
    `<g text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">` +
    text(escapeXml(label), lw / 2, lw - 10) +
    text(escapeXml(message), lw + mw / 2, mw - 10) +
    `</g></svg>\n`
  );
}

export async function writeBadge(outDir, doc) {
  const dir = path.join(outDir, 'badges');
  await mkdir(dir, { recursive: true });
  const badge = buildBadge(doc);
  const file = path.join(dir, `${doc.source.id}.json`);
  await writeFile(file, JSON.stringify(badge) + '\n', 'utf8');
  await writeFile(path.join(dir, `${doc.source.id}.svg`), renderBadgeSvg(badge), 'utf8');
  return file;
}

/** Overall "last updated" badge: run time + how many sources are ok. */
export function buildOverallBadge({ stamp, okCount, total }) {
  const allOk = total > 0 && okCount === total;
  return {
    schemaVersion: 1,
    label: 'оновлено',
    message: total ? `${stamp} · ${okCount}/${total} ok` : stamp,
    color: allOk ? 'brightgreen' : okCount > 0 ? 'orange' : 'red',
  };
}

export async function writeOverallBadge(outDir, badge) {
  const dir = path.join(outDir, 'badges');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'status.json');
  await writeFile(file, JSON.stringify(badge) + '\n', 'utf8');
  await writeFile(path.join(dir, 'status.svg'), renderBadgeSvg(badge), 'utf8');
  return file;
}

export async function saveDocument(outDir, doc) {
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `${doc.source.id}.json`);
  await writeFile(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return file;
}

/** Build the cross-source summary index (pure). */
export function buildIndex(docs, now = new Date()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: toKyivIso(now),
    sources: docs.map((doc) => ({
      id: doc.source.id,
      name: doc.source.name,
      region: doc.source.region,
      updatedAt: doc.updatedAt,
      status: doc.status.code,
      groups: doc.groups,
      file: `${doc.source.id}.json`,
    })),
  };
}

export async function writeIndex(outDir, index) {
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, 'index.json');
  await writeFile(file, JSON.stringify(index, null, 2) + '\n', 'utf8');
  return file;
}
