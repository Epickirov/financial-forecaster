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

// ---------- 7. RECEIVABLES: per-week ledger → 本周已收 flows to 收款; 预计应收 carries forward ----------
nav('ar');
click([...app.querySelectorAll('[data-action="selectWeek"]')].find(b => +b.dataset.idx === 25));   // a clean week
const arWk = sel();
const cinBefore = E.series(S())[arWk].cin;
setMap('ar', new RegExp('^' + arWk + ':dom:rcv$'), '70000');
ok(S().ar[arWk + ':dom:rcv'] === '70000', '本周已收(国内) persists to state.ar');
ok(approx(E.series(S())[arWk].cin - cinBefore, 70000, 1), '本周已收 adds to the week 收款 (cin +70000)');
setMap('ar', new RegExp('^' + arWk + ':for:exp$'), '900000');
ok(approx(E.arExp(S(), arWk + 3, 'for'), 900000, 1), '预计应收(国外) carries forward to later weeks');
ok(approx(E.cashPlusARCloses(S())[arWk] - E.forecastCloses(S())[arWk], E.arExpectedTotal(S(), arWk), 1), '现金+应收 line = 现金 + 当周预计应收');
// 假设·回款节奏 shows the same 预计应收 (read-only)
nav('assume');
click([...app.querySelectorAll('[data-action="selectWeek"]')].find(b => +b.dataset.idx === arWk));
ok(app.innerHTML.includes('国外应收') && [...app.querySelectorAll('input[data-map="assumeWeek"]')].every(i => !/:lag/.test(i.dataset.key)), '假设·回款节奏 shows 应收 read-only (no 账期 inputs)');

// ---------- 8. SETTINGS: opening balance + (manual) fiscal dates ----------
nav('settings');
const obal = window.document.getElementById('c|openingBalance');
setV(obal, '1234567');
ok(S().config.openingBalance === '1234567' && approx(E.series(S())[0].open, 1234567), '期初余额 edit reflows into the series opening');
const wkCountBefore = E.weeks(S()).length;
setV(window.document.getElementById('c|endISO'), '2026-08-31', 'change');
ok(E.weeks(S()).length < wkCountBefore, '财年结束日期改变 → 周网格重新生成（变短）');
click(app.querySelector('[data-action="toggleUnit"]'));
ok(S().config.unit === '元', '单位切换 万→元');
nav('dash');   // settings page renders no fmt money; check ¥ on a money page
ok(app.innerHTML.includes('¥'), '元 mode renders ¥ formatted money');

// ---------- 9. 物流 freight 已付/未付 toggle ----------
nav('logi');
const _fp0 = S().shipments[0].freightPaid;
click(app.querySelector('[data-action="toggleFreightPaid"][data-idx="0"]'));
ok(S().shipments[0].freightPaid !== _fp0, '物流 已付/未付 toggle flips shipments[0].freightPaid');

// ---------- 10. SETTINGS: 农历财年 auto↔manual toggle ----------
nav('settings');
click([...app.querySelectorAll('[data-action="setFyMode"]')].find(b => b.dataset.mode === 'auto'));
const lf = E.lunarFY(S().config.asOfISO);
ok(S().config.fyMode === 'auto', '农历财年 切换到自动');
ok(E.weeks(S())[0].startISO === lf.startISO, '自动模式下周网格起点 = 当前农历年正月初一 (' + lf.startISO + ')');
click([...app.querySelectorAll('[data-action="setFyMode"]')].find(b => b.dataset.mode === 'manual'));
ok(S().config.fyMode === 'manual' && S().config.startISO === lf.startISO, '切回手动并以当前农历窗口预置起止日期');

// hostile manual dates: 起始 later than 结束 must NOT crash — falls back to auto + shows a hint
const wkBefore = E.weeks(S()).length;
setV(window.document.getElementById('c|startISO'), '2028-03-01', 'change');   // now start > end
ok(E.weeks(S()).length === wkBefore && E.weeks(S())[0].startISO === lf.startISO,
   '起始>结束 的手动窗口不生效 → 回退自动农历窗口（不再产生空周网格/崩溃）');
ok(app.innerHTML.includes('该窗口无效'), '设置页显示无效日期提示');
setV(window.document.getElementById('c|startISO'), lf.startISO, 'change');    // restore a valid window

// ---------- 11. 今日 = real today: no 截至 field; 实际 line caps at 今日 ----------
nav('settings');
ok([...app.querySelectorAll('[data-action="setAsOfMode"]')].length === 0 && !window.document.getElementById('c|asOfISO'), '设置 has no 截至 controls — 今日 is auto-only');
nav('dash');
const Wk = E.weeks(S());
let lastH = -1; for (let i = 0; i < Wk.length; i++) if (E.isHist(S(), i)) lastH = i;
ok(lastH >= 0 && Wk[lastH].endISO <= S().config.asOfISO && (lastH + 1 >= Wk.length || Wk[lastH + 1].endISO > S().config.asOfISO),
   '实际(历史)周止于「今日」所在周 — 实际线不会越过今日 (lastHist=' + lastH + ')');

// ---------- 12. 预测 应付款 caption follows the SELECTED week ----------
nav('fcst');
const capW = E.currentWeekIdx(S()) + 3;   // pick a week ≠ the nav default (current+1)
click([...app.querySelectorAll('[data-action="selectWeek"]')].find(b => +b.dataset.idx === capW));
ok(app.innerHTML.includes('该周(第' + (capW + 1) + '周)应付苗款合计'), '预测 应付款说明行随所选周变化（不再固定为当前周）');

// ---------- 13. 应付账款 → 假设 数据跳转: booked AP shows read-only in 种苗应付 ----------
nav('assume');
const apW = (() => { const Wl = E.weeks(S()); for (let i = 0; i < Wl.length; i++) if (E.dueInWeek(S(), i, '苗') > 0) return i; return -1; })();
ok(apW >= 0, "a week with booked (unpaid) 苗 AP exists (idx " + apW + ")");
click([...app.querySelectorAll('[data-action="selectWeek"]')].find(b => +b.dataset.idx === apW));
ok(app.innerHTML.includes('苗款 AP') && app.innerHTML.includes('已登记应付'), "假设·种苗应付 shows the week's booked AP read-only (应付→假设 数据跳转)");

// legacy fcst overrides in a saved state must not skew the read-only 预测
store.editMap('fcst', E.currentWeekIdx(S()) + 2 + ':foreign', '31415926');
nav('fcst');
ok(!app.innerHTML.includes('31,415,926'), '遗留 fcst 覆盖值被忽略 — 预测只由假设驱动');

console.log('\n' + pass + ' wiring assertions passed.\n');
