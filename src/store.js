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

  var STORAGE_KEY = 'kmty.finance.v3';
  var E = global.FFEngine; // engine loaded before this script

  // ---------- seeded default model (realistic demo data) ------------------
  function defaultModel() {
    var weeks = E.genWeeks('2026-02-17', '2027-02-05');
    // find the week covering 2026-05-26 (anchors the seeded actuals)
    var wTarget = 0;
    weeks.forEach(function (w, i) { if ('2026-05-26' >= w.startISO && '2026-05-26' <= w.endISO) wTarget = i; });

    var sales = {};
    var seedSales = { fx28: [1940, 32456], fx35: [4100, 102424], xj28: [2206, 30053], xj35: [17812, 314316], dn28: [613, 9203], dn35: [3720, 60496], cut: [1940, 9490] };
    Object.keys(seedSales).forEach(function (c) {
      var q = seedSales[c][0], a = seedSales[c][1];
      sales[wTarget + ':' + c + ':qty'] = '' + q;
      sales[wTarget + ':' + c + ':amt'] = '' + a;
    });

    var purch = {};
    var seedP = { pmmed: [3006, 22545, 1046.6], pmlarge: [1919, 23943, 687], pflwsmall: [2700, 40366, 1432.31], pflwlarge: [180, 3420, 0] };
    Object.keys(seedP).forEach(function (c) {
      var q = seedP[c][0], a = seedP[c][1], f = seedP[c][2];
      purch[wTarget + ':' + c + ':qty'] = '' + q;
      purch[wTarget + ':' + c + ':amt'] = '' + a;
      if (f) purch[wTarget + ':' + c + ':frt'] = '' + f;
    });

    // sample actuals for the seeded week, so forecast-vs-actual variance is visible
    var actualSeed = {};
    actualSeed[wTarget + ':foreign'] = '118000';
    actualSeed[wTarget + ':domestic'] = '372000';
    actualSeed[wTarget + ':payroll'] = '82000';
    actualSeed[wTarget + ':materials'] = '151000';
    actualSeed[wTarget + ':utilrent'] = '96000';

    return {
      page: 'dash',
      weekIdx: wTarget,
      config: { name: '昆明统一生物', startISO: '2026-02-17', endISO: '2027-02-05', asOfISO: '2026-06-10', unit: '万', openingBalance: '4227701.72' },
      assume: {
        priceDomLarge: '18.25', priceDomSmall: '15.07', priceForLarge: '19', priceForSmall: '16',
        priceCut: '7.5', priceDye: '40',
        collectInMonth: '0.7', collectPrior: '0.3',
        qtyForLarge: '24000', qtyForSmall: '8000', qtyDomLarge: '70000', qtyDomSmall: '12000', qtyDye: '5000', qtyCut: '14000',
        defectRate: '0.05',
        seedlingMonthly: '80000', seedlingPrice: '10',
        pkgCost: '1', prodCost: '0.8',
        payrollMonthly: '350000', utilitiesMonthly: '110000',
        freightMonthly: '100000', projectsMonthly: '30000', travelWeekly: '5000', loanMonthly: '45000'
      },
      rents: [
        { name: '大城村租金', amount: '340000', months: '5,11' },
        { name: '真善美租金', amount: '300000', months: '5,11' },
        { name: '砚山阿猛基地', amount: '160320', months: '6,11' },
        { name: '长松园租金', amount: '81944', months: '3' },
        { name: '小街基地', amount: '60350', months: '9' },
        { name: '斗南门市', amount: '126240', months: '1' }
      ],
      fixed: [
        { name: '房贷（季度）', amount: '45000', months: '1,4,7,10' },
        { name: '车辆保险', amount: '17000', months: '9,11' },
        { name: '人寿/意外险', amount: '11164', months: '10,12' },
        { name: '出口货物险', amount: '41109', months: '9' },
        { name: '软件/专利年费', amount: '11300', months: '3,7,11' }
      ],
      customers: [
        { name: '斗南门市批发', outstanding: '186000', note: '每周结算', cat: '省内' },
        { name: '小街基地走量客户', outstanding: '240000', note: '', cat: '省内' },
        { name: '俄罗斯出口客户', outstanding: '515000', note: '已到账未结汇', cat: '国外' },
        { name: '广东全美（转售）', outstanding: '78000', note: '', cat: '省外' },
        { name: '染色花经销商', outstanding: '44000', note: '', cat: '省内' },
        { name: '切花批发商', outstanding: '33000', note: '', cat: '国内' }
      ],
      assumeWeek: {}, customItems: [],
      seedPayables: [
        { supplier: '山东绿航', spec: '2.8寸成熟苗', qty: '41342', price: '7.5', payby: '2026-06-30', urgency: '三级', note: 'IQ26020' },
        { supplier: '和鸣花卉', spec: '3.5寸成熟苗', qty: '48904', price: '4.6', payby: '2026-06-27', urgency: '二级', note: 'IQ26042' },
        { supplier: '漳州新百盛', spec: '2.8寸成熟苗', qty: '126000', price: '6.97', payby: '2026-07-15', urgency: '四级', note: 'KMTYP-25040' },
        { supplier: '厦门品诚', spec: '2.8寸成熟苗', qty: '91000', price: '7.36', payby: '2026-07-31', urgency: '四级', note: 'KMTYP-25032' },
        { supplier: '汇海生物', spec: '瓶苗', qty: '10000', price: '12.4', payby: '2026-06-20', urgency: '三级', note: '1月出瓶款' },
        { supplier: '佛山润喆卉', spec: '3.5寸成熟苗', qty: '30000', price: '12', payby: '2026-08-10', urgency: '四级', note: 'KMTYP-25041' }
      ],
      sales: sales, purch: purch, fcst: {}, actual: actualSeed, collect: {}
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

  /* Backend adapter skeleton — wire this up when the Cloudflare Worker is
     ready (see README "后端路线图"). Kept here so the swap is one line.
     NOTE: load() is async; app.js boots from cache first then reconciles.

     function RemoteAdapter(baseUrl, token) { this.base = baseUrl; this.token = token; }
     RemoteAdapter.prototype.load = function () {
       return fetch(this.base + '/state', { headers: { Authorization: 'Bearer ' + this.token } })
         .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
     };
     RemoteAdapter.prototype.save = function (state) {
       return fetch(this.base + '/state', {
         method: 'PUT',
         headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.token },
         body: JSON.stringify(state)
       }).catch(function () {});
     };
  */

  // ---------- the store ----------------------------------------------------
  function Store(adapter) {
    this.adapter = adapter || new LocalStorageAdapter();
    this.subs = [];
    this._saveTimer = null;
    this.state = this._loadInitial();
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

  var api = { Store: Store, LocalStorageAdapter: LocalStorageAdapter, defaultModel: defaultModel, STORAGE_KEY: STORAGE_KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.FFStore = api;
})(typeof window !== 'undefined' ? window : globalThis);
