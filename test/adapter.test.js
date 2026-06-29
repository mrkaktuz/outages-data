import test from 'node:test';
import assert from 'node:assert/strict';

import { __test__ } from '../src/sources/dtek/adapter.js';

test('extractFromHtml reads inline DisconSchedule literals', () => {
  const html =
    '<script>window.DisconSchedule={};DisconSchedule.preset = {"1.1":{"1":{"9":"no"}}};' +
    'DisconSchedule.fact = {"x":{"day_data":{}}};</script>';
  const out = __test__.extractFromHtml(html);
  assert.ok(out);
  assert.deepEqual(out.preset, { '1.1': { 1: { 9: 'no' } } });
  assert.deepEqual(out.fact, { x: { day_data: {} } });
});

test('sliceBalanced handles nested braces and strings with braces', () => {
  const html = 'DisconSchedule.preset = {"a":{"b":"}{"}} trailing';
  const slice = __test__.sliceBalanced(html, 'DisconSchedule.preset');
  assert.equal(slice, '{"a":{"b":"}{"}}');
});

test('extractFromHtml returns null when preset is missing', () => {
  assert.equal(__test__.extractFromHtml('<html>no data here</html>'), null);
});

test('extractFromHtml captures sourceUpdatedAt from fact.update', () => {
  const html =
    'DisconSchedule.preset = {"data":{"GPV1.1":{}},"updateFact":"29.06.2026 10:23"};' +
    'DisconSchedule.fact = {"update":"29.06.2026 11:04","data":{}};';
  const out = __test__.extractFromHtml(html);
  assert.equal(out.sourceUpdatedAt, '29.06.2026 11:04');
});
