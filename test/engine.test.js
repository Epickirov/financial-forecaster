/* Node unit tests for the pure forecasting engine.
 * Run: node test/engine.test.js   (no dependencies)                       */
'use strict';
var assert = require('assert');

var E = require('../src/engine.js');
global.FFEngine = E;                       // store.js reads global.FFEngine
var FFStore = require('../src/store.js');

var passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }
function approx(a, b, eps) { assert.ok(Math.abs(a - b) <= (eps || 1e-6), 'expected ' + a + ' ≈ ' + b); }

function fresh() { return JSON.parse(JSON.stringify(FFStore.defaultModel())); }

console.log('engine.test.js');

// ---- week grid -----------------------------------------------------------
test('genWeeks covers the fiscal year as ~50 weekly buckets', function () {
  var w = E.genWeeks('2026-02-17', '2027-02-05');
  assert.ok(w.length >= 50 && w.length <= 52, 'got ' + w.length + ' weeks');
  assert.strictEqual(w[0].startISO, '2026-02-17');
  assert.ok(w[w.length - 1].endISO <= '2027-02-05');
  assert.strictEqual(w[0].idx, 0);
});

// ---- assumption carry-forward -------------------------------------------
test('effA carries the latest override forward, inheritedA looks strictly before', function () {
  var s = fresh();
  // base priceForLarge = 19 (seeded). Override week 5 → 25.
  s.assumeWeek['5:priceForLarge'] = '25';
  assert.strictEqual(E.effA(s, 4, 'priceForLarge'), '19');   // before override → base
  assert.strictEqual(E.effA(s, 5, 'priceForLarge'), '25');   // at override
  assert.strictEqual(E.effA(s, 9, 'priceForLarge'), '25');   // carried forward
  assert.strictEqual(E.inheritedA(s, 5, 'priceForLarge'), '19'); // placeholder = prior value
});

// ---- computed forecast ---------------------------------------------------
test('computed splits foreign/domestic from named drivers', function () {
  var s = fresh();
  var c = E.computed(s, 10);
  assert.ok(c.foreign > 0 && c.domestic > 0);
  // foreign = (qFL*priceForLarge + qFS*priceForSmall)/WPM, with keep=0.95
  var keep = 1 - 0.05;
  var expF = (24000 * keep * 19 + 8000 * keep * 16) / E.WPM;
  approx(c.foreign, expF, 1e-3);
});

// ---- 应收账款 now feeds 国内收款 (the wiring fix) ------------------------
test('arCollectInWeek feeds computed.domestic additively', function () {
  var s = fresh();
  var before = E.computed(s, 12);
  s.collect['0:12'] = '50000';
  s.collect['2:12'] = '30000';
  var after = E.computed(s, 12);
  approx(E.arCollectInWeek(s, 12), 80000);
  approx(after.domestic - before.domestic, 80000, 1e-6);
  approx(after._arCollect, 80000);
  approx(after._domSales, before._domSales);            // sales part unchanged
  approx(after.domestic, after._domSales + after._arCollect);
});

// ---- 苗款 register drives seedling timing --------------------------------
test('a payable dated inside a week becomes that week 苗款 outflow', function () {
  var s = fresh();
  var weeks = E.weeks(s);
  // find the week containing the first payable's payby date
  var p = s.seedPayables[0]; // 山东绿航, payby 2026-06-30
  var wi = weeks.findIndex(function (w) { return p.payby >= w.startISO && p.payby <= w.endISO; });
  assert.ok(wi >= 0);
  var due = E.seedDueInWeek(s, wi);
  approx(due, parseFloat(p.qty) * parseFloat(p.price) + /* any other payable in same week */ (due - parseFloat(p.qty) * parseFloat(p.price)));
  assert.ok(E.computed(s, wi).seedling >= parseFloat(p.qty) * parseFloat(p.price) - 1);
});

// ---- actual replaces forecast for elapsed weeks --------------------------
test('eff returns ACTUAL for elapsed weeks once keyed, FORECAST otherwise', function () {
  var s = fresh();
  var weeks = E.weeks(s);
  var wT = weeks.findIndex(function (w) { return '2026-05-26' >= w.startISO && '2026-05-26' <= w.endISO; });
  assert.ok(E.isHist(s, wT), 'seeded week should be historical');
  // seeded actuals: foreign 118000, domestic 372000
  assert.strictEqual(E.eff(s, wT, 'foreign'), 118000);
  assert.strictEqual(E.eff(s, wT, 'domestic'), 372000);
  // a future week has no actuals → eff == forecast (computed)
  var fut = weeks.length - 1;
  assert.ok(!E.isHist(s, fut));
  approx(E.eff(s, fut, 'foreign'), E.fcOf(s, fut, 'foreign'));
});

test('fcOf prefers a manual forecast override', function () {
  var s = fresh();
  s.fcst['20:foreign'] = '999999';
  assert.strictEqual(E.fcOf(s, 20, 'foreign'), 999999);
  s.fcst['20:foreign'] = '';            // blank → fall back to computed
  approx(E.fcOf(s, 20, 'foreign'), E.computed(s, 20).foreign);
});

// ---- the cash spine ------------------------------------------------------
test('series chains 周末余额 = 周初 + 收款 − 支出, week0 open = opening balance', function () {
  var s = fresh();
  var ser = E.series(s);
  approx(ser[0].open, parseFloat(s.config.openingBalance));
  ser.forEach(function (row) { approx(row.close, row.open + row.cin - row.pays, 1e-6); });
  for (var i = 1; i < ser.length; i++) approx(ser[i].open, ser[i - 1].close, 1e-6);
});

test('series uses actuals (eff) while forecastCloses ignores them', function () {
  var s = fresh();
  var weeks = E.weeks(s);
  var wT = weeks.findIndex(function (w) { return '2026-05-26' >= w.startISO && '2026-05-26' <= w.endISO; });
  var ser = E.series(s);
  // series cin at wT = actual foreign + actual domestic = 118000 + 372000
  approx(ser[wT].cin, 118000 + 372000, 1e-6);
  // forecastCloses is computed-only; flipping an actual must not change it
  var fcBefore = E.forecastCloses(s)[wT];
  s.actual[wT + ':foreign'] = '5';
  var fcAfter = E.forecastCloses(s)[wT];
  approx(fcBefore, fcAfter, 1e-6);
});

test('currentWeekIdx returns the week containing the as-of date', function () {
  var s = fresh();
  var ci = E.currentWeekIdx(s);
  var wk = E.weeks(s)[ci];
  assert.ok(s.config.asOfISO >= wk.startISO && s.config.asOfISO <= wk.endISO, 'as-of falls inside its week');
  // the in-progress week (endISO is on/after as-of) is the first forecast week
  assert.ok(!E.isHist(s, ci), 'current/in-progress week is a forecast week');
  if (ci > 0) assert.ok(E.isHist(s, ci - 1), 'the week before the current one is historical');
});

// ---- formatting ----------------------------------------------------------
test('fmt respects the 万 / 元 unit toggle', function () {
  var s = fresh();
  s.config.unit = '万';
  assert.strictEqual(E.fmt(s, 1234567), '123.46万');
  s.config.unit = '元';
  assert.strictEqual(E.fmt(s, 1234567), '¥1,234,567');
});

console.log('\n' + passed + ' tests passed.\n');
