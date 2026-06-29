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

/** Read a previously published document, or null if none/unreadable. */
export async function loadDocument(outDir, id) {
  try {
    const text = await readFile(path.join(outDir, `${id}.json`), 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
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

export async function saveDocument(outDir, doc) {
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `${doc.source.id}.json`);
  await writeFile(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return file;
}

/** Write the cross-source summary index. */
export async function saveIndex(outDir, docs, now = new Date()) {
  const index = {
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
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, 'index.json');
  await writeFile(file, JSON.stringify(index, null, 2) + '\n', 'utf8');
  return file;
}
