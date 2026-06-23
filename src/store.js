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

  // current date in China Standard Time (UTC+8, no DST) as YYYY-MM-DD — the
  // default 截至 (as-of) day. Computed from the UTC epoch + 8h and read via
  // getUTC*, so it's correct no matter what timezone the viewer's device uses.
  function todayISO() {
    var cst = new Date(Date.now() + 8 * 3600000);
    var m = cst.getUTCMonth() + 1, day = cst.getUTCDate();
    return cst.getUTCFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
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
      config: { name: '昆明统一生物', fyMode: 'auto', startISO: '2026-02-17', endISO: '2027-02-05', asOfISO: todayISO(), asOfManual: false, unit: '万', openingBalance: '' },
      assume: {
        priceForLarge: '', priceForSmall: '', priceForDye: '', priceForCut: '',
        priceDomLarge: '', priceDomSmall: '', priceDomDye: '', priceDomCut: '',
        collectInWeek: '',
        qtyForLarge: '', qtyForSmall: '', qtyForDye: '', qtyForCut: '',
        qtyDomLarge: '', qtyDomSmall: '', qtyDomDye: '', qtyDomCut: '',
        defectRate: '',
        huaAmount: '', miaoAmount: '', bottleAmount: '',
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
      assumeWeek: {}, customItems: [],
      shipments: [
        { id: 'sh_a', type: '苗', channel: '国内', supplier: '山东绿航', spec: '2.8寸成熟苗', qty: '', amount: '', iq: '', freight: '', freightWeek: '' },
        { id: 'sh_b', type: '苗', channel: '国内', supplier: '和鸣花卉', spec: '3.5寸成熟苗', qty: '', amount: '', iq: '', freight: '', freightWeek: '' },
        { id: 'sh_c', type: '苗', channel: '国内', supplier: '漳州新百盛', spec: '2.8寸成熟苗', qty: '', amount: '', iq: '', freight: '', freightWeek: '' },
        { id: 'sh_d', type: '花', channel: '国内', supplier: '佛山润喆卉', spec: '3.5寸开花株', qty: '', amount: '', iq: '', freight: '', freightWeek: '' }
      ],
      suppliers: [
        { id: 'sup_a', name: '山东绿航' }, { id: 'sup_b', name: '和鸣花卉' },
        { id: 'sup_c', name: '漳州新百盛' }, { id: 'sup_d', name: '佛山润喆卉' }
      ],
      payables: [], ar: {},
      sales: {}, fcst: {}, actual: {}
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
    // 今日/截至 tracks the real current date (China time) unless the user pinned it
    if (!merged.config.asOfManual) merged.config.asOfISO = todayISO();
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
    this._saveTimer = setTimeout(function () { self.adapter.save(self.state); }, 600);
  };

  // generic top-level merge (page / weekIdx etc.)
  Store.prototype.set = function (partial) { Object.assign(this.state, partial); this._notify(); };

  // map editors: state[map][key] = val
  Store.prototype.editMap = function (map, key, val) {
    var m = Object.assign({}, this.state[map]); m[key] = val; this.state[map] = m; this._notify();
  };
  Store.prototype.editConfig = function (key, val) {
    // editing 截至 pins it: from now on it stays put instead of tracking today
    if (key === 'asOfISO') {
      var c = Object.assign({}, this.state.config); c.asOfISO = val; c.asOfManual = true;
      this.state.config = c; this._notify(); return;
    }
    this.editMap('config', key, val);
  };

  // array editors: state[arr][idx][key] = val
  Store.prototype.editArr = function (arr, idx, key, val) {
    var a = this.state[arr].map(function (x, i) {
      if (i !== idx) return x; var c = Object.assign({}, x); c[key] = val; return c;
    });
    this.state[arr] = a; this._notify();
  };

  Store.prototype.addRow = function (arr, seed) {
    var tmpl;
    if (arr === 'suppliers') tmpl = { id: 'sup_' + Math.random().toString(36).slice(2, 8), name: '新供应商' };
    else if (arr === 'shipments') tmpl = { id: 'sh_' + Math.random().toString(36).slice(2, 8), type: '苗', channel: '国内', supplier: '', spec: '', qty: '', amount: '', iq: '', freight: '', freightWeek: '', freightPaid: false };
    else if (arr === 'payables') tmpl = { id: 'p_' + Math.random().toString(36).slice(2, 8), shipmentId: '', payWeek: '', amount: '', urgency: '三级', paid: false };
    else tmpl = { name: '新条目', amount: '', months: '' };
    if (seed) { for (var k in seed) tmpl[k] = seed[k]; }
    this.state[arr] = (this.state[arr] || []).concat([tmpl]); this._notify();
  };
  Store.prototype.delRow = function (arr, idx) {
    this.state[arr] = this.state[arr].filter(function (_, k) { return k !== idx; }); this._notify();
  };

  Store.prototype.addAssumeItem = function (group) {
    // Custom items are only meaningful in EXPENSE groups (they feed 其他自定义 cash).
    // 销售单价/回款节奏/销量 build revenue from a fixed product recipe with no slot for
    // a freeform row, so a custom item there would be orphaned — refuse it.
    if (['seed', 'material', 'opex'].indexOf(group) < 0) return;
    var id = 'c_' + Math.random().toString(36).slice(2, 8);
    this.state.customItems = this.state.customItems.concat([
      { id: id, group: group, name: '新项目', unit: '元', kind: 'weeklyExpense' }   // per-week, like the rest of 假设
    ]);
    this._notify();
  };
  Store.prototype.delCustom = function (id) {
    this.state.customItems = this.state.customItems.filter(function (x) { return x.id !== id; });
    this._notify();
  };

  // 农历财年 mode: 'auto' lets the engine derive the window from the lunar calendar;
  // 'manual' uses stored start/end dates. Switching to manual seeds those dates from
  // the currently-displayed (computed) window so editing starts from the right place.
  Store.prototype.setFyMode = function (mode, seedStart, seedEnd) {
    var c = Object.assign({}, this.state.config);
    c.fyMode = (mode === 'manual') ? 'manual' : 'auto';
    if (c.fyMode === 'manual' && seedStart && seedEnd) { c.startISO = seedStart; c.endISO = seedEnd; }
    this.state.config = c; this._notify();
  };
  // 截至(今日) mode: 'auto' tracks China-today (unpinned); 'manual' pins the stored date.
  Store.prototype.setAsOfMode = function (mode) {
    var c = Object.assign({}, this.state.config);
    if (mode === 'manual') { c.asOfManual = true; }
    else { c.asOfManual = false; c.asOfISO = todayISO(); }
    this.state.config = c; this._notify();
  };

  Store.prototype.selectWeek = function (idx) { this.state.weekIdx = idx; this._notify(); };
  Store.prototype.setPage = function (page) { this.state.page = page; this._notify(); };
  Store.prototype.toggleUnit = function () { this.editConfig('unit', this.state.config.unit === '万' ? '元' : '万'); };

  Store.prototype.reset = function () {
    if (this.adapter.clear) this.adapter.clear();
    this.state = defaultModel(); this._notify();
  };

  var api = { Store: Store, LocalStorageAdapter: LocalStorageAdapter, RemoteAdapter: RemoteAdapter, defaultModel: defaultModel, todayISO: todayISO, STORAGE_KEY: STORAGE_KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.FFStore = api;
})(typeof window !== 'undefined' ? window : globalThis);
