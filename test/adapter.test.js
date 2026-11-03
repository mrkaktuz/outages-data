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

test('looksLikeOverload spots the DTEK "heavy load" page, not the real one', () => {
  const { looksLikeOverload } = __test__;
  const overload =
    '<html><body><p>Шановні клієнти!<br>Сайт працює, але через велике навантаження ' +
    'треба трохи зачекати і сторінка завантажиться.</p>' + 'x'.repeat(4000) + '</body></html>';
  assert.equal(looksLikeOverload(overload), true);
  assert.equal(looksLikeOverload('<html>DisconSchedule.preset = {}; велике навантаження</html>'), false);
  assert.equal(looksLikeOverload('<html><body>Графік відключень</body></html>'), false);
  assert.equal(looksLikeOverload(''), false);
});

/**
 * Minimal fake Playwright page: `script` is the list of states it goes through, one
 * per poll of the live global; the last one repeats. Each state is
 * `{ html, frameHtml?, ready? }`. `waitForTimeout` advances the mocked clock if given.
 */
function fakePage(script, { tick = async () => {} } = {}) {
  let polls = 0;
  const calls = { reload: 0 };
  const state = () => script[Math.min(polls - 1, script.length - 1)];
  const mainFrame = { content: async () => state().html };
  const childFrame = { content: async () => state().frameHtml ?? '<html></html>' };
  return {
    calls,
    goto: async () => {},
    reload: async () => { calls.reload += 1; },
    waitForTimeout: tick,
    locator: () => ({ first: () => ({ click: async () => {} }) }),
    content: async () => state().html,
    mainFrame: () => mainFrame,
    frames: () => (state().frameHtml ? [mainFrame, childFrame] : [mainFrame]),
    evaluate: async () => {
      polls += 1;
      if (!state().ready) return { preset: null, fact: null };
      return { preset: { data: { GPV1: {} }, updateFact: '03.11.2026 21:39' }, fact: null };
    },
  };
}

const repeat = (state, times) => Array.from({ length: times }, () => state);
const READY = { html: '<html>DisconSchedule</html>'.padEnd(5000, 'x'), ready: true };
const INCAPSULA_STUB = { html: '<html><script src="/_Incapsula_Resource?x"></script></html>' };
/** Shape captured live from dtek-krem on 2026-11-03 (ids masked). */
const WAITING_ROOM_SHELL =
  '<html style="height:100%"><head><script src="/_Incapsula_Resource?SWJIYLWA=abc"></script></head>' +
  '<body><iframe id="main-iframe" src="/_Incapsula_Resource?CWUDNSAI=43&amp;xinfo=x&amp;incident_id=x' +
  '&amp;edet=47&amp;cinfo=ffffffff&amp;rpinfo=0&amp;wrid=378&amp;wrcid=378&amp;mth=GET">' +
  'Request unsuccessful.</iframe></body></html>';
const WAITING_ROOM_FRAME =
  '<html><head><title>Кімната очікування</title></head><body>Шановні клієнти! Сайт працює, але через ' +
  'велике навантаження треба трохи зачекати і сторінка завантажиться.</body></html>';

test('looksLikeOverload spots the waiting-room shell, not other Incapsula pages', () => {
  const { looksLikeOverload } = __test__;
  assert.equal(looksLikeOverload(WAITING_ROOM_SHELL), true);
  assert.equal(looksLikeOverload(INCAPSULA_STUB.html), false);
  // The country-block page is an Incapsula iframe too, with edet=15 and no wrid.
  assert.equal(looksLikeOverload('<iframe src="/_Incapsula_Resource?CWUDNSAI=23&amp;edet=15&amp;mth=GET">'), false);
});

test('fetchSnapshot waits on a full-size overload page without reloading it', async () => {
  const room = { html: '<html><body>Сайт працює, але через велике навантаження треба трохи зачекати' + 'x'.repeat(4000) };
  const page = fakePage([...repeat(room, 20), READY]);
  const raw = await __test__.fetchSnapshot(page, 'https://example/ua/shutdowns');
  assert.ok(raw.preset.data.GPV1);
  assert.equal(page.calls.reload, 0);
});

test('fetchSnapshot waits on the iframe waiting room without reloading it', async () => {
  const page = fakePage([...repeat({ html: WAITING_ROOM_SHELL, frameHtml: WAITING_ROOM_FRAME }, 20), READY]);
  const raw = await __test__.fetchSnapshot(page, 'https://example/ua/shutdowns');
  assert.ok(raw.preset.data.GPV1);
  assert.equal(page.calls.reload, 0);
});

test('fetchSnapshot recognises the waiting room by its iframe text alone', async () => {
  const shell = { html: '<html><iframe src="/_Incapsula_Resource?new=1"></iframe></html>', frameHtml: WAITING_ROOM_FRAME };
  const page = fakePage([...repeat(shell, 5), READY]);
  await __test__.fetchSnapshot(page, 'https://example/ua/shutdowns');
  assert.equal(page.calls.reload, 0);
});

test('fetchSnapshot does not reload through the waiting room flashing its own reload', async () => {
  const room = { html: WAITING_ROOM_SHELL, frameHtml: WAITING_ROOM_FRAME };
  const page = fakePage([room, INCAPSULA_STUB, room, { html: '' }, room, INCAPSULA_STUB, READY]);
  await __test__.fetchSnapshot(page, 'https://example/ua/shutdowns');
  assert.equal(page.calls.reload, 0);
});

test('fetchSnapshot gives up on the waiting room after 5 min, reloadless and not retryable', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const started = Date.now();
  const room = { html: WAITING_ROOM_SHELL, frameHtml: WAITING_ROOM_FRAME };
  const page = fakePage([room], { tick: async (ms) => t.mock.timers.tick(ms) });
  await assert.rejects(__test__.fetchSnapshot(page, 'https://example/ua/shutdowns'), (err) => {
    assert.equal(err.code, 'timeout');
    assert.equal(err.retryable, false);
    return true;
  });
  assert.equal(page.calls.reload, 0);
  assert.ok(Date.now() - started >= 300000);
});

test('fetchSnapshot still reloads a stub stuck long after the waiting room let go', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const room = { html: WAITING_ROOM_SHELL, frameHtml: WAITING_ROOM_FRAME };
  const page = fakePage([room, ...repeat(INCAPSULA_STUB, 40), READY], { tick: async (ms) => t.mock.timers.tick(ms) });
  await __test__.fetchSnapshot(page, 'https://example/ua/shutdowns');
  assert.ok(page.calls.reload > 0);
});

test('fetchSnapshot still reloads the small Incapsula stub', async () => {
  const page = fakePage([INCAPSULA_STUB, INCAPSULA_STUB, READY]);
  await __test__.fetchSnapshot(page, 'https://example/ua/shutdowns');
  assert.equal(page.calls.reload, 2);
});

test('fetchSnapshot does not reload a page that moved on during the pause', async () => {
  // Poll 1 sees the stub; by the time the pause ends content() already has the real page.
  let polls = 0;
  const calls = { reload: 0 };
  const stubHtml = INCAPSULA_STUB.html;
  const realHtml = READY.html;
  let contentReads = 0;
  const main = { content: async () => stubHtml };
  const page = {
    goto: async () => {},
    reload: async () => { calls.reload += 1; },
    waitForTimeout: async () => {},
    locator: () => ({ first: () => ({ click: async () => {} }) }),
    content: async () => { contentReads += 1; return contentReads === 1 ? stubHtml : realHtml; },
    mainFrame: () => main,
    frames: () => [main],
    evaluate: async () => {
      polls += 1;
      if (polls < 2) return { preset: null, fact: null };
      return { preset: { data: { GPV1: {} }, updateFact: '03.11.2026 21:39' }, fact: null };
    },
  };
  await __test__.fetchSnapshot(page, 'https://example/ua/shutdowns');
  assert.equal(calls.reload, 0);
});
