import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { appendRunLog } from '../src/core/publish.js';

test('appendRunLog appends JSON Lines and trims to the cap', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dtek-log-'));
  try {
    for (let i = 0; i < 5; i++) {
      await appendRunLog(dir, { runAt: `t${i}`, ok: true }, 3);
    }
    const lines = (await readFile(path.join(dir, 'log.jsonl'), 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 3); // capped
    assert.deepEqual(
      lines.map((l) => JSON.parse(l).runAt),
      ['t2', 't3', 't4'], // newest kept, oldest dropped
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
