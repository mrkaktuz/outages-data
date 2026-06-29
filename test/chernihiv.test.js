import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeChernihiv } from '../src/sources/chernihiv/parse.js';
import { __test__ } from '../src/sources/chernihiv/chernihiv.js';
import { kyivWallToInstant } from '../src/core/time.js';

const TS = String(Math.floor(kyivWallToInstant(2026, 6, 29, 0).getTime() / 1000));

test('normalizeChernihiv turns API state intervals into dated outage intervals', () => {
  const raw = {
    fact: {
      data: {
        [TS]: {
          '1.1': [
            { time_from: '00:00', time_to: '03:00', queue: 3 }, // off
            { time_from: '03:00', time_to: '04:00', queue: 2 }, // possible
            { time_from: '04:00', time_to: '00:00', queue: 1 }, // on -> skipped
          ],
        },
      },
    },
  };

  const { groups, schedules } = normalizeChernihiv(raw);
  assert.deepEqual(groups, ['1.1']);
  assert.equal(schedules['1.1'].group, '1');
  assert.equal(schedules['1.1'].subgroup, '1');
  assert.equal(schedules['1.1'].name, 'Черга 1.1');

  const intervals = schedules['1.1'].intervals;
  assert.equal(intervals.length, 2);
  assert.equal(intervals[0].kind, 'off');
  assert.equal(intervals[0].type, 'planned');
  assert.equal(intervals[0].origin, 'fact');
  assert.match(intervals[0].start, /T00:00:00\+03:00$/);
  assert.match(intervals[0].end, /T03:00:00\+03:00$/);
  assert.equal(intervals[1].kind, 'possible');
  assert.match(intervals[1].end, /T04:00:00\+03:00$/);
});

test('normalizeChernihiv merges touching off-intervals and treats "00:00" end as 24:00', () => {
  const raw = {
    fact: {
      data: {
        [TS]: {
          '2.2': [
            { time_from: '22:00', time_to: '23:00', queue: 3 },
            { time_from: '23:00', time_to: '00:00', queue: 3 }, // -> 24:00
          ],
        },
      },
    },
  };
  const { schedules } = normalizeChernihiv(raw);
  const intervals = schedules['2.2'].intervals;
  assert.equal(intervals.length, 1);
  assert.match(intervals[0].start, /T22:00:00\+03:00$/);
  assert.match(intervals[0].end, /T00:00:00\+03:00$/); // next-day midnight
});

test('queueList covers 1.1..6.2 with API "g/s" params', () => {
  const list = __test__.queueList();
  assert.equal(list.length, 12);
  assert.deepEqual(list[0], { param: '1/1', label: '1.1' });
  assert.deepEqual(list[11], { param: '6/2', label: '6.2' });
});

test('targetDates returns today and tomorrow as YYYY-MM-DD with midnight ts', () => {
  const dates = __test__.targetDates(new Date('2026-06-29T10:00:00+03:00'));
  assert.equal(dates.length, 2);
  assert.equal(dates[0].str, '2026-06-29');
  assert.equal(dates[1].str, '2026-06-30');
  assert.equal(dates[0].ts, Number(TS));
});
