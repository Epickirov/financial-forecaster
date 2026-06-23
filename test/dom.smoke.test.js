'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = require('path').resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(REPO, f), 'utf8');

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'outside-only'
});
const { window } = dom;
// minimal SVG CTM stub so chart wiring doesn't throw if ever called
window.SVGElement && (window.SVGElement.prototype.getScreenCTM = function () { return null; });

// execute the three classic scripts in window scope, in load order
window.eval(read('src/engine.js'));
window.eval(read('src/store.js'));
window.eval(read('src/app.js'));   // registers boot on DOMContentLoaded
// jsdom leaves readyState='loading'; fire the event to trigger boot (real browsers do this).
if (window.document.readyState === 'loading') window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

// The shipped app is auth-gated and boots a BLANK template. With no backend
// in jsdom it shows the login screen; the regression suite bypasses the gate
// via the FFApp.enterWithState seam, mounting the app with the rich demo data.
const demoModel = require('./fixtures.js');
window.FFApp.enterWithState(demoModel());

const $ = sel => window.document.querySelector(sel);
const app = $('#app');
let pass = 0;
function ok(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } pass++; console.log('  ok  ' + msg); }
function fire(el, type) { el.dispatchEvent(new window.Event(type, { bubbles: true })); }
function click(el) { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }

console.log('dom smoke test');

// 1) dashboard renders with seeded KPIs
ok(/财务总览/.test(app.innerHTML), 'dashboard title renders');
ok(/全年收款/.test(app.innerHTML) && /现金轨迹/.test(app.innerHTML), 'KPI row + chart render');

// 2) every nav page renders without throwing
const pages = { hist: '销售明细', fcst: '收款测算', assume: '销量与淘汰', seedpay: '应付款登记', logi: '各批次运费', ar: '本周应收余额', report: '财务预测报告', settings: '今日基准（截至）' };
Object.keys(pages).forEach(p => {
  click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === p));
  ok(app.innerHTML.includes(pages[p]), 'page "' + p + '" renders (' + pages[p] + ')');
});

// 3) 苗/花应付款 shows the bucket summary; 历史数据 has the per-supplier 进货验货
click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === 'seedpay'));
ok(app.innerHTML.includes('欠款(逾期)') && app.innerHTML.includes('应付款登记'), '苗/花应付款 breakdown buckets + register render');
ok(app.innerHTML.includes('瓶苗款') && app.innerHTML.includes('总金额') && app.innerHTML.includes('未付'), '苗/花/瓶苗 boxes show 总金额/已付/未付');
click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === 'logi'));
ok(app.querySelector('[data-action="toggleFreightPaid"]') && app.innerHTML.includes('未付'), '物流成本 rows have 已付/未付 toggle + 总金额/已付/未付');
click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === 'hist'));
ok(app.innerHTML.includes('进货验货 · 按供应商') && app.querySelector('select[data-arr="shipments"][data-key="type"]'), '历史数据 进货验货 is a per-supplier shipment register');

// 4) editing an assumption creates a live "本周覆盖" badge
click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === 'assume'));
const priceInput = [...app.querySelectorAll('input[data-map="assumeWeek"]')].find(i => /priceForLarge$/.test(i.dataset.key));
ok(priceInput, 'found 国外大花单价 assumption input');
ok(!app.innerHTML.includes('本周覆盖'), 'no override badge before editing');
priceInput.value = '25'; fire(priceInput, 'input');
const after = [...app.querySelectorAll('input[data-map="assumeWeek"]')].find(i => /priceForLarge$/.test(i.dataset.key));
ok(after.value === '25', 'assumption value persisted to the store + re-rendered');
ok(app.innerHTML.includes('本周覆盖'), 'override badge appears live after edit');

// 5) opening balance lives on the settings page and flows to the KPI
click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === 'settings'));
const obal = $('#c\\|openingBalance') || window.document.getElementById('c|openingBalance');
ok(obal, 'opening-balance input exists on the settings page');
obal.value = '9000000'; fire(obal, 'input');
click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === 'dash'));
ok(app.innerHTML.includes('900.00万'), 'opening balance edit reflows into 现可用款 KPI (900.00万)');

// 6) AR ledger (per-week 国内/国外); forecast 收款测算 sums FD + 本周已收
click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === 'ar'));
ok(app.querySelector('input[data-map="ar"]') && app.innerHTML.includes('本周已收金额'), 'AR page is a per-week 国内/国外 ledger (预计应收 / 本周新增 / 本周已收)');
click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === 'fcst'));
ok(app.innerHTML.includes('本周已收 (应收账款)') && app.innerHTML.includes('预测收款 (FD)'), 'forecast 收款测算 sums FD + 本周已收');

// 7) selecting a week chip changes the active selection
click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === 'fcst'));
const chipsBtns = [...app.querySelectorAll('[data-action="selectWeek"]')];
ok(chipsBtns.length > 0, 'forecast week chips present');
click(chipsBtns[chipsBtns.length - 1]);
ok(true, 're-render after selecting a future week did not throw');

// 7b) interactive tutorial covers every data-entry page with field highlighting
click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === 'tut'));
ok(app.innerHTML.includes('三步看懂') && app.innerHTML.includes('高亮'), 'tutorial page renders with stage guides + highlight buttons');
ok(['Forecast Data', '应收账款', 'Accounts Payable', '历史数据', '预测数据'].every(s => app.innerHTML.includes(s)), 'glossary defines FD/AR/AP/HD in Chinese + English');
click([...app.querySelectorAll('[data-action="tutSelect"]')].find(b => b.dataset.stage === 'ar'));
ok(app.innerHTML.includes('苗/花应付款') && app.innerHTML.includes('物流成本'), 'AR stage covers 应收 + 应付 (苗/花应付款 + 物流成本)');
click([...app.querySelectorAll('[data-action="tutHi"]')].find(b => b.dataset.stage === 'ap'));
ok(app.getAttribute('data-tut') === 'ap' && app.innerHTML.includes('教程 · AR'), '苗/花应付款 highlight sets data-tut="ap" on the seedpay page');
click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === 'tut'));
click([...app.querySelectorAll('[data-action="tutSelect"]')].find(b => b.dataset.stage === 'fd'));
ok(app.innerHTML.includes('预测页'), 'FD stage points to the 预测 page');
click([...app.querySelectorAll('[data-action="tutHi"]')].find(b => b.dataset.stage === 'fcst'));
ok(app.getAttribute('data-tut') === 'fcst' && app.innerHTML.includes('教程 · FD'), '预测 highlight sets data-tut="fcst" on the 预测 page');
click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === 'dash'));
ok(app.getAttribute('data-tut') === '', 'manual nav clears the tutorial highlight');

// 8) management report shows the HD/AR/FD + Paid/AP/FP provenance under the cash lens
click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === 'report'));
ok(app.innerHTML.includes('数据构成') && app.innerHTML.includes('已实现（事实）') && app.innerHTML.includes('其中已订'), 'report shows HD/AR/FD cash-lens provenance table');

console.log('\n' + pass + ' dom assertions passed.\n');
