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

// The shipped app is auth-gated and boots a BLANK template; the wiring suite
// bypasses the gate via the FFApp.enterWithState seam, mounting the app with
// the rich demo numbers needed to observe drivers moving outputs.
const demoModel = require('./fixtures.js');
window.FFApp.enterWithState(demoModel());

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

// ---------- 0. per-tab default selected week on nav ----------
nav('hist');
const lastHist = (() => { let h = -1, Wk = E.weeks(S()); for (let i = 0; i < Wk.length; i++) if (E.isHist(S(), i)) h = i; return h; })();
ok(sel() === lastHist && E.isHist(S(), sel()), '历史 nav defaults to the latest completed week (idx ' + lastHist + ')');
nav('fcst');
ok(sel() === E.currentWeekIdx(S()) + 1, '预测 nav defaults to current week + 1 (idx ' + sel() + ')');
nav('assume');
ok(sel() === E.currentWeekIdx(S()) + 1, '假设 nav defaults to current week + 1');

// pick a clean FUTURE week with NO scheduled 苗 payable due (so the seedling
// BASELINE assumption is in effect, not a payable override).
nav('fcst');
let W = E.weeks(S()).findIndex((w, i) => !E.isHist(S(), i) && E.dueInWeek(S(), i, '苗') === 0);
click([...app.querySelectorAll('[data-action="selectWeek"]')].find(b => +b.dataset.idx === W));
ok(sel() === W && !E.isHist(S(), W) && E.dueInWeek(S(), W, '苗') === 0, 'selected a payable-free future week (idx ' + W + ')');

// ---------- 1. ASSUMPTIONS: every group drives its forecast field ----------
nav('assume');
// nav now defaults to current+1, so explicitly re-select the week-W we're testing
click([...app.querySelectorAll('[data-action="selectWeek"]')].find(b => +b.dataset.idx === W));
const cases = [
  ['priceForLarge', '30', s => E.computed(s, W).foreign, 'up'],
  ['defectRate', '0.5', s => E.computed(s, W).foreign, 'down'],   // more culling → less sellable
  ['qtyDomLarge', '999999', s => E.computed(s, W).domestic, 'up'],
  ['qtyDomCut', '999999', s => E.computed(s, W).domestic, 'up'],   // 国内切花 now feeds 国内收款
  ['collectInWeek', '2', s => E.computed(s, W).domestic, 'up'],    // 当周回款率 multiplies 销售收款
  ['miaoAmount', '9000000', s => E.computed(s, W).seedling, 'up'],    // 苗金额 → 苗款 forecast
  ['huaAmount', '9000000', s => E.computed(s, W).flowering, 'up'],    // 开花株金额 → 开花株款 forecast
  ['bottleAmount', '9000000', s => E.computed(s, W).bottle, 'up'],    // 瓶苗款 forecast
  ['pkgCost', '900000', s => E.computed(s, W).materials, 'up'],
  ['prodCost', '900000', s => E.computed(s, W).materials, 'up'],
  ['payrollMonthly', '900000', s => E.computed(s, W).payroll, 'up'],
  ['utilitiesMonthly', '900000', s => E.computed(s, W).utilrent, 'up'],
  ['freightMonthly', '900000', s => E.computed(s, W).freight, 'up'],   // 运费 is its own category now
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
// custom-item button is gated to EXPENSE groups (price/collect/volume rows would be orphaned)
ok([...app.querySelectorAll('[data-action="addAssume"]')].map(b => b.dataset.group).sort().join(',') === 'material,opex,seed', '+新增项目 present only on expense groups (removed from price/collect/volume)');

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

// ---------- 4. 进货验货 shipment → 苗款 payable (week-picker) → seedling outflow ----------
nav('hist');
click([...app.querySelectorAll('[data-action="addRow"]')].find(b => b.dataset.arr === 'shipments'));
const shIdx = S().shipments.length - 1;
setV(byArr('shipments', shIdx, 'qty'), '10000');
setV(byArr('shipments', shIdx, 'amount'), '60000', 'input');
const newShipId = S().shipments[shIdx].id;
ok(E.shipUnit(S().shipments[shIdx]) === 6, '单价 auto-calculates (60000/10000 = 6.00)');
nav('seedpay');
click([...app.querySelectorAll('[data-action="addRow"]')].find(b => b.dataset.arr === 'payables'));
const paIdx = S().payables.length - 1;
setV(byArr('payables', paIdx, 'shipmentId'), newShipId, 'change');
click(app.querySelector('[data-action="pickWeek"][data-arr="payables"][data-idx="' + paIdx + '"][data-week="' + W + '"]'));
ok(S().payables[paIdx].payWeek === W, '付款周 tile click sets payWeek = ' + W);
ok(approx(E.dueInWeek(S(), W, '苗'), 60000, 1), 'payable (default full shipment amount) due in week W = 60000');
ok(E.computed(S(), W).seedling >= 60000 - 1, 'scheduled payable becomes week W 苗款 forecast');
setV(byArr('payables', paIdx, 'urgency'), '一级', 'change');
ok(S().payables[paIdx].urgency === '一级', '紧急度 select persists');
setV(byArr('payables', paIdx, 'amount'), '25000');   // split / partial pay
ok(approx(E.dueInWeek(S(), W, '苗'), 25000, 1), 'partial amount overrides the full shipment amount (split)');

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
// 销售明细 国内 sum auto-fills the 现金流实际 国内收款 when no manual actual keyed
const HWdomSales = E.salesReceipts(S(), HW).domestic;
ok(HWdomSales >= 2500 && approx(E.eff(S(), HW, 'domestic'), HWdomSales), '销售明细 国内 sum auto-fills 国内收款 (eff fallback)');
// actual cash entry replaces forecast in eff/series
setMap('actual', /:foreign$/, '654321');
ok(E.eff(S(), HW, 'foreign') === 654321, 'actual 国外收款 replaces forecast (eff) for elapsed week');
ok(E.acOf(S(), HW, 'foreign') === 654321 && approx(E.fcOf(S(), HW, 'foreign'), E.computed(S(), HW).foreign), 'forecast value untouched by the actual (variance source intact)');

// ---------- 6. FORECAST page is read-only (driven entirely by 假设) ----------
nav('fcst');
ok(app.querySelectorAll('input[data-map="fcst"]').length === 0, '预测 page has no editable override inputs — read-only');
ok(app.innerHTML.includes('收款测算'), '预测 still shows the computed 收款测算');

// ---------- 7. RECEIVABLES: per-customer 出货 + 回款周 → forecast 收款 by channel ----------
nav('ar');
const cIdx = 5;                                   // 切花批发商 (国内), no demo shipment
const arCustId = S().customers[cIdx].id;
const beforeDom = E.arDueInWeek(S(), W).domestic;
click(app.querySelector('[data-action="addArShip"][data-cust="' + arCustId + '"]'));
const asIdx = S().arShipments.length - 1;
setV(byArr('arShipments', asIdx, 'value'), '500000');
ok(approx(E.customerOutstanding(S(), arCustId), 500000, 1), '客户出货货值汇总为应收余额 (500000)');
click(app.querySelector('[data-action="pickWeek"][data-arr="customers"][data-idx="' + cIdx + '"][data-week="' + W + '"]'));
ok(S().customers[cIdx].collectWeek === W, '回款周 tile click sets collectWeek = ' + W);
ok(approx(E.arDueInWeek(S(), W).domestic - beforeDom, 500000, 1), '客户应收在回款周计入 国内收款 (+500000)');
const domBeforeCat = E.arDueInWeek(S(), W).domestic;
setV(byArr('customers', cIdx, 'cat'), '国外', 'change');
ok(approx(domBeforeCat - E.arDueInWeek(S(), W).domestic, 500000, 1), '客户分类→国外 时应收从 国内 转入 国外收款');

// ---------- 7b. 假设 账期 field + per-shipment 回款周 override ----------
nav('assume');
const lagEl = [...app.querySelectorAll('input[data-map="assumeWeek"]')].find(i => /:lagForeign$/.test(i.dataset.key));
ok(lagEl, '假设·回款节奏 exposes 国外应收账期 (lagForeign) field');
setV(lagEl, '6');
ok(S().assumeWeek[sel() + ':lagForeign'] === '6', '账期 edit persists to assumeWeek (week-scoped, carry-forward)');
nav('ar');
const ovIdx = S().arShipments.length - 1;             // the c6 shipment added in section 7 (no 出货日期)
const ovWeek = E.currentWeekIdx(S()) + 1;
click(app.querySelector('[data-action="pickWeek"][data-arr="arShipments"][data-idx="' + ovIdx + '"][data-week="' + ovWeek + '"]'));
ok(S().arShipments[ovIdx].collectWeek === ovWeek, 'per-shipment 回款周 override sets arShipments.collectWeek = ' + ovWeek);
ok(E.arCollectWeek(S(), S().arShipments[ovIdx]) === ovWeek, 'arCollectWeek honors the per-shipment override over the customer fallback');

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
