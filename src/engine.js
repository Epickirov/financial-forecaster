/* =====================================================================
 * engine.js — pure forecasting engine (no DOM, no I/O, no framework)
 * =====================================================================
 *
 * The "calculation spine" of the whole system:
 *
 *     周末余额 = 周初余额 + 本周收款 − 本周支出   (chained week to week)
 *     Week 1's opening balance = the fiscal-year opening balance.
 *
 * The fiscal year is split into ~50 weeks. An "as-of" date divides
 * elapsed weeks (where the user keys in ACTUALS) from future weeks
 * (computed from ASSUMPTIONS). History + Forecast = the full-year view.
 *
 * Every function here is pure: it takes the `state` object and returns
 * numbers/objects. That makes the model trivially unit-testable in Node
 * (see test/engine.test.js) and keeps it independent of how the data is
 * stored (localStorage today, a Cloudflare Worker / D1 tomorrow).
 * ===================================================================== */
(function (global) {
  'use strict';

  var WPM = 4.333; // average weeks per month

  // ---- channel × size sales rows (历史数据 · 销售明细) -------------------
  var SALESCATS = [
    { id: 'mp',   name: '苗',                grp: '苗' },
    { id: 'fx28', name: '国外 2.8/3寸',      grp: '国外' },
    { id: 'fx35', name: '国外 3.5寸',        grp: '国外' },
    { id: 'xj28', name: '小街 2.8/3寸',      grp: '国内' },
    { id: 'xj35', name: '小街 3.5寸',        grp: '国内' },
    { id: 'dn28', name: '斗南 2.8/3寸',      grp: '国内' },
    { id: 'dn35', name: '斗南 3.5/3.8寸',    grp: '国内' },
    { id: 'ys28', name: '砚山 2.8/3寸',      grp: '国内' },
    { id: 'ys35', name: '砚山 3.5/3.8寸',    grp: '国内' },
    { id: 'dye28', name: '染色花 2.8寸',     grp: '染色' },
    { id: 'dye30', name: '染色花 3.0寸',     grp: '染色' },
    { id: 'dye35', name: '染色花 3.5/3.8寸', grp: '染色' },
    { id: 'cut',  name: '切花',              grp: '切花' }
  ];

  // ---- purchasing rows (历史数据 · 进货验货) ----------------------------
  var PURCHCATS = [
    { id: 'pmsmall', name: '小苗' }, { id: 'pmmed', name: '中苗' }, { id: 'pmlarge', name: '大苗' },
    { id: 'pcmed', name: '代养中苗' }, { id: 'pclarge', name: '代养大苗' },
    { id: 'pflwsmall', name: '小花' }, { id: 'pflwlarge', name: '大花' }
  ];

  // ---- cash payment categories (drive 全年支出 / the expense donut) ------
  var PAYCATS = ['seedling', 'flowering', 'loan', 'payroll', 'utilrent', 'projects', 'materials', 'travel', 'custom'];

  // receipt + payment line definitions shared by 历史/预测 panels
  var RECEIPT_DEFS = [['foreign', '国外收款'], ['domestic', '国内收款']];
  var PAY_ROW_DEFS = [
    ['seedling', '苗款'], ['flowering', '开花株款'], ['payroll', '工资社保税费'],
    ['utilrent', '水电与租金'], ['projects', '项目及工程'], ['materials', '生产物资运费'],
    ['travel', '差旅招待加油伙食'], ['loan', '归还借款 / 固定支出'], ['custom', '其他自定义支出']
  ];

  var PAY_NAMES = {
    seedling: '苗款', flowering: '开花株款', payroll: '工资社保', utilrent: '水电租金',
    materials: '物资运费', projects: '工程项目', loan: '借款/固定', travel: '差旅其他', custom: '其他自定义'
  };
  var PAY_COLORS = {
    seedling: '#c96442', flowering: '#b5862f', payroll: '#4e7c4f', utilrent: '#dd8a63',
    materials: '#b07a52', projects: '#e0a079', loan: '#7c3a23', travel: '#f0cdb8', custom: '#a3886a'
  };

  var URGENCY_OPTIONS = ['一级', '二级', '三级', '四级'];
  var URGENCY_COLORS = { '一级': '#e8b84b', '二级': '#b9a7b3', '三级': '#5fb88a', '四级': '#6b9bd1' };
  var AR_CATS = ['国外', '国内', '省内', '省外'];
  var AR_CAT_COLORS = { '国外': '#b5862f', '国内': '#c96442', '省内': '#4e7c4f', '省外': '#dd8a63' };

  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

  // ---------- week grid ----------------------------------------------------
  function genWeeks(startISO, endISO) {
    var iso = function (d) { return d.toISOString().slice(0, 10); };
    var md = function (d) { return (d.getMonth() + 1) + '.' + d.getDate(); };
    var start = new Date(startISO + 'T00:00:00'), end = new Date(endISO + 'T00:00:00');
    var weeks = [], cur = new Date(start), i = 0;
    while (cur <= end && i < 60) {
      var ws = new Date(cur), we = new Date(cur); we.setDate(we.getDate() + 6);
      if (we > end) we.setTime(end.getTime());
      weeks.push({ idx: i, startISO: iso(ws), endISO: iso(we), label: md(ws) + '–' + md(we), month: ws.getMonth() + 1 });
      cur.setDate(cur.getDate() + 7); i++;
    }
    return weeks;
  }
  function weeks(state) { return genWeeks(state.config.startISO, state.config.endISO); }

  // the "current" week = the one containing the as-of date (the 今天 line).
  // Used for dashboard rollups that should mean "this week", independent of
  // whatever week happens to be selected on another page.
  function currentWeekIdx(state) {
    var W = weeks(state), asOf = state.config.asOfISO;
    for (var i = 0; i < W.length; i++) { if (asOf >= W[i].startISO && asOf <= W[i].endISO) return i; }
    if (W.length && asOf < W[0].startISO) return 0;
    return Math.max(W.length - 1, 0);
  }

  // ---------- per-week assumptions with carry-forward ----------------------
  // latest override on week <= wIdx that defines `id`, else the base assumption.
  function effA(state, wIdx, id) {
    var aw = state.assumeWeek || {};
    for (var w = wIdx; w >= 0; w--) {
      var k = w + ':' + id;
      if (aw[k] !== undefined && aw[k] !== '') return aw[k];
    }
    return (state.assume || {})[id];
  }
  // value inherited from BEFORE wIdx (for the "继承 X" placeholder)
  function inheritedA(state, wIdx, id) {
    var aw = state.assumeWeek || {};
    for (var w = wIdx - 1; w >= 0; w--) {
      var k = w + ':' + id;
      if (aw[k] !== undefined && aw[k] !== '') return aw[k];
    }
    return (state.assume || {})[id];
  }
  function effAN(state, wIdx, id) { return num(effA(state, wIdx, id)); }

  // monthly schedule (rents / fixed): sum amounts whose 到期月份 includes m
  function monthlyFrom(list, m) {
    return (list || []).reduce(function (s, r) {
      var months = String(r.months).split(',').map(function (x) { return parseInt(x.trim(), 10); });
      return months.indexOf(m) >= 0 ? s + num(r.amount) : s;
    }, 0);
  }

  // 苗款: committed payable cash falling inside a week (drives timing from the register)
  function seedDueInWeek(state, wIdx) {
    var W = weeks(state), wk = W[wIdx]; if (!wk) return 0;
    return (state.seedPayables || []).reduce(function (s, p) {
      if (p.payby && p.payby >= wk.startISO && p.payby <= wk.endISO) return s + num(p.qty) * num(p.price);
      return s;
    }, 0);
  }

  // 应收账款: per-week expected collection recorded against customers (custIdx:weekIdx).
  // This is an explicit, opt-in SOURCE of the forecast's 国内收款 (it represents
  // collecting OLD outstanding receivables, distinct from new-sales collection).
  function arCollectInWeek(state, wIdx) {
    var collect = state.collect || {};
    return (state.customers || []).reduce(function (s, c, i) {
      return s + num(collect[i + ':' + wIdx]);
    }, 0);
  }

  // ---------- the assumption-driven forecast for ONE week ------------------
  function computed(state, wIdx) {
    var W = weeks(state), wk = W[wIdx] || W[0];
    var m = wk.month;
    var g = function (id) { return effAN(state, wIdx, id); };
    var keep = 1 - g('defectRate'); // 预测淘汰率 reduces sellable quantity

    var qFL = g('qtyForLarge') * keep, qFS = g('qtyForSmall') * keep;
    var qDL = g('qtyDomLarge') * keep, qDS = g('qtyDomSmall') * keep,
        qDye = g('qtyDye') * keep, qCut = g('qtyCut') * keep;
    var totalQ = qFL + qFS + qDL + qDS + qDye + qCut;
    var volW = totalQ / WPM;

    // revenue by channel × size → 国外 / 国内 collection (monthly → weekly)
    var foreignMonthly = qFL * g('priceForLarge') + qFS * g('priceForSmall');
    var domMonthly = qDL * g('priceDomLarge') + qDS * g('priceDomSmall') +
                     qDye * g('priceDye') + qCut * g('priceCut');
    var collectRate = g('collectInMonth') + g('collectPrior');

    var foreign = foreignMonthly / WPM;
    var domSales = domMonthly / WPM * collectRate;          // collection from NEW sales
    var arCollect = arCollectInWeek(state, wIdx);           // collection of OLD receivables
    var domestic = domSales + arCollect;                    // <-- 应收账款 now feeds 国内收款

    // 苗款: committed payable due this week, else assumption baseline
    var due = seedDueInWeek(state, wIdx);
    var seedling = due > 0 ? due : g('seedlingMonthly') / WPM * g('seedlingPrice');
    var flowering = volW * 0.12 * g('priceDomLarge') * 0.2;
    var payroll = g('payrollMonthly') / WPM;
    var utilrent = g('utilitiesMonthly') / WPM + monthlyFrom(state.rents, m) / WPM;
    var projects = g('projectsMonthly') / WPM;
    var materials = volW * (g('pkgCost') + g('prodCost')) + g('freightMonthly') / WPM;
    var travel = g('travelWeekly');
    var loan = g('loanMonthly') / WPM + monthlyFrom(state.fixed, m) / WPM;

    var custom = 0;
    (state.customItems || []).forEach(function (it) {
      var v = effAN(state, wIdx, it.id);
      if (it.kind === 'monthlyExpense') custom += v / WPM;
      else if (it.kind === 'weeklyExpense') custom += v;
    });

    return {
      foreign: foreign, domestic: domestic, seedling: seedling, flowering: flowering,
      payroll: payroll, utilrent: utilrent, projects: projects, materials: materials,
      travel: travel, loan: loan, custom: custom,
      // breakdown helpers (not part of the cash spine, used by 收款测算)
      _domSales: domSales, _arCollect: arCollect, _domMonthly: domMonthly, _collectRate: collectRate, _keep: keep
    };
  }

  // ---------- elapsed vs future, and the actual/forecast/effective ladder --
  function isHist(state, wIdx) {
    var w = weeks(state)[wIdx];
    return !!(w && w.endISO <= state.config.asOfISO);
  }
  // forecast value: manual override on 预测 page, else assumption-computed
  function fcOf(state, wIdx, field) {
    var k = wIdx + ':' + field, v = (state.fcst || {})[k];
    if (v !== undefined && v !== '') { var p = parseFloat(v); return isNaN(p) ? 0 : p; }
    return computed(state, wIdx)[field] || 0;
  }
  // actual value (历史数据), or null if not yet keyed in
  function acOf(state, wIdx, field) {
    var k = wIdx + ':' + field, v = (state.actual || {})[k];
    if (v === undefined || v === '') return null;
    var p = parseFloat(v); return isNaN(p) ? null : p;
  }
  // effective value used in series/dashboard: ACTUAL once entered for an
  // elapsed week, otherwise the FORECAST. This is the core "real data
  // replaces the assumption as time elapses" mechanic.
  function eff(state, wIdx, field) {
    if (isHist(state, wIdx)) { var a = acOf(state, wIdx, field); if (a !== null) return a; }
    return fcOf(state, wIdx, field);
  }

  // ---------- the full-year series (the cash spine) ------------------------
  function series(state) {
    var W = weeks(state), cfg = state.config;
    var bal = num(cfg.openingBalance);
    return W.map(function (w, i) {
      var open = bal;
      var cin = eff(state, i, 'foreign') + eff(state, i, 'domestic');
      var pays = PAYCATS.reduce(function (s, c) { return s + eff(state, i, c); }, 0);
      var close = open + cin - pays;
      bal = close;
      return { i: i, w: w, open: open, cin: cin, pays: pays, close: close, net: cin - pays, isHist: w.endISO <= cfg.asOfISO };
    });
  }

  // pure-forecast closing balances (the dotted line / variance baseline,
  // runs across the WHOLE year ignoring actuals)
  function forecastCloses(state) {
    var W = weeks(state), bal = num(state.config.openingBalance), out = [];
    for (var i = 0; i < W.length; i++) {
      var open = bal;
      var cin = fcOf(state, i, 'foreign') + fcOf(state, i, 'domestic');
      var pays = PAYCATS.reduce(function (s, c) { return s + fcOf(state, i, c); }, 0);
      var close = open + cin - pays;
      bal = close; out.push(close);
    }
    return out;
  }

  // ---------- formatting ---------------------------------------------------
  function fmt(state, y) {
    if (state.config.unit === '万') {
      return (y / 10000).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '万';
    }
    return '¥' + Math.round(y).toLocaleString('zh-CN');
  }
  function wan(y, d) { if (d === undefined) d = 1; return (y / 10000).toFixed(d); }
  function yuan0(v) { return Math.round(v).toLocaleString('zh-CN'); }

  // ---------- donut geometry (pure SVG path maths) -------------------------
  function donut(items, cx, cy, rO, rI) {
    var tot = items.reduce(function (s, x) { return s + x.v; }, 0) || 1;
    var ang = -Math.PI / 2;
    return items.map(function (it) {
      var sweep = it.v / tot * Math.PI * 2, a2 = ang + sweep, large = sweep > Math.PI ? 1 : 0;
      var p = function (r, an) { return [(cx + r * Math.cos(an)).toFixed(2), (cy + r * Math.sin(an)).toFixed(2)]; };
      var s1 = p(rO, ang), s2 = p(rO, a2), s3 = p(rI, a2), s4 = p(rI, ang);
      var d = 'M' + s1[0] + ',' + s1[1] + ' A' + rO + ',' + rO + ' 0 ' + large + ' 1 ' + s2[0] + ',' + s2[1] +
              ' L' + s3[0] + ',' + s3[1] + ' A' + rI + ',' + rI + ' 0 ' + large + ' 0 ' + s4[0] + ',' + s4[1] + ' Z';
      var pct = (it.v / tot * 100).toFixed(0) + '%';
      ang = a2;
      return { k: it.k, color: it.color, d: d, pct: pct };
    });
  }

  var Engine = {
    WPM: WPM,
    SALESCATS: SALESCATS, PURCHCATS: PURCHCATS, PAYCATS: PAYCATS,
    RECEIPT_DEFS: RECEIPT_DEFS, PAY_ROW_DEFS: PAY_ROW_DEFS,
    PAY_NAMES: PAY_NAMES, PAY_COLORS: PAY_COLORS,
    URGENCY_OPTIONS: URGENCY_OPTIONS, URGENCY_COLORS: URGENCY_COLORS,
    AR_CATS: AR_CATS, AR_CAT_COLORS: AR_CAT_COLORS,
    num: num,
    genWeeks: genWeeks, weeks: weeks, currentWeekIdx: currentWeekIdx,
    effA: effA, inheritedA: inheritedA, effAN: effAN,
    monthlyFrom: monthlyFrom, seedDueInWeek: seedDueInWeek, arCollectInWeek: arCollectInWeek,
    computed: computed, isHist: isHist, fcOf: fcOf, acOf: acOf, eff: eff,
    series: series, forecastCloses: forecastCloses,
    fmt: fmt, wan: wan, yuan0: yuan0, donut: donut
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Engine; // Node tests
  else global.FFEngine = Engine;                                               // browser
})(typeof window !== 'undefined' ? window : globalThis);
