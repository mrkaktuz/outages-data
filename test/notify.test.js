import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNotifications, summarizeChange } from '../src/core/notify.js';

const ev = (over) => ({
  name: 'ДТЕК КРЕМ',
  changed: false,
  prevOk: true,
  nowOk: true,
  code: 'ok',
  groups: 12,
  sourceUpdatedAt: '29.06.2026 10:23',
  ...over,
});

test('no messages when nothing changed and all ok', () => {
  assert.deepEqual(buildNotifications([ev(), ev({ name: 'ДТЕК КЕМ' })]), []);
});

test('data change on healthy source -> one silent message', () => {
  const msgs = buildNotifications([ev({ changed: true })]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].silent, true);
  assert.match(msgs[0].text, /Оновлення/);
  assert.match(msgs[0].text, /29\.06\.2026 10:23/);
});

test('ok -> failure is a loud message', () => {
  const msgs = buildNotifications([ev({ changed: true, prevOk: true, nowOk: false, code: 'waf_blocked' })]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].silent, false);
  assert.match(msgs[0].text, /збій.*waf_blocked/s);
});

test('failure -> recovery is a loud message and not duplicated as an update', () => {
  const msgs = buildNotifications([ev({ changed: true, prevOk: false, nowOk: true })]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].silent, false);
  assert.match(msgs[0].text, /відновлено/);
});

test('still-broken source stays quiet (no transition)', () => {
  assert.deepEqual(buildNotifications([ev({ changed: true, prevOk: false, nowOk: false, code: 'timeout' })]), []);
});

test('mixed: failure (loud) + update on another source (silent)', () => {
  const msgs = buildNotifications([
    ev({ name: 'ДТЕК КЕМ', changed: true, prevOk: true, nowOk: false, code: 'timeout' }),
    ev({ name: 'ДТЕК КРЕМ', changed: true, nowOk: true }),
  ]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].silent, false);
  assert.equal(msgs[1].silent, true);
});

test('first-ever run that fails notifies (prevOk null)', () => {
  const msgs = buildNotifications([ev({ prevOk: null, nowOk: false, code: 'waf_blocked', changed: true })]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].silent, false);
});

// --- de-duplication of repeated failures (task: no spam while broken) ---

test('consecutive failing runs are not duplicated', () => {
  // First failure (ok -> fail) is loud, then the source stays broken: silent.
  const first = buildNotifications([ev({ changed: true, prevOk: true, nowOk: false, code: 'timeout' })]);
  assert.equal(first.length, 1);
  const second = buildNotifications([ev({ changed: false, prevOk: false, nowOk: false, code: 'timeout' })]);
  assert.deepEqual(second, []);
  const third = buildNotifications([ev({ changed: true, prevOk: false, nowOk: false, code: 'waf_blocked' })]);
  assert.deepEqual(third, []); // even if the failure code changes, no new alert
});

test('recovery fires after a run of failures even if data is unchanged', () => {
  const msgs = buildNotifications([ev({ changed: false, prevOk: false, nowOk: true })]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].silent, false);
  assert.match(msgs[0].text, /відновлено/);
});

// --- change summary on the update message (task 2) ---

test('update message includes the change summary when present', () => {
  const msgs = buildNotifications([ev({ changed: true, changeSummary: 'змінено 2 черги, +1.5 год відключень' })]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].silent, true);
  assert.match(msgs[0].text, /змінено 2 черги/);
  assert.match(msgs[0].text, /\+1\.5 год відключень/);
});

const doc = (over) => ({
  groups: ['1.1', '1.2'],
  schedules: {
    '1.1': { intervals: [{ start: '2026-06-29T00:00:00+03:00', end: '2026-06-29T03:00:00+03:00', kind: 'off' }] },
    '1.2': { intervals: [] },
  },
  ...over,
});

test('summarizeChange reports first collection when no previous doc', () => {
  assert.equal(summarizeChange(null, doc()), 'перший збір: 2 черги');
});

test('summarizeChange reports changed queues and net off-hours delta', () => {
  const previous = doc();
  const current = doc({
    schedules: {
      '1.1': { intervals: [{ start: '2026-06-29T00:00:00+03:00', end: '2026-06-29T05:00:00+03:00', kind: 'off' }] },
      '1.2': { intervals: [] },
    },
  });
  // 1.1 grew from 3h to 5h off -> +2 hours, one queue changed.
  assert.equal(summarizeChange(previous, current), 'змінено 1 черга, +2 год відключень');
});

test('summarizeChange reports added and removed queues', () => {
  const previous = doc();
  const current = doc({ groups: ['1.1', '2.1'], schedules: { '1.1': doc().schedules['1.1'], '2.1': { intervals: [] } } });
  const out = summarizeChange(previous, current);
  assert.match(out, /нові: 2\.1/);
  assert.match(out, /прибрано: 1\.2/);
});

test('summarizeChange returns empty string when nothing material changed', () => {
  assert.equal(summarizeChange(doc(), doc()), '');
});
