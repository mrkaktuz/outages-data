import test from 'node:test';
import assert from 'node:assert/strict';

import { normalize } from '../src/sources/dtek/normalize.js';
import { kyivDateParts, dateKey } from '../src/core/time.js';

const everyWeekday = (hours) =>
  Object.fromEntries(['1', '2', '3', '4', '5', '6', '7'].map((dow) => [dow, hours]));

const NOW = new Date('2026-06-29T10:00:00+03:00'); // summer -> +03:00
const todayKey = dateKey(kyivDateParts(NOW));
const onToday = (intervals) => intervals.filter((i) => i.start.startsWith(todayKey));

test('preset hour codes become merged intervals', () => {
  const raw = { preset: { '1.1': everyWeekday({ 9: 'no', 10: 'no', 11: 'maybe', 12: 'first' }) }, fact: {} };
  const { groups, schedules } = normalize(raw, NOW);

  assert.deepEqual(groups, ['1.1']);
  const today = onToday(schedules['1.1'].intervals);
  assert.equal(today.length, 3);

  // hours 9+10 ("no") merge into 08:00-10:00 off/planned
  assert.equal(today[0].kind, 'off');
  assert.equal(today[0].type, 'planned');
  assert.equal(today[0].origin, 'preset');
  assert.match(today[0].start, /T08:00:00\+03:00$/);
  assert.match(today[0].end, /T10:00:00\+03:00$/);

  // hour 11 ("maybe") -> 10:00-11:00 possible
  assert.equal(today[1].kind, 'possible');
  assert.equal(today[1].type, 'possible');
  assert.match(today[1].end, /T11:00:00\+03:00$/);

  // hour 12 ("first") -> 11:00-11:30 off (half hour)
  assert.equal(today[2].kind, 'off');
  assert.match(today[2].start, /T11:00:00\+03:00$/);
  assert.match(today[2].end, /T11:30:00\+03:00$/);
});

test('fact overrides preset for the dates it covers', () => {
  const { day, month, year } = kyivDateParts(NOW);
  const dmy = `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year}`;
  const raw = {
    preset: { '1.1': everyWeekday({ 9: 'no' }) },
    fact: { 1750000000: { date: dmy, type: 'emergency', day_data: { '1.1': { 20: 'no', 21: 'no' } } } },
  };

  const { schedules } = normalize(raw, NOW);
  const today = onToday(schedules['1.1'].intervals);

  assert.equal(today.length, 1);
  assert.equal(today[0].origin, 'fact');
  assert.equal(today[0].type, 'emergency');
  assert.equal(today[0].kind, 'off');
  assert.match(today[0].start, /T19:00:00\+03:00$/);
  assert.match(today[0].end, /T21:00:00\+03:00$/);
});

test('groups are discovered from both preset and fact and sorted', () => {
  const raw = {
    preset: { '2.1': everyWeekday({ 1: 'no' }), '1.2': everyWeekday({ 1: 'no' }) },
    fact: { 1750000000: { date: '01.07.2026', day_data: { '1.1': { 1: 'no' } } } },
  };
  const { groups } = normalize(raw, NOW);
  assert.deepEqual(groups, ['1.1', '1.2', '2.1']);
});

test('unknown / "yes" codes produce no interval', () => {
  const raw = { preset: { '1.1': everyWeekday({ 9: 'yes', 10: 'bogus' }) }, fact: {} };
  const { schedules } = normalize(raw, NOW);
  assert.equal(schedules['1.1'].intervals.length, 0);
});

test('fixture sample parses end-to-end', async () => {
  const { readFile } = await import('node:fs/promises');
  const url = new URL('./fixtures/sample-discon.json', import.meta.url);
  const raw = JSON.parse(await readFile(url, 'utf8'));
  const { groups, schedules } = normalize(raw, new Date('2026-06-29T08:00:00+03:00'));
  assert.deepEqual(groups, ['1.1', '2.1']);
  assert.ok(schedules['1.1'].intervals.length > 0);
});
