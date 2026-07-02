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
  ['sales', 'fcst', 'actual', 'ar'].forEach(function (m) { assert.deepStrictEqual(d[m], {}, m + ' empty'); });
  assert.deepStrictEqual(d.payables, [], 'payables empty');
  d.rents.forEach(function (r) { assert.ok(r.name, 'rent name kept'); assert.strictEqual(r.amount, '', 'rent amount cleared'); });
  d.fixed.forEach(function (r) { assert.ok(r.name, 'fixed name kept'); assert.strictEqual(r.amount, '', 'fixed amount cleared'); });
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

// ---- 农历财年 auto window (lunar calendar) -------------------------------
test('lunarFY maps a date to its 正月初一→除夕 window and auto-rolls across years', function () {
  var a = E.lunarFY('2026-06-23');                      // mid-2026 → the 丙午 lunar year
  assert.strictEqual(a.startISO, '2026-02-17', 'FY starts at 正月初一 2026');
  assert.strictEqual(a.endISO, '2027-02-05', 'FY ends the day before 正月初一 2027');
  var b = E.lunarFY('2027-02-06');                      // the day year-end rolls over
  assert.strictEqual(b.startISO, '2027-02-06', 'crossing 除夕 advances to the next 农历财年');
  assert.strictEqual(b.endISO, '2028-01-25');
  var c = E.lunarFY('2026-02-16');                      // just before 正月初一 → prior year
  assert.strictEqual(c.startISO, '2025-01-29');
  assert.strictEqual(c.endISO, '2026-02-16');
});

test('fyWindow: auto derives from the lunar calendar, manual uses stored dates', function () {
  var auto = { config: { asOfISO: '2030-07-01', fyMode: 'auto', startISO: 'x', endISO: 'y' } };
  var wa = E.fyWindow(auto);
  assert.strictEqual(wa.startISO, '2030-02-03', 'CNY 2030 = Feb 3');
  assert.strictEqual(wa.endISO, '2031-01-22', 'day before CNY 2031 (Jan 23)');
  assert.ok(E.weeks(auto).some(function (w) { return '2030-07-01' >= w.startISO && '2030-07-01' <= w.endISO; }), 'as-of falls inside the auto grid');
  var manual = { config: { asOfISO: '2030-07-01', fyMode: 'manual', startISO: '2026-02-17', endISO: '2027-02-05' } };
  assert.strictEqual(E.fyWindow(manual).startISO, '2026-02-17', 'manual mode ignores the lunar calendar');
  assert.strictEqual(E.lunarYearLabel(2026), '丙午（马）年', '干支 + 生肖 label for 2026');
});

test('invalid manual window (reversed/incomplete) falls back to auto — grid never empty, computed() safe', function () {
  var mk = function (startISO, endISO) { return { config: { fyMode: 'manual', startISO: startISO, endISO: endISO, asOfISO: '2026-06-23' }, assume: {}, rents: [], fixed: [] }; };
  var rev = mk('2027-03-01', '2027-02-05');            // 起始 later than 结束
  assert.strictEqual(E.manualFyOk(rev.config), false, 'reversed window flagged invalid');
  assert.strictEqual(E.fyWindow(rev).startISO, '2026-02-17', 'reversed manual window → auto lunar window');
  assert.ok(E.weeks(rev).length >= 50, 'grid regenerated from auto, not empty');
  assert.doesNotThrow(function () { E.computed(rev, 0); E.series(rev); }, 'calc spine safe under a reversed manual window');
  var half = mk('2026-02-17', '');                     // incomplete: no end date
  assert.strictEqual(E.manualFyOk(half.config), false, 'missing end date flagged invalid');
  assert.strictEqual(E.fyWindow(half).startISO, '2026-02-17', 'incomplete manual window → auto');
  assert.doesNotThrow(function () { E.computed({ config: {} }, 0); }, 'computed() never dereferences an undefined week');
});

test('genWeeks caps the grid at 60 weeks (manual windows longer than that truncate)', function () {
  var w = E.genWeeks('2026-02-17', '2028-02-17');      // ~104-week window
  assert.strictEqual(w.length, 60, 'grid capped at 60 weeks');
  assert.ok(w[w.length - 1].endISO < '2028-02-17', 'configured end date not reached (truncated)');
});

test('AR 本周新增 (add) is stored for record-keeping only — balance and cash are unaffected', function () {
  var s = fresh();
  var expBefore = E.arExp(s, 20, 'dom');
  var cinBefore = E.series(s)[20].cin;
  s.ar = Object.assign({}, s.ar); s.ar['20:dom:add'] = '999999';
  assert.strictEqual(E.arAdd(s, 20, 'dom'), 999999, 'add value captured');
  assert.strictEqual(E.arExp(s, 20, 'dom'), expBefore, '预计应收 balance unchanged by 本周新增');
  approx(E.series(s)[20].cin, cinBefore, 0.001);        // 收款 unchanged: only 本周已收 feeds cash
});

test('defaultModel ships auto 农历财年; a 2026 as-of yields the legacy fiscal window', function () {
  var d = FFStore.defaultModel();
  assert.strictEqual(d.config.fyMode, 'auto', 'auto by default');
  d.config.asOfISO = '2026-06-23';
  var w = E.weeks(d);
  assert.strictEqual(w[0].startISO, '2026-02-17', 'auto window starts 正月初一 2026');
  assert.ok(w[w.length - 1].endISO <= '2027-02-05');
});

test('setFyMode mutates the fiscal-year mode + seeds the manual window', function () {
  var noop = function () {};
  var s = new FFStore.Store({ load: function () { return null; }, save: noop, clear: noop });
  s.state.config.asOfISO = '2026-06-23';
  s.setFyMode('manual', '2026-02-17', '2027-02-05');
  assert.strictEqual(s.state.config.fyMode, 'manual');
  assert.strictEqual(s.state.config.startISO, '2026-02-17', 'manual seeds the stored window');
  s.setFyMode('auto');
  assert.strictEqual(s.state.config.fyMode, 'auto');
});

// ---- 今日 ALWAYS tracks the real (China) date — no manual pin ----------------
test('asOfISO always = China today on load; legacy pins are dropped', function () {
  var today = FFStore.todayISO();
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(today), 'todayISO is a valid YYYY-MM-DD');
  var d = FFStore.defaultModel();
  assert.strictEqual(d.config.asOfISO, today, 'fresh model 今日 = China today');
  assert.ok(!('asOfManual' in d.config), 'no asOfManual pin field on the fresh model');
  // a saved workspace — even one carrying a legacy pin to the year-end — refreshes to today
  var noop = function () {};
  var legacy = { load: function () { return { config: { asOfISO: '2027-02-05', asOfManual: true } }; }, save: noop, clear: noop };
  var s1 = new FFStore.Store(legacy);
  assert.strictEqual(s1.state.config.asOfISO, today, 'stale/pinned as-of refreshes to today regardless of any legacy pin');
  assert.ok(!('asOfManual' in s1.state.config), 'legacy pin flag is dropped on load');
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

// ---- 应收账款 ledger (per-week by channel) + cash wiring -------------------
test('应收账款 ledger: 预计应收 carries forward; 本周已收 adds to 收款; 现金+应收 line', function () {
  var s = fresh();
  // demo ar: wk15 exp dom=200000/for=500000; wk16 rcv dom=60000/for=120000, add dom=50000
  approx(E.arExp(s, 15, 'dom'), 200000);
  approx(E.arExp(s, 16, 'dom'), 200000);            // carries forward from wk15
  approx(E.arExp(s, 16, 'for'), 500000);
  approx(E.arExpectedTotal(s, 16), 700000);
  approx(E.arRcv(s, 16, 'dom'), 60000);
  approx(E.arReceivedTotal(s, 16), 180000);
  approx(E.arAdd(s, 16, 'dom'), 50000);
  // 本周已收 adds to that week's 收款 (series cin); wk16 is future → eff = fcOf
  var base = E.fcOf(s, 16, 'foreign') + E.fcOf(s, 16, 'domestic');
  approx(E.series(s)[16].cin, base + 180000);
  // 现金 + 应收 line = forecast cash + outstanding 预计应收
  var fc = E.forecastCloses(s), cp = E.cashPlusARCloses(s);
  approx(cp[16] - fc[16], 700000);
});

test('应收账款: blank 预计应收 inherits previous week; a later week overrides forward only', function () {
  var s = fresh();
  approx(E.arExp(s, 30, 'dom'), 200000);            // wk30 blank → inherits wk15's 200000
  approx(E.arInheritedExp(s, 16, 'dom'), 200000);   // value strictly before wk16
  s.ar['18:dom:exp'] = '90000';
  approx(E.arExp(s, 19, 'dom'), 90000);             // carries forward from the new wk18 value
  approx(E.arExp(s, 17, 'dom'), 200000);            // weeks before 18 unaffected
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

test('fcOf is driven purely by 假设 — legacy state.fcst overrides are ignored', function () {
  var s = fresh();
  var pure = E.computed(s, 20).foreign;
  s.fcst['20:foreign'] = '999999';      // stale override from the removed 预测-page inputs
  approx(E.fcOf(s, 20, 'foreign'), pure, 0.001);   // must NOT skew the forecast
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
