import test from 'node:test';
import assert from 'node:assert/strict';

import { __test__ } from '../src/sources/ztoe/ztoe.js';
import { normalize } from '../src/sources/dtek/normalize.js';
import { kyivDateParts, dateKey } from '../src/core/time.js';

const { parseZtoeHtml } = __test__;

const RED = '#ff3333';
const WHITE = '#ffffff';
const NOW = new Date('2026-06-29T10:00:00+03:00'); // summer -> +03:00
const DATE = '29.06.2026';

/** 48 half-hour cells; indices in `off` are painted red. */
function cells(off) {
  let html = '';
  for (let i = 0; i < 48; i += 1) {
    html += `<td style="background: ${off.has(i) ? RED : WHITE}"><a href="/unhooking-search.php?pidcherga_id=1">&nbsp;</a></td>`;
  }
  return html;
}

function row(label, off) {
  return (
    '<tr>' +
    `<td style="background: white" rowspan="2"><b style="font-size:14pt;">${label.split('.')[0]}</b></td>` +
    `<td style="width:30pt; background: white"><a href="/unhooking-search.php?pidcherga_id=1"><b style="font-size:12pt;color:black;">${label}</b></a></td>` +
    '<td style="width:3pt">&nbsp;</td>' +
    cells(off) +
    '</tr>'
  );
}

function page(rows) {
  return (
    '<html><body>' +
    `<div>Дата оновлення інформації - 22:00 ${DATE}</div>` +
    '<table><tr><th>info</th></tr></table>' +
    `<table><tr><td colspan="50"><b>${DATE}</b></td></tr>${rows}</table>` +
    '</body></html>'
  );
}

test('parseZtoeHtml maps red half-hour cells to DisconSchedule hour codes', () => {
  // Hour 10 fully off (slots 18,19); hour 12 first half off (slot 22).
  const off = new Set([18, 19, 22]);
  const raw = parseZtoeHtml(page(row('1.1', off)), NOW);

  assert.equal(raw.sourceUpdatedAt, '29.06.2026 22:00');
  const ts = Object.keys(raw.fact.data)[0];
  const hours = raw.fact.data[ts]['GPV1.1'];
  assert.equal(hours['10'], 'no');
  assert.equal(hours['12'], 'first');
  assert.equal(hours['1'], 'yes');
  assert.equal(raw.preset.sch_names['GPV1.1'], 'Черга 1.1');
});

test('parsed ztoe snapshot normalizes into dated intervals', () => {
  const off = new Set([18, 19, 22]); // 09:00-10:00 off, 11:00-11:30 off
  const raw = parseZtoeHtml(page(row('1.1', off) + row('1.2', new Set())), NOW);
  const { groups, schedules } = normalize(raw, NOW);

  assert.deepEqual(groups, ['1.1', '1.2']);

  const todayKey = dateKey(kyivDateParts(NOW));
  const today = schedules['1.1'].intervals.filter((i) => i.start.startsWith(todayKey));
  assert.equal(today.length, 2);
  assert.equal(today[0].kind, 'off');
  assert.equal(today[0].type, 'planned');
  assert.match(today[0].start, /T09:00:00\+03:00$/);
  assert.match(today[0].end, /T10:00:00\+03:00$/);
  assert.match(today[1].start, /T11:00:00\+03:00$/);
  assert.match(today[1].end, /T11:30:00\+03:00$/);

  // A queue with no red cells has no intervals but is still listed.
  assert.equal(schedules['1.2'].intervals.length, 0);
  assert.equal(schedules['1.2'].name, 'Черга 1.2');
});

test('parseZtoeHtml yields no dates when the page has no schedule table', () => {
  const raw = parseZtoeHtml('<html><body><table><tr><td>nothing</td></tr></table></body></html>', NOW);
  assert.deepEqual(Object.keys(raw.fact.data), []);
});
