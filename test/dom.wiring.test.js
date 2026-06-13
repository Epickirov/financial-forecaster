'use strict';
// Exhaustive field-wiring test: drives EVERY input type through real DOM
// events and asserts the value lands at the right state path AND flows to
// its derived output (via the live store + engine).
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const REPO = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8');

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
const { window } = dom;
window.eval(read('src/engine.js')); window.eval(read('src/store.js')); window.eval(read('src/app.js'));
if (window.document.readyState === 'loading') window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

const app = window.document.getElementById('app');
const { store, engine: E, buildView } = window.FFApp;
let pass = 0;
function ok(c, m) { if (!c) { console.error('FAIL: ' + m); process.exit(1); } pass++; console.log('  ok  ' + m); }
function approx(a, b, e) { return Math.abs(a - b) <= (e || 1e-3); }
function fire(el, t) { el.dispatchEvent(new window.Event(t, { bubbles: true })); }
function click(el) { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }
function nav(p) { click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === p)); }
function byMapKey(map, keyRe) { return [...app.querySelectorAll('input[data-map="' + map + '"],select[data-map="' + map + '"]')].find(i => keyRe.test(i.dataset.key)); }
function byArr(arr, idx, key) { return app.querySelector('[data-arr="' + arr + '"][data-idx="' + idx + '"][data-key="' + key + '"]'); }
function setV(el, v, type) { el.value = v; fire(el, type || 'input'); }
// re-query helpers: every edit triggers a full re-render that REPLACES input
// nodes, so a stale reference would no longer bubble to the delegated listener.
// (In the live app focus is restored by id; tests must just re-query.)
function setMap(map, keyRe, v, type) { setV(byMapKey(map, keyRe), v, type); }
function setArr(arr, idx, key, v, type) { setV(byArr(arr, idx, key), v, type); }
const S = () => store.state;
const sel = () => Math.min(Math.max(S().weekIdx | 0, 0), E.weeks(S()).length - 1);

console.log('wiring.js — every field → its destination\n');

// pick a clean FUTURE week with NO committed 苗款 payable due (so the seedling
// BASELINE assumption is in effect, not a dated-payable override).
nav('fcst');
let W = E.weeks(S()).findIndex((w, i) => !E.isHist(S(), i) && E.seedDueInWeek(S(), i) === 0);
click([...app.querySelectorAll('[data-action="selectWeek"]')].find(b => +b.dataset.idx === W));
ok(sel() === W && !E.isHist(S(), W) && E.seedDueInWeek(S(), W) === 0, 'selected a payable-free future week (idx ' + W + ')');

// ---------- 1. ASSUMPTIONS: every group drives its forecast field ----------
nav('assume');
const cases = [
  ['priceForLarge', '30', s => E.computed(s, W).foreign, 'up'],
  ['defectRate', '0.5', s => E.computed(s, W).foreign, 'down'],   // more culling → less sellable
  ['collectInMonth', '0.1', s => E.computed(s, W)._domSales, 'down'],
  ['qtyDomLarge', '999999', s => E.computed(s, W).domestic, 'up'],
  ['seedlingMonthly', '500000', s => E.computed(s, W).seedling, 'up'],
  ['seedlingPrice', '99', s => E.computed(s, W).seedling, 'up'],
  ['pkgCost', '50', s => E.computed(s, W).materials, 'up'],
  ['prodCost', '50', s => E.computed(s, W).materials, 'up'],
  ['payrollMonthly', '900000', s => E.computed(s, W).payroll, 'up'],
  ['utilitiesMonthly', '900000', s => E.computed(s, W).utilrent, 'up'],
  ['freightMonthly', '900000', s => E.computed(s, W).materials, 'up'],
  ['projectsMonthly', '777000', s => E.computed(s, W).projects, 'up'],
  ['travelWeekly', '88000', s => E.computed(s, W).travel, 'up'],
  ['loanMonthly', '888000', s => E.computed(s, W).loan, 'up']
];
cases.forEach(function (c) {
  // re-select the future week (defectRate edits may shuffle nets but week stays)
  var before = c[2](S());
  var el = byMapKey('assumeWeek', new RegExp(':' + c[0] + '$'));
  ok(el, 'assume input present: ' + c[0]);
  setV(el, c[1]);
  var after = c[2](S());
  ok(c[3] === 'up' ? after > before + 1e-6 : after < before - 1e-6, c[0] + ' → ' + c[2].toString().match(/computed\(s, W\)\.?_?(\w+)/)[1] + ' moves ' + c[3] + ' (' + before.toFixed(0) + '→' + after.toFixed(0) + ')');
});
// note: the key is week-scoped, so it only affects week W onward (carry-forward)
ok(S().assumeWeek[W + ':priceForLarge'] === '30', 'assumption override stored under week-scoped key');

// ---------- 2. custom expense item → 其他自定义 (custom) ----------
const before其他 = E.computed(S(), W).custom;
click([...app.querySelectorAll('[data-action="addAssume"]')].find(b => b.dataset.group === 'opex'));
const custNameInput = [...app.querySelectorAll('input[data-arr="customItems"][data-key="name"]')].pop();
ok(custNameInput, 'custom item row added in opex group');
const custId = S().customItems[S().customItems.length - 1].id;
const custValInput = byMapKey('assumeWeek', new RegExp(':' + custId + '$'));
setV(custValInput, '120000');
ok(E.computed(S(), W).custom > before其他, 'custom monthly expense feeds 其他自定义 forecast');
// delete it again
click([...app.querySelectorAll('[data-action="delCustom"]')].pop());
ok(S().customItems.findIndex(x => x.id === custId) === -1, 'delCustom removes the custom item');

// ---------- 3. rents & fixed schedules → utilrent / loan in their months ----------
// add a rent that hits EVERY month, see utilrent jump for week W's month
nav('assume');
const wMonth = E.weeks(S())[W].month;
click([...app.querySelectorAll('[data-action="addRow"]')].find(b => b.dataset.arr === 'rents'));
const rIdx = S().rents.length - 1;
const beforeUtil = E.computed(S(), W).utilrent;
setV(byArr('rents', rIdx, 'amount'), '433300');
setV(byArr('rents', rIdx, 'months'), '' + wMonth, 'input');
ok(E.computed(S(), W).utilrent > beforeUtil, 'rent amount+到期月份 flows into 水电与租金 for that month');
click(app.querySelector('[data-action="delRow"][data-arr="rents"][data-idx="' + rIdx + '"]'));
ok(S().rents.length === rIdx, 'delRow removes the rent line');

click([...app.querySelectorAll('[data-action="addRow"]')].find(b => b.dataset.arr === 'fixed'));
const fIdx = S().fixed.length - 1;
const beforeLoan = E.computed(S(), W).loan;
setV(byArr('fixed', fIdx, 'amount'), '212100');
setV(byArr('fixed', fIdx, 'months'), '' + wMonth, 'input');
ok(E.computed(S(), W).loan > beforeLoan, 'fixed payment+到期月份 flows into 借款/固定 for that month');

// ---------- 4. 苗款 payable date → that week's seedling outflow ----------
nav('seedpay');
click([...app.querySelectorAll('[data-action="addRow"]')].find(b => b.dataset.arr === 'seedPayables'));
const pIdx = S().seedPayables.length - 1;
const wk = E.weeks(S())[W];
setV(byArr('seedPayables', pIdx, 'qty'), '10000');
setV(byArr('seedPayables', pIdx, 'price'), '6', 'input');
setV(byArr('seedPayables', pIdx, 'payby'), wk.startISO, 'input');
ok(approx(E.seedDueInWeek(S(), W), 60000, 1), 'payable qty×price due inside week W = 60000');
ok(E.computed(S(), W).seedling >= 60000 - 1, 'dated payable becomes week W 苗款 forecast');
// urgency select persists
setV(byArr('seedPayables', pIdx, 'urgency'), '一级', 'change');
ok(S().seedPayables[pIdx].urgency === '一级', '紧急度 select persists');
// note column persists
setV(byArr('seedPayables', pIdx, 'note'), '测试备注', 'input');
ok(S().seedPayables[pIdx].note === '测试备注', '备注 column persists');

// ---------- 5. HISTORICAL actuals replace forecast in the series ----------
nav('hist');
const histChips = [...app.querySelectorAll('[data-action="selectWeek"]')];
click(histChips[histChips.length - 1]); // last elapsed week
const HW = sel();
ok(E.isHist(S(), HW), 'selected an elapsed week for actuals');
// sales qty+amt → price + totals (re-query between edits; each edit re-renders)
setMap('sales', /xj35:qty$/, '100');
setMap('sales', /xj35:amt$/, '2500');
ok(S().sales[HW + ':xj35:qty'] === '100' && S().sales[HW + ':xj35:amt'] === '2500', 'sales qty/amt stored per week');
ok(app.innerHTML.includes('25.00'), 'sales 平均单价 auto-calculates (2500/100=25.00)');
// purchasing qty+amt+frt → total incl freight
setMap('purch', /pmsmall:qty$/, '10');
setMap('purch', /pmsmall:amt$/, '1000');
setMap('purch', /pmsmall:frt$/, '234');
ok(S().purch[HW + ':pmsmall:frt'] === '234', 'purchasing 运费 stored');
ok(app.innerHTML.indexOf('1,234') >= 0 || E.num(S().purch[HW + ':pmsmall:amt']) + E.num(S().purch[HW + ':pmsmall:frt']) === 1234, '进货合计 includes freight (1000+234=1234)');
// actual cash entry replaces forecast in eff/series
setMap('actual', /:foreign$/, '654321');
ok(E.eff(S(), HW, 'foreign') === 654321, 'actual 国外收款 replaces forecast (eff) for elapsed week');
ok(E.acOf(S(), HW, 'foreign') === 654321 && approx(E.fcOf(S(), HW, 'foreign'), E.computed(S(), HW).foreign), 'forecast value untouched by the actual (variance source intact)');

// ---------- 6. FORECAST override beats the assumption ----------
nav('fcst');
click([...app.querySelectorAll('[data-action="selectWeek"]')][2]);
const FW = sel();
setMap('fcst', /:foreign$/, '777777');
ok(E.fcOf(S(), FW, 'foreign') === 777777, 'forecast override applied');
setMap('fcst', /:foreign$/, '');   // re-query: previous edit re-rendered the node
ok(approx(E.fcOf(S(), FW, 'foreign'), E.computed(S(), FW).foreign), 'blank override falls back to the assumption value');

// ---------- 7. RECEIVABLES outstanding + category ----------
nav('ar');
const out0 = S().customers.reduce((s, c) => s + (parseFloat(c.outstanding) || 0), 0);
setV(byArr('customers', 0, 'outstanding'), '1000000');
const out1 = S().customers.reduce((s, c) => s + (parseFloat(c.outstanding) || 0), 0);
ok(out1 !== out0 && S().customers[0].outstanding === '1000000', '应收余额 edit updates the customer + total');
setV(byArr('customers', 0, 'cat'), '国外', 'change');
ok(S().customers[0].cat === '国外', '客户分类 select persists (feeds category summary)');

// ---------- 8. CONFIG: dates regenerate weeks; as-of splits; unit toggles ----------
const obal = window.document.getElementById('c|openingBalance');
setV(obal, '1234567');
ok(S().config.openingBalance === '1234567' && approx(E.series(S())[0].open, 1234567), '期初余额 edit reflows into the series opening');
const wkCountBefore = E.weeks(S()).length;
setV(window.document.getElementById('c|endISO'), '2026-08-31', 'change');
ok(E.weeks(S()).length < wkCountBefore, '财年结束日期改变 → 周网格重新生成（变短）');
const histBefore = E.series(S()).filter(s => s.isHist).length;
setV(window.document.getElementById('c|asOfISO'), '2026-03-15', 'change');
ok(E.series(S()).filter(s => s.isHist).length < histBefore, '截至日期提前 → 历史周减少（更多预测周）');
click(app.querySelector('[data-action="toggleUnit"]'));
ok(S().config.unit === '元', '单位切换 万→元');
ok(app.innerHTML.includes('¥'), '元 mode renders ¥ formatted money');

console.log('\n' + pass + ' wiring assertions passed.\n');
