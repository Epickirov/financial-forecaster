/* Node unit tests for the pure forecasting engine.
 * Run: node test/engine.test.js   (no dependencies)                       */
'use strict';
var assert = require('assert');

var E = require('../src/engine.js');
var FFStore = require('../src/store.js');   // the shipped (blank) model
var demoModel = require('./fixtures.js');   // rich demo data the suite asserts against

var passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }
function approx(a, b, eps) { assert.ok(Math.abs(a - b) <= (eps || 1e-6), 'expected ' + a + ' ≈ ' + b); }

function fresh() { return JSON.parse(JSON.stringify(demoModel())); }

console.log('engine.test.js');

// ---- the shipped app carries structure but ZERO financial data ----------
test('shipped defaultModel keeps names/specs but clears all financial figures', function () {
  var d = FFStore.defaultModel();
  assert.strictEqual(d.config.openingBalance, '', 'opening balance cleared');
  Object.keys(d.assume).forEach(function (k) { assert.strictEqual(d.assume[k], '', 'assume.' + k + ' cleared'); });
  ['sales', 'fcst', 'actual'].forEach(function (m) { assert.deepStrictEqual(d[m], {}, m + ' empty'); });
  assert.deepStrictEqual(d.payables, [], 'payables empty');
  assert.deepStrictEqual(d.arShipments, [], 'arShipments empty');
  d.rents.forEach(function (r) { assert.ok(r.name, 'rent name kept'); assert.strictEqual(r.amount, '', 'rent amount cleared'); });
  d.fixed.forEach(function (r) { assert.ok(r.name, 'fixed name kept'); assert.strictEqual(r.amount, '', 'fixed amount cleared'); });
  d.customers.forEach(function (c) { assert.ok(c.id && c.name, 'customer id + name kept'); assert.strictEqual(c.collectWeek, '', 'collectWeek cleared'); });
  d.shipments.forEach(function (sh) { assert.ok(sh.supplier && sh.spec, 'shipment supplier+spec kept'); assert.strictEqual(sh.qty, '', 'shipment qty cleared'); assert.strictEqual(sh.amount, '', 'shipment amount cleared'); assert.strictEqual(sh.iq, '', 'shipment IQ cleared'); });
});

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
  // foreign = (国外大/小花 + 国外染色/切花) × 当周回款率; keep=0.95, 国外染色/切花=0
  var keep = 1 - 0.05;
  var rate = E.num(s.assume.collectInWeek);
  var expF = (24000 * keep * 19 + 8000 * keep * 16) * rate;
  approx(c.foreign, expF, 1e-3);
});

// ---- 应收账款: shipments → outstanding, collected in a per-customer week ---
test('应收账款 collection feeds computed by channel (国外→foreign, 其余→domestic)', function () {
  var s = fresh();
  var wT = E.weeks(s).findIndex(function (w) { return '2026-05-26' >= w.startISO && '2026-05-26' <= w.endISO; });
  var cw = wT + 2;                          // demo: c1(省内 186000) + c3(国外 515000) collect here
  approx(E.customerOutstanding(s, 'c1'), 186000);   // outstanding = sum of that customer's AR shipments
  var due = E.arDueInWeek(s, cw);
  approx(due.domestic, 186000);
  approx(due.foreign, 515000);
  var c = E.computed(s, cw);
  approx(c._arCollect, 186000);             // 省内/国内 AR → 国内收款
  approx(c._arForeign, 515000);             // 国外 AR → 国外收款
  approx(c.domestic, c._domSales + c._arCollect);
  // moving a customer's collection week shifts the collection
  s.customers[0].collectWeek = '' + (cw + 1);
  approx(E.arDueInWeek(s, cw).domestic, 0);
  approx(E.arDueInWeek(s, cw + 1).domestic, 186000);
});

// ---- 苗/花应付款 register drives 苗款/开花株款 timing; freight → materials --
test('scheduled payables become that week 苗/花 outflow; freight hits materials', function () {
  var s = fresh();
  var wT = E.weeks(s).findIndex(function (w) { return '2026-05-26' >= w.startISO && '2026-05-26' <= w.endISO; });
  approx(E.dueInWeek(s, wT, '苗'), 310065);   // pa1 (sh1), blank amount → full shipment amount
  approx(E.dueInWeek(s, wT, '花'), 40366);    // pa3 (sh3)
  approx(E.computed(s, wT).seedling, 310065); // payables override the assumption baseline
  approx(E.computed(s, wT).flowering, 40366);
  approx(E.freightDueInWeek(s, wT), 1046.6 + 687 + 1432.31, 1e-3);
  approx(E.payOf(s, wT, 'materials') - E.eff(s, wT, 'materials'), E.freightDueInWeek(s, wT), 1e-3);
});

test('payableBuckets groups by 渠道 × time-bucket × 紧急度 and respects splits', function () {
  var s = fresh();
  var b = E.payableBuckets(s, '苗');
  approx(b['国内'].total['三级'], 310065);   // pa1
  approx(b['国内'].total['二级'], 224958);   // pa2
  approx(b['国内']._t.total, 535023);
  s.payables[0].amount = '100000';           // split / partial pay overrides the full amount
  approx(E.payableBuckets(s, '苗')['国内'].total['三级'], 100000);
});

test('销售明细 auto-fills 收款 (国外/国内) when no manual actual is keyed', function () {
  var s = fresh();
  var wT = E.weeks(s).findIndex(function (w) { return '2026-05-26' >= w.startISO && '2026-05-26' <= w.endISO; });
  delete s.actual[wT + ':foreign']; delete s.actual[wT + ':domestic'];   // remove manual overrides
  var r = E.salesReceipts(s, wT);
  approx(r.foreign, 32456 + 102424);          // 国外 grp (fx28 + fx35)
  approx(E.eff(s, wT, 'foreign'), r.foreign); // eff falls back to the sales sum
  approx(E.eff(s, wT, 'domestic'), r.domestic);
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
