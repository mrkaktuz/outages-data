import test from 'node:test';
import assert from 'node:assert/strict';

import { toKyivIso, kyivWallToInstant, mergeIntervals, isoWeekday } from '../src/core/time.js';

test('Kyiv offset follows DST', () => {
  assert.match(toKyivIso(kyivWallToInstant(2026, 7, 1, 0)), /\+03:00$/); // summer
  assert.match(toKyivIso(kyivWallToInstant(2026, 1, 1, 0)), /\+02:00$/); // winter
});

test('wall-to-instant round-trips to the same wall time', () => {
  const iso = toKyivIso(kyivWallToInstant(2026, 6, 29, 8 * 60 + 30));
  assert.match(iso, /^2026-06-29T08:30:00\+03:00$/);
});

test('hour slot 24 rolls into next-day midnight', () => {
  const iso = toKyivIso(kyivWallToInstant(2026, 6, 29, 24 * 60));
  assert.match(iso, /^2026-06-30T00:00:00\+03:00$/);
});

test('mergeIntervals joins touching same-kind ranges', () => {
  const merged = mergeIntervals([
    { startMs: 0, endMs: 60, kind: 'off', type: 'planned' },
    { startMs: 60, endMs: 120, kind: 'off', type: 'planned' },
    { startMs: 120, endMs: 180, kind: 'possible', type: 'possible' },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual([merged[0].startMs, merged[0].endMs], [0, 120]);
});

test('isoWeekday returns 1..7 Mon..Sun', () => {
  assert.equal(isoWeekday({ year: 2026, month: 6, day: 29 }), 1); // Monday
  assert.equal(isoWeekday({ year: 2026, month: 6, day: 28 }), 7); // Sunday
});
