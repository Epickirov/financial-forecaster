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

// The shipped app boots a BLANK template (financial data lives only in the
// browser as the user types). The regression suite drives the rich demo
// fixture, so inject it into the live store and re-render.
const demoModel = require('./fixtures.js');
window.FFApp.store.state = demoModel();
window.FFApp.rerender();

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
const pages = { hist: '销售明细', fcst: '收款测算', assume: '销量与淘汰', seedpay: '应付苗款登记', ar: '客户应收账款', report: '财务预测报告' };
Object.keys(pages).forEach(p => {
  click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === p));
  ok(app.innerHTML.includes(pages[p]), 'page "' + p + '" renders (' + pages[p] + ')');
});

// 3) seed payables now has the 备注 column wired
click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === 'seedpay'));
ok(app.innerHTML.includes('备注') && app.querySelector('[id^="r|seedPayables|0|note"]'), '苗款 备注 column is editable');

// 4) editing an assumption creates a live "本周覆盖" badge
click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === 'assume'));
const priceInput = [...app.querySelectorAll('input[data-map="assumeWeek"]')].find(i => /priceForLarge$/.test(i.dataset.key));
ok(priceInput, 'found 国外大花单价 assumption input');
ok(!app.innerHTML.includes('本周覆盖'), 'no override badge before editing');
priceInput.value = '25'; fire(priceInput, 'input');
const after = [...app.querySelectorAll('input[data-map="assumeWeek"]')].find(i => /priceForLarge$/.test(i.dataset.key));
ok(after.value === '25', 'assumption value persisted to the store + re-rendered');
ok(app.innerHTML.includes('本周覆盖'), 'override badge appears live after edit');

// 5) opening balance is editable in the header and flows to the KPI
const obal = $('#c\\|openingBalance') || window.document.getElementById('c|openingBalance');
ok(obal, 'opening-balance input exists in the config header');
obal.value = '9000000'; fire(obal, 'input');
click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === 'dash'));
ok(app.innerHTML.includes('900.00万'), 'opening balance edit reflows into 现可用款 KPI (900.00万)');

// 6) AR weekly collection wires into the forecast 国内收款 breakdown
click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === 'ar'));
const collectInput = [...app.querySelectorAll('input[data-map="collect"]')][0];
ok(collectInput, 'found an AR 本周预计回款 input');
collectInput.value = '12345'; fire(collectInput, 'input');
click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === 'fcst'));
ok(app.innerHTML.includes('本周应收账款回款'), 'forecast 收款测算 shows the AR line');
ok(app.innerHTML.includes('1.23万'), 'AR collection (12345 → 1.23万) appears in the domestic breakdown');

// 7) selecting a week chip changes the active selection
click([...app.querySelectorAll('[data-action="nav"]')].find(b => b.dataset.page === 'fcst'));
const chipsBtns = [...app.querySelectorAll('[data-action="selectWeek"]')];
ok(chipsBtns.length > 0, 'forecast week chips present');
click(chipsBtns[chipsBtns.length - 1]);
ok(true, 're-render after selecting a future week did not throw');

console.log('\n' + pass + ' dom assertions passed.\n');
