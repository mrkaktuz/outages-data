import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appendRunLog, shouldLogRun } from '../src/core/publish.js';

const readLines = async (dir) =>
  (await readFile(path.join(dir, 'log.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);

const withTempDir = async (fn) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'outages-log-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

// t=0 plus the given number of minutes, as an ISO timestamp.
const at = (minutes) => new Date(Date.UTC(2026, 8, 10, 0, minutes)).toISOString();

test('appendRunLog appends JSON Lines and trims to the cap', async () => {
  await withTempDir(async (dir) => {
    for (let i = 0; i < 5; i++) {
      // changed:true so every entry is newsworthy and none is skipped
      await appendRunLog(dir, { runAt: at(i), ok: true, changed: true }, { maxEntries: 3 });
    }
    const entries = await readLines(dir);
    assert.equal(entries.length, 3); // capped
    assert.deepEqual(
      entries.map((e) => e.runAt),
      [at(2), at(3), at(4)], // newest kept, oldest dropped
    );
  });
});

test('shouldLogRun always logs runs that changed data or failed', () => {
  const last = { runAt: at(0), ok: true, changed: false };
  assert.equal(shouldLogRun({ runAt: at(1), ok: true, changed: true }, last), true);
  assert.equal(shouldLogRun({ runAt: at(1), ok: false, changed: false }, last), true);
});

test('shouldLogRun skips uneventful runs until the hour turns over', () => {
  const last = { runAt: at(0), ok: true, changed: false }; // 00:00
  const quiet = (minutes) => ({ runAt: at(minutes), ok: true, changed: false });

  assert.equal(shouldLogRun(quiet(5), last), false, 'same hour: skip');
  assert.equal(shouldLogRun(quiet(59), last), false, 'still the same hour: skip');
  assert.equal(shouldLogRun(quiet(60), last), true, 'new hour: heartbeat');
  assert.equal(shouldLogRun(quiet(180), last), true, 'hours later: heartbeat');
});

test('shouldLogRun heartbeat lands on the hour boundary, not an hour after the entry', () => {
  // Entry at 00:45; the next hour starts 15 min later, and that is when the
  // status badge changes too — so both write in the same run, sharing a commit.
  const last = { runAt: at(45), ok: true, changed: false };
  assert.equal(shouldLogRun({ runAt: at(55), ok: true, changed: false }, last), false);
  assert.equal(shouldLogRun({ runAt: at(60), ok: true, changed: false }, last), true);
});

test('shouldLogRun logs when there is no previous entry or a bad timestamp', () => {
  const quiet = { runAt: at(5), ok: true, changed: false };
  assert.equal(shouldLogRun(quiet, null), true, 'first ever run');
  assert.equal(shouldLogRun(quiet, {}), true, 'previous entry without runAt');
  assert.equal(shouldLogRun(quiet, { runAt: 'not-a-date', ok: true }), true, 'unparseable previous');
  assert.equal(shouldLogRun({ runAt: 'nope', ok: true, changed: false }, { runAt: at(0) }), true);
});

test('appendRunLog skips an uneventful run and keeps the file untouched', async () => {
  await withTempDir(async (dir) => {
    const first = await appendRunLog(dir, { runAt: at(0), ok: true, changed: true });
    assert.ok(first, 'a changed run is written');

    const skipped = await appendRunLog(dir, { runAt: at(5), ok: true, changed: false });
    assert.equal(skipped, null, 'quiet run within the heartbeat window returns null');

    const entries = await readLines(dir);
    assert.equal(entries.length, 1, 'nothing appended');
    assert.equal(entries[0].runAt, at(0), 'existing entry left alone');
  });
});

test('appendRunLog records one heartbeat per hour', async () => {
  await withTempDir(async (dir) => {
    await appendRunLog(dir, { runAt: at(0), ok: true, changed: true });
    for (const minutes of [5, 10, 30, 55]) {
      await appendRunLog(dir, { runAt: at(minutes), ok: true, changed: false });
    }
    assert.equal((await readLines(dir)).length, 1, 'quiet runs within the hour are skipped');

    await appendRunLog(dir, { runAt: at(60), ok: true, changed: false });
    const entries = await readLines(dir);
    assert.equal(entries.length, 2, 'heartbeat recorded when the hour turns');
    assert.equal(entries[1].runAt, at(60));
  });
});

test('appendRunLog over a simulated day writes ~1 entry/hour plus real events', async () => {
  await withTempDir(async (dir) => {
    // 288 five-minute polls; every 29th run actually changed something.
    for (let i = 0; i < 288; i++) {
      await appendRunLog(dir, { runAt: at(i * 5), ok: true, changed: i > 0 && i % 29 === 0 });
    }
    const entries = await readLines(dir);
    assert.ok(entries.length <= 40, `expected far fewer than 288 entries, got ${entries.length}`);
    assert.ok(entries.length >= 24, `expected at least hourly heartbeats, got ${entries.length}`);
    assert.equal(entries.filter((e) => e.changed).length, 9, 'every real change is kept');
  });
});

test('appendRunLog logs a failure immediately even inside the quiet window', async () => {
  await withTempDir(async (dir) => {
    await appendRunLog(dir, { runAt: at(0), ok: true, changed: true });
    await appendRunLog(dir, { runAt: at(2), ok: false, changed: false });
    const entries = await readLines(dir);
    assert.equal(entries.length, 2);
    assert.equal(entries[1].ok, false);
  });
});
