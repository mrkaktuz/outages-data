import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNotifications } from '../src/core/notify.js';

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
