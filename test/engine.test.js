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

test('genWeeks startISO is consistent with its label (no UTC/local drift)', function () {
  E.genWeeks('2026-02-17', '2027-02-05').forEach(function (x) {
    var d = x.startISO.split('-');                       // YYYY-MM-DD
    assert.strictEqual(x.label.split('–')[0], (+d[1]) + '.' + (+d[2]), 'label start matches startISO for ' + x.startISO);
  });
});

test('genWeeks is timezone-independent — Beijing (UTC+8) sees the same calendar weeks', function () {
  var cp = require('child_process'), path = require('path');
  var script = 'var E=require(' + JSON.stringify(path.resolve(__dirname, '../src/engine.js')) +
    ');var w=E.genWeeks("2026-02-17","2027-02-05");process.stdout.write(w[0].startISO+"|"+w[0].label);';
  var out = cp.execFileSync(process.execPath, ['-e', script], { env: Object.assign({}, process.env, { TZ: 'Asia/Shanghai' }) }).toString().split('|');
  assert.strictEqual(out[0], '2026-02-17', 'week 0 startISO unaffected by Asia/Shanghai timezone');
  assert.strictEqual(out[1].split('–')[0], '2.17', 'label matches startISO under Asia/Shanghai');
});

// ---- 今日/截至 tracks the real (China) date unless pinned --------------------
test('asOfISO defaults to China today, refreshes on load, and pins once edited', function () {
  var today = FFStore.todayISO();
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(today), 'todayISO is a valid YYYY-MM-DD');
  var d = FFStore.defaultModel();
  assert.strictEqual(d.config.asOfISO, today, 'fresh model as-of = China today');
  assert.strictEqual(d.config.asOfManual, false, 'fresh model is not pinned');
  // a saved (unpinned) workspace with a stale as-of refreshes to today on load
  var noop = function () {};
  var adapter = { load: function () { return { config: { asOfISO: '2020-01-01' } }; }, save: noop, clear: noop };
  var s1 = new FFStore.Store(adapter);
  assert.strictEqual(s1.state.config.asOfISO, today, 'unpinned stale as-of refreshes to today');
  // editing 截至 pins it; a pinned value is preserved on load
  s1.editConfig('asOfISO', '2026-03-15');
  assert.strictEqual(s1.state.config.asOfManual, true, 'editing 截至 pins it');
  var adapter2 = { load: function () { return { config: { asOfISO: '2026-03-15', asOfManual: true } }; }, save: noop, clear: noop };
  assert.strictEqual(new FFStore.Store(adapter2).state.config.asOfISO, '2026-03-15', 'pinned as-of preserved on load');
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

// ---- 应收账款: per-shipment collection = 出货周 + 分类账期 ------------------
test('应收账款: per-shipment collection week = 出货周 + 分类账期 (国外→foreign, 其余→domestic)', function () {
  var s = fresh();
  // demo: ar1 c1省内 186000 @2026-05-20 (wk13), ar2 c3国外 515000 @2026-05-18 (wk12),
  //       ar3 c2省内 240000 @2026-05-25 (wk13). default 账期: 省内=2, 国外=4.
  assert.strictEqual(E.arCollectWeek(s, s.arShipments[0]), 15); // ar1: 13 + 2
  assert.strictEqual(E.arCollectWeek(s, s.arShipments[1]), 16); // ar2: 12 + 4
  assert.strictEqual(E.arCollectWeek(s, s.arShipments[2]), 15); // ar3: 13 + 2
  approx(E.customerOutstanding(s, 'c1'), 186000);   // outstanding = sum of that customer's AR shipments
  var d15 = E.arDueInWeek(s, 15), d16 = E.arDueInWeek(s, 16);
  approx(d15.domestic, 186000 + 240000);    // ar1 + ar3 (省内 → 国内收款)
  approx(d15.foreign, 0);
  approx(d16.foreign, 515000);              // ar2 (国外 → 国外收款)
  approx(d16.domestic, 0);
  // these still feed computed's per-channel breakdown helpers
  var c = E.computed(s, 16);
  approx(c._arForeign, 515000);
});

test('应收账款: per-shipment override beats date+lag; editable 账期 shifts timing', function () {
  var s = fresh();
  s.arShipments[0].collectWeek = '20';                          // explicit override
  assert.strictEqual(E.arCollectWeek(s, s.arShipments[0]), 20);
  approx(E.arDueInWeek(s, 20).domestic, 186000);
  approx(E.arDueInWeek(s, 15).domestic, 240000);                // only ar3 remains in wk15
  var s2 = fresh();
  s2.assume.lagProvIn = '5';                                    // 省内 账期 2 → 5 weeks
  assert.strictEqual(E.arCollectWeek(s2, s2.arShipments[2]), 18); // ar3: 13 + 5
  approx(E.arDueInWeek(s2, 18).domestic, 186000 + 240000);
  approx(E.arDueInWeek(s2, 15).domestic, 0);
});

test('应收账款: falls back to per-customer 回款周 when shipment has no date/override', function () {
  var s = fresh();
  s.arShipments[0].date = ''; s.arShipments[0].collectWeek = '';  // neither date nor override
  var cw = parseInt(s.customers[0].collectWeek, 10);              // c1.collectWeek = wTarget+2 = 16
  assert.strictEqual(E.arCollectWeek(s, s.arShipments[0]), cw);
  approx(E.arDueInWeek(s, cw).domestic, 186000);
});

// ---- never-sum: FD (forecast) and AR (booked) are parallel, never combined --
test('computed.foreign/domestic are FD-only; AR is a parallel band, not summed in', function () {
  var s = fresh();
  var c = E.computed(s, 16);                       // ar2 (国外 515000) collects wk16
  approx(c.foreign, c._foreignSales);              // foreign = forecast sales collection ONLY
  approx(c.domestic, c._domSales);
  approx(c._arForeign, 515000);                    // AR is exposed separately as its own band
  assert.ok(Math.abs(c.foreign - (c._foreignSales + c._arForeign)) > 1, 'foreign excludes the AR band');
});

// ---- the committed (booked-AR) projection line ---------------------------
test('committedCloses branches from the actual balance and projects on booked AR only, then stops', function () {
  var s = fresh();
  var cc = E.committedCloses(s), ser = E.series(s), cw = E.currentWeekIdx(s);  // cw = 16
  approx(cc[cw - 1], ser[cw - 1].close);           // branches from the last settled week's actual balance
  assert.ok(cc[cw] != null, 'committed line defined through the AR horizon (wk16)');
  assert.strictEqual(cc[cw + 1], null, 'committed line stops once bookings run out');
  // wk16 step adds ONLY booked AR (515000), not forecast sales, and rolls in 逾期应付 + 逾期运费
  var pays = E.PAYCATS.reduce(function (a, p) { return a + E.fcPayOf(s, cw, p); }, 0);
  approx(cc[cw], cc[cw - 1] + 515000 - pays - E.overduePayables(s) - E.overdueFreight(s));
});

// ---- 瓶苗 type, 总金额/已付/未付 totals, 逾期运费 -----------------------------
test('瓶苗 payable feeds the bottle cash line; 已付/未付 totals + 逾期运费 behave', function () {
  var s = fresh();
  // freight totals — demo freight all unpaid (sh1/sh2/sh3 @wk14, cw=16 → all overdue)
  var ft = E.freightTotals(s);
  approx(ft.total, 1046.6 + 687 + 1432.31, 1e-3); approx(ft.paid, 0); approx(ft.unpaid, ft.total, 1e-3);
  approx(E.overdueFreight(s), 1046.6 + 687 + 1432.31, 1e-3);
  s.shipments[0].freightPaid = true;                       // mark sh1 freight 已付
  approx(E.freightTotals(s).paid, 1046.6, 1e-3);
  approx(E.overdueFreight(s), 687 + 1432.31, 1e-3);        // sh1 leaves 逾期运费
  approx(E.freightDueInWeek(s, 14), 687 + 1432.31, 1e-3);  // and leaves the week's due total
  // payable totals (苗: pa1 + pa2, both unpaid)
  var pt = E.payableTotals(s, '苗');
  approx(pt.total, 310065 + 224958); approx(pt.paid, 0); approx(pt.unpaid, 310065 + 224958);
  s.payables[0].paid = true;
  approx(E.payableTotals(s, '苗').paid, 310065);
  // 瓶苗 shipment → 瓶苗 payable → bottle cash line
  s.shipments.push({ id: 'shx', type: '瓶苗', channel: '国内', supplier: 'x', spec: 'x', qty: '100', amount: '5000', iq: '', freight: '', freightWeek: '' });
  s.payables.push({ id: 'pbx', shipmentId: 'shx', payWeek: '20', amount: '', urgency: '三级' });
  approx(E.dueInWeek(s, 20, '瓶苗'), 5000);
  approx(E.computed(s, 20).bottle, 5000);
});

// ---- 逾期应付: unpaid past-due rolls forward; 已付 transitions AP → Paid -----
test('overduePayables sums unpaid past-due; 已付 removes from overdue + buckets', function () {
  var s = fresh();
  // demo pa1/pa2/pa3 sit in past weeks (14/15) vs as-of week 16 → all overdue
  approx(E.overduePayables(s), 310065 + 224958 + 40366);
  s.payables[0].paid = true;                       // mark pa1 已付 (AP → Paid)
  approx(E.overduePayables(s), 224958 + 40366);    // pa1 leaves overdue
  var b = E.payableBuckets(s, '苗');
  approx(b['国内'].total['三级'], 0);               // pa1 (三级) also leaves the outstanding buckets
  approx(b['国内'].total['二级'], 224958);          // pa2 (二级) remains
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
  // 运费 is now its OWN category (AP = booked per-shipment freight), no longer folded into 生产物资
  approx(E.computed(s, wT).freight, 1046.6 + 687 + 1432.31, 1e-3);
  approx(E.payOf(s, wT, 'materials'), E.eff(s, wT, 'materials'), 1e-3); // materials carries no freight now
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

test('销售明细: 国外染色花/国外切花 route to 国外收款 (matches the forecast channel)', function () {
  var s = fresh();
  var wT = E.weeks(s).findIndex(function (w) { return '2026-05-26' >= w.startISO && '2026-05-26' <= w.endISO; });
  var beforeF = E.salesReceipts(s, wT).foreign, beforeD = E.salesReceipts(s, wT).domestic;
  s.sales[wT + ':fxdye:amt'] = '12345';   // 国外染色花
  s.sales[wT + ':fxcut:amt'] = '6789';    // 国外切花
  approx(E.salesReceipts(s, wT).foreign, beforeF + 12345 + 6789);   // → 国外 HD
  approx(E.salesReceipts(s, wT).domestic, beforeD);                 // domestic untouched
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
