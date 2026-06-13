/* =====================================================================
 * store.js — application state + persistence seam
 * =====================================================================
 *
 * Holds the single source of truth (`state`), exposes mutators that the
 * UI calls, notifies subscribers (the renderer) on every change, and
 * persists through a swappable ADAPTER.
 *
 * Persistence seam (important for the China / Cloudflare roadmap):
 *   - Today:   LocalStorageAdapter  → autosaves to the browser.
 *   - Later:   RemoteAdapter        → POST/GET JSON to a Cloudflare
 *              Worker (D1/KV). The skeleton is included below; switching
 *              backends means changing ONE line in app.js (which adapter
 *              you pass to `new Store(...)`). The engine and UI never
 *              touch storage directly, so the swap is isolated here.
 * ===================================================================== */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'kmty.finance.v4'; // bumped from v3: abandons any cached state that still held seeded financials

  // local (not UTC) current date as YYYY-MM-DD — the default 截至 (as-of) day
  function todayISO() {
    var d = new Date(), m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  // ---------- seeded default model (BLANK template) -----------------------
  // Ships with NO financial figures. Balances, prices, quantities, rates,
  // costs, sales/purchases, actuals, and receivable/payable amounts + due
  // dates are all empty. What remains is the reusable STRUCTURE: the company
  // name, the fiscal window, product/channel specs, and the named
  // base/supplier/customer rows (identity + category + recurring-due months).
  // The user fills in last week's actuals first, and the forecast spins up
  // from there. (The rich demo dataset used by the regression suite lives in
  // test/fixtures.js so it never ships in the deployed app.)
  function defaultModel() {
    return {
      page: 'dash',
      weekIdx: 0,
      config: { name: '昆明统一生物', startISO: '2026-02-17', endISO: '2027-02-05', asOfISO: todayISO(), unit: '万', openingBalance: '' },
      assume: {
        priceDomLarge: '', priceDomSmall: '', priceForLarge: '', priceForSmall: '',
        priceCut: '', priceDye: '',
        collectInMonth: '', collectPrior: '',
        qtyForLarge: '', qtyForSmall: '', qtyDomLarge: '', qtyDomSmall: '', qtyDye: '', qtyCut: '',
        defectRate: '',
        seedlingMonthly: '', seedlingPrice: '',
        pkgCost: '', prodCost: '',
        payrollMonthly: '', utilitiesMonthly: '',
        freightMonthly: '', projectsMonthly: '', travelWeekly: '', loanMonthly: ''
      },
      rents: [
        { name: '大城村租金', amount: '', months: '5,11' },
        { name: '真善美租金', amount: '', months: '5,11' },
        { name: '砚山阿猛基地', amount: '', months: '6,11' },
        { name: '长松园租金', amount: '', months: '3' },
        { name: '小街基地', amount: '', months: '9' },
        { name: '斗南门市', amount: '', months: '1' }
      ],
      fixed: [
        { name: '房贷（季度）', amount: '', months: '1,4,7,10' },
        { name: '车辆保险', amount: '', months: '9,11' },
        { name: '人寿/意外险', amount: '', months: '10,12' },
        { name: '出口货物险', amount: '', months: '9' },
        { name: '软件/专利年费', amount: '', months: '3,7,11' }
      ],
      customers: [
        { name: '斗南门市批发', outstanding: '', note: '', cat: '省内' },
        { name: '小街基地走量客户', outstanding: '', note: '', cat: '省内' },
        { name: '俄罗斯出口客户', outstanding: '', note: '', cat: '国外' },
        { name: '广东全美（转售）', outstanding: '', note: '', cat: '省外' },
        { name: '染色花经销商', outstanding: '', note: '', cat: '省内' },
        { name: '切花批发商', outstanding: '', note: '', cat: '国内' }
      ],
      assumeWeek: {}, customItems: [],
      seedPayables: [
        { supplier: '山东绿航', spec: '2.8寸成熟苗', qty: '', price: '', payby: '', urgency: '三级', note: '' },
        { supplier: '和鸣花卉', spec: '3.5寸成熟苗', qty: '', price: '', payby: '', urgency: '三级', note: '' },
        { supplier: '漳州新百盛', spec: '2.8寸成熟苗', qty: '', price: '', payby: '', urgency: '三级', note: '' },
        { supplier: '厦门品诚', spec: '2.8寸成熟苗', qty: '', price: '', payby: '', urgency: '三级', note: '' },
        { supplier: '汇海生物', spec: '瓶苗', qty: '', price: '', payby: '', urgency: '三级', note: '' },
        { supplier: '佛山润喆卉', spec: '3.5寸成熟苗', qty: '', price: '', payby: '', urgency: '三级', note: '' }
      ],
      sales: {}, purch: {}, fcst: {}, actual: {}, collect: {}
    };
  }

  // ---------- persistence adapters ----------------------------------------
  // Each adapter implements: load() -> state|null   and   save(state).
  function LocalStorageAdapter(key) { this.key = key || STORAGE_KEY; }
  LocalStorageAdapter.prototype.load = function () {
    try { var s = localStorage.getItem(this.key); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  };
  LocalStorageAdapter.prototype.save = function (state) {
    try { localStorage.setItem(this.key, JSON.stringify(state)); } catch (e) {}
  };
  LocalStorageAdapter.prototype.clear = function () {
    try { localStorage.removeItem(this.key); } catch (e) {}
  };

  // Backend adapter: persists each authenticated user's workspace to the
  // Cloudflare Pages Function at /api/state (D1-backed). The session cookie is
  // sent automatically (same-origin). load() is a no-op here — app.js
  // prefetches the state right after authentication and hands it to the Store
  // constructor, so boot stays simple. Saves are fire-and-forget (debounced by
  // the store) and silently skipped when fetch is unavailable (e.g. tests).
  function RemoteAdapter() {}
  RemoteAdapter.prototype.load = function () { return null; };
  RemoteAdapter.prototype.save = function (state) {
    if (typeof fetch !== 'function') return;
    try {
      fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ state: state })
      }).catch(function () {});
    } catch (e) {}
  };

  // ---------- the store ----------------------------------------------------
  function Store(adapter, initialState) {
    this.adapter = adapter || new LocalStorageAdapter();
    this.subs = [];
    this._saveTimer = null;
    // When the caller already holds the state (e.g. fetched from the backend
    // after login), use it directly; otherwise load through the adapter.
    this.state = initialState != null ? initialState : this._loadInitial();
  }

  Store.prototype._loadInitial = function () {
    var d = defaultModel();
    var saved = null;
    try { saved = this.adapter.load(); } catch (e) {}
    if (!saved) return d;
    var merged = Object.assign({}, d, saved);
    merged.config = Object.assign({}, d.config, saved.config || {}); // guard new config keys
    return merged;
  };

  Store.prototype.subscribe = function (fn) {
    this.subs.push(fn);
    return function () { var i = this.subs.indexOf(fn); if (i >= 0) this.subs.splice(i, 1); }.bind(this);
  };
  Store.prototype._notify = function () {
    for (var i = 0; i < this.subs.length; i++) this.subs[i](this.state);
    this._persist();
  };
  Store.prototype._persist = function () {
    var self = this;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(function () { self.adapter.save(self.state); }, 250);
  };

  // generic top-level merge (page / weekIdx etc.)
  Store.prototype.set = function (partial) { Object.assign(this.state, partial); this._notify(); };

  // map editors: state[map][key] = val
  Store.prototype.editMap = function (map, key, val) {
    var m = Object.assign({}, this.state[map]); m[key] = val; this.state[map] = m; this._notify();
  };
  Store.prototype.editConfig = function (key, val) { this.editMap('config', key, val); };

  // array editors: state[arr][idx][key] = val
  Store.prototype.editArr = function (arr, idx, key, val) {
    var a = this.state[arr].map(function (x, i) {
      if (i !== idx) return x; var c = Object.assign({}, x); c[key] = val; return c;
    });
    this.state[arr] = a; this._notify();
  };

  Store.prototype.addRow = function (arr) {
    var tmpl;
    if (arr === 'customers') tmpl = { name: '新客户', outstanding: '0', note: '', cat: '国内' };
    else if (arr === 'seedPayables') tmpl = { supplier: '新供应商', spec: '', qty: '0', price: '0', payby: '', urgency: '三级', note: '' };
    else tmpl = { name: '新条目', amount: '0', months: '' };
    this.state[arr] = this.state[arr].concat([tmpl]); this._notify();
  };
  Store.prototype.delRow = function (arr, idx) {
    this.state[arr] = this.state[arr].filter(function (_, k) { return k !== idx; }); this._notify();
  };

  Store.prototype.addAssumeItem = function (group) {
    var expense = ['seed', 'material', 'opex'].indexOf(group) >= 0;
    var id = 'c_' + Math.random().toString(36).slice(2, 8);
    var unit = group === 'price' ? '元/株' : group === 'collect' ? '比例' : group === 'volume' ? '株/月' : expense ? '元/月' : '';
    this.state.customItems = this.state.customItems.concat([
      { id: id, group: group, name: '新项目', unit: unit, kind: expense ? 'monthlyExpense' : 'reference' }
    ]);
    this._notify();
  };
  Store.prototype.delCustom = function (id) {
    this.state.customItems = this.state.customItems.filter(function (x) { return x.id !== id; });
    this._notify();
  };

  Store.prototype.selectWeek = function (idx) { this.state.weekIdx = idx; this._notify(); };
  Store.prototype.setPage = function (page) { this.state.page = page; this._notify(); };
  Store.prototype.toggleUnit = function () { this.editConfig('unit', this.state.config.unit === '万' ? '元' : '万'); };

  Store.prototype.reset = function () {
    if (this.adapter.clear) this.adapter.clear();
    this.state = defaultModel(); this._notify();
  };

  var api = { Store: Store, LocalStorageAdapter: LocalStorageAdapter, RemoteAdapter: RemoteAdapter, defaultModel: defaultModel, STORAGE_KEY: STORAGE_KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.FFStore = api;
})(typeof window !== 'undefined' ? window : globalThis);
