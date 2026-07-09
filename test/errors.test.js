import test from 'node:test';
import assert from 'node:assert/strict';

import { CollectError, STATUS, toCollectError } from '../src/core/errors.js';

test('toCollectError passes CollectError through unchanged', () => {
  const original = new CollectError(STATUS.WAF_BLOCKED, 'stub');
  assert.equal(toCollectError(original), original);
});

test('toCollectError maps Playwright timeouts to TIMEOUT', () => {
  const goto = new Error('page.goto: Timeout 45000ms exceeded.\nCall log:\n  - navigating to "https://…"');
  assert.equal(toCollectError(goto).code, STATUS.TIMEOUT);

  const named = new Error('whatever');
  named.name = 'TimeoutError';
  assert.equal(toCollectError(named).code, STATUS.TIMEOUT);
});

test('toCollectError maps other errors to PARSE_ERROR', () => {
  const err = toCollectError(new TypeError('x is not a function'));
  assert.equal(err.code, STATUS.PARSE_ERROR);
  assert.match(err.message, /not a function/);
});
