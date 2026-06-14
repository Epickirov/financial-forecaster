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

  // ---- payables model: product type (苗/花) × supplier channel (国内/国外) -
  var CHANNELS = ['国内', '国外'];
  var PTYPES = [{ id: '苗', label: '苗款' }, { id: '花', label: '开花株款' }];

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

  // ---------- shipments (进货验货) & payables (苗/花应付款) ----------------
  function shipmentById(state, id) {
    var L = state.shipments || [];
    for (var i = 0; i < L.length; i++) if (L[i].id === id) return L[i];
    return null;
  }
  function shipUnit(sh) { if (!sh) return 0; var q = num(sh.qty); return q > 0 ? num(sh.amount) / q : 0; } // 单价 = 金额 / 数量
  // a payable's type / channel / supplier / spec / iq / qty are inherited from its shipment
  function payableMeta(state, p) {
    var sh = shipmentById(state, p.shipmentId) || {};
    return { type: sh.type || '苗', channel: sh.channel || '国内', supplier: sh.supplier || '', spec: sh.spec || '', iq: sh.iq || '', qty: sh.qty != null ? sh.qty : '' };
  }
  // payable amount: explicit override (for splitting / partial pay), else the full shipment amount
  function payableAmt(state, p) {
    if (p.amount !== undefined && p.amount !== '' && p.amount !== null) return num(p.amount);
    var sh = shipmentById(state, p.shipmentId);
    return sh ? num(sh.amount) : 0;
  }
  function payWeekOf(p) { var w = parseInt(p.payWeek, 10); return isNaN(w) ? null : w; }

  // total payables due in a given week (optionally filtered by 苗/花)
  function dueInWeek(state, wIdx, type) {
    return (state.payables || []).reduce(function (s, p) {
      if (payWeekOf(p) !== wIdx) return s;
      if (type && payableMeta(state, p).type !== type) return s;
      return s + payableAmt(state, p);
    }, 0);
  }
  // shipment freight (物流成本) charged to the cash flow in the week it is paid
  function freightDueInWeek(state, wIdx) {
    return (state.shipments || []).reduce(function (s, sh) {
      var w = parseInt(sh.freightWeek, 10);
      return (!isNaN(w) && w === wIdx) ? s + num(sh.freight) : s;
    }, 0);
  }
  // index of the last week sharing the month of weeks[fromIdx]
  function lastWeekOfMonth(state, fromIdx) {
    var W = weeks(state); if (!W[fromIdx]) return fromIdx;
    var m = W[fromIdx].month, last = fromIdx;
    for (var i = fromIdx; i < W.length; i++) { if (W[i].month === m) last = i; else break; }
    return last;
  }
  // payables of a type summed by 渠道 × time-bucket × 紧急度.
  // buckets (cumulative, not mutually exclusive): overdue(逾期) / thisWeek / nextWeek /
  // thisMonth(this week → last week of current month) / total(all outstanding).
  function payableBuckets(state, type) {
    var cw = currentWeekIdx(state), lwm = lastWeekOfMonth(state, cw), out = {};
    var BUCKETS = ['overdue', 'thisWeek', 'nextWeek', 'thisMonth', 'total'];
    CHANNELS.forEach(function (ch) {
      out[ch] = { _t: {} };
      BUCKETS.forEach(function (b) { out[ch][b] = {}; out[ch]._t[b] = 0; URGENCY_OPTIONS.forEach(function (u) { out[ch][b][u] = 0; }); });
    });
    (state.payables || []).forEach(function (p) {
      var m = payableMeta(state, p); if (type && m.type !== type) return;
      var ch = m.channel; if (!out[ch]) return;
      var amt = payableAmt(state, p), u = URGENCY_OPTIONS.indexOf(p.urgency) >= 0 ? p.urgency : '三级', w = payWeekOf(p);
      function add(b) { out[ch][b][u] += amt; out[ch]._t[b] += amt; }
      add('total');
      if (w === null) return;
      if (w < cw) add('overdue');
      if (w === cw) add('thisWeek');
      if (w === cw + 1) add('nextWeek');
      if (w >= cw && w <= lwm) add('thisMonth');
    });
    return out;
  }

  // 销售明细 → 收款: 国外 channels sum into foreign, everything else into domestic
  function salesReceipts(state, wIdx) {
    var sales = state.sales || {}, foreign = 0, domestic = 0;
    SALESCATS.forEach(function (c) {
      var a = num(sales[wIdx + ':' + c.id + ':amt']);
      if (c.grp === '国外') foreign += a; else domestic += a;
    });
    return { foreign: foreign, domestic: domestic };
  }

  // 应收账款: each AR shipment (已出货货值) collects on its OWN timeline.
  // Collection week resolves, in order:
  //   (1) explicit per-shipment override (collectWeek), else
  //   (2) 出货周 + the customer-category 账期 (editable in 假设·回款节奏; else a
  //       sensible default), else
  //   (3) the per-customer 回款周 as a fallback (date-less legacy rows).
  // 国外 customers feed 国外收款; everyone else feeds 国内收款.
  var AR_LAG_KEY = { '国外': 'lagForeign', '国内': 'lagDomestic', '省内': 'lagProvIn', '省外': 'lagProvOut' };
  var AR_LAG_DEFAULT = { '国外': 4, '国内': 2, '省内': 2, '省外': 2 };

  function customerById(state, id) {
    var L = state.customers || [];
    for (var i = 0; i < L.length; i++) if (L[i].id === id) return L[i];
    return null;
  }
  function customerOutstanding(state, custId) {
    return (state.arShipments || []).reduce(function (s, sh) { return sh.custId === custId ? s + num(sh.value) : s; }, 0);
  }
  // index of the week containing an ISO date (week 0 if earlier; null if past the horizon)
  function weekIdxOf(state, iso) {
    if (!iso) return null;
    var W = weeks(state);
    for (var i = 0; i < W.length; i++) { if (iso >= W[i].startISO && iso <= W[i].endISO) return i; }
    return (W.length && iso < W[0].startISO) ? 0 : null;
  }
  // collection 账期 (weeks) for a category, effective at week `atWeek`
  function arLag(state, cat, atWeek) {
    var v = effA(state, atWeek == null ? 0 : atWeek, AR_LAG_KEY[cat] || 'lagDomestic');
    if (v !== undefined && v !== '' && !isNaN(parseFloat(v))) return parseInt(v, 10);
    return AR_LAG_DEFAULT[cat] != null ? AR_LAG_DEFAULT[cat] : 2;
  }
  // resolved collection week for ONE AR shipment (null = unscheduled)
  function arCollectWeek(state, sh) {
    if (sh.collectWeek !== undefined && sh.collectWeek !== '' && sh.collectWeek !== null) {
      var ov = parseInt(sh.collectWeek, 10); if (!isNaN(ov)) return ov;
    }
    var cust = customerById(state, sh.custId), cat = (cust && cust.cat) || '国内';
    var sw = weekIdxOf(state, sh.date);
    if (sw != null) return sw + arLag(state, cat, sw);
    if (cust && cust.collectWeek !== '' && cust.collectWeek != null) {
      var cw = parseInt(cust.collectWeek, 10); if (!isNaN(cw)) return cw;
    }
    return null;
  }
  function arDueInWeek(state, wIdx) {
    var foreign = 0, domestic = 0;
    (state.arShipments || []).forEach(function (sh) {
      if (arCollectWeek(state, sh) !== wIdx) return;
      var cust = customerById(state, sh.custId), cat = (cust && cust.cat) || '国内';
      if (cat === '国外') foreign += num(sh.value); else domestic += num(sh.value);
    });
    return { foreign: foreign, domestic: domestic };
  }

  // ---------- the assumption-driven forecast for ONE week ------------------
  function computed(state, wIdx) {
    var W = weeks(state), wk = W[wIdx] || W[0];
    var m = wk.month;
    var g = function (id) { return effAN(state, wIdx, id); };
    var keep = 1 - g('defectRate'); // 预测淘汰率 reduces sellable quantity

    var qFL = g('qtyForLarge') * keep, qFS = g('qtyForSmall') * keep, qFDye = g('qtyForDye') * keep, qFCut = g('qtyForCut') * keep;
    var qDL = g('qtyDomLarge') * keep, qDS = g('qtyDomSmall') * keep, qDDye = g('qtyDomDye') * keep, qDCut = g('qtyDomCut') * keep;
    var totalQ = qFL + qFS + qFDye + qFCut + qDL + qDS + qDDye + qDCut;
    var volW = totalQ;                                      // 销量 entered as 株/周 (weekly)

    // 收款 = (大花+小花+染色花+切花) per channel × weekly qty × 当周回款率; AR adds on top.
    var foreignGross = qFL * g('priceForLarge') + qFS * g('priceForSmall') + qFDye * g('priceForDye') + qFCut * g('priceForCut');
    var domGross = qDL * g('priceDomLarge') + qDS * g('priceDomSmall') + qDDye * g('priceDomDye') + qDCut * g('priceDomCut');
    var collectWeek = g('collectInWeek');                  // 当周回款率

    var arDue = arDueInWeek(state, wIdx);                   // 应收账款 booked for this week (国外/国内) — a PARALLEL band
    var foreignSales = foreignGross * collectWeek;
    var domSales = domGross * collectWeek;
    var foreign = foreignSales;                             // FD only — AR is NEVER summed in (separate committed band)
    var arCollect = arDue.domestic;                         // AR band (国内), kept as a breakdown helper
    var domestic = domSales;                                // FD only

    // 苗款 / 开花株款: scheduled payables due this week (from the register), else assumption baseline
    var dueMiao = dueInWeek(state, wIdx, '苗'), dueHua = dueInWeek(state, wIdx, '花');
    var seedling = dueMiao > 0 ? dueMiao : g('seedlingMonthly') / WPM * g('seedlingPrice');
    var flowering = dueHua;                                 // 开花株款 = 花 payables due this 付款周; NOT from 假设
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
      _domSales: domSales, _foreignSales: foreignSales, _arCollect: arCollect, _arForeign: arDue.foreign, _domGross: domGross, _foreignGross: foreignGross, _collectWeek: collectWeek, _keep: keep
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
    if (isHist(state, wIdx)) {
      var a = acOf(state, wIdx, field);
      if (a !== null) return a;
      // 收款 auto-fills from the 销售明细 sums when no manual actual is entered
      if (field === 'foreign' || field === 'domestic') {
        var r = salesReceipts(state, wIdx);
        return field === 'foreign' ? r.foreign : r.domestic;
      }
    }
    return fcOf(state, wIdx, field);
  }
  // outflow per category; 'materials' also carries the week's shipment freight (物流成本)
  function payOf(state, wIdx, cat) { var v = eff(state, wIdx, cat); if (cat === 'materials') v += freightDueInWeek(state, wIdx); return v; }
  function fcPayOf(state, wIdx, cat) { var v = fcOf(state, wIdx, cat); if (cat === 'materials') v += freightDueInWeek(state, wIdx); return v; }

  // ---------- the full-year series (the cash spine) ------------------------
  function series(state) {
    var W = weeks(state), cfg = state.config;
    var bal = num(cfg.openingBalance);
    return W.map(function (w, i) {
      var open = bal;
      var cin = eff(state, i, 'foreign') + eff(state, i, 'domestic');
      var pays = PAYCATS.reduce(function (s, c) { return s + payOf(state, i, c); }, 0);
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
      var pays = PAYCATS.reduce(function (s, c) { return s + fcPayOf(state, i, c); }, 0);
      var close = open + cin - pays;
      bal = close; out.push(close);
    }
    return out;
  }

  // committed (booked) balance trajectory — the SECOND dotted line. It follows
  // the actual balance up to the as-of week, then projects FORWARD using ONLY
  // booked 应收账款 collection (no forecast sales) minus the same scheduled
  // outflow basis as the forecast line. Entries are null before the branch and
  // after the last week any AR collects (the line simply stops — bookings only
  // reach a few weeks out). The vertical gap to forecastCloses = reliance on
  // not-yet-booked sales.
  function committedCloses(state) {
    var W = weeks(state), cw = currentWeekIdx(state), ser = series(state);
    var out = W.map(function () { return null; });
    var horizon = -1;
    (state.arShipments || []).forEach(function (sh) { var w = arCollectWeek(state, sh); if (w != null && w >= cw && w > horizon) horizon = w; });
    if (horizon < cw) return out;                          // no forward bookings → no committed line
    var branch = cw > 0 ? cw - 1 : 0;
    var bal = cw > 0 ? ser[cw - 1].close : num(state.config.openingBalance);
    out[branch] = bal;
    for (var i = cw; i <= horizon && i < W.length; i++) {
      var ar = arDueInWeek(state, i);
      var pays = PAYCATS.reduce(function (s, c) { return s + fcPayOf(state, i, c); }, 0);
      bal = bal + (ar.foreign + ar.domestic) - pays;
      out[i] = bal;
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
    SALESCATS: SALESCATS, PAYCATS: PAYCATS, CHANNELS: CHANNELS, PTYPES: PTYPES,
    RECEIPT_DEFS: RECEIPT_DEFS, PAY_ROW_DEFS: PAY_ROW_DEFS,
    PAY_NAMES: PAY_NAMES, PAY_COLORS: PAY_COLORS,
    URGENCY_OPTIONS: URGENCY_OPTIONS, URGENCY_COLORS: URGENCY_COLORS,
    AR_CATS: AR_CATS, AR_CAT_COLORS: AR_CAT_COLORS,
    num: num,
    genWeeks: genWeeks, weeks: weeks, currentWeekIdx: currentWeekIdx,
    effA: effA, inheritedA: inheritedA, effAN: effAN, monthlyFrom: monthlyFrom,
    shipmentById: shipmentById, shipUnit: shipUnit, payableMeta: payableMeta, payableAmt: payableAmt,
    payWeekOf: payWeekOf, dueInWeek: dueInWeek, freightDueInWeek: freightDueInWeek,
    lastWeekOfMonth: lastWeekOfMonth, payableBuckets: payableBuckets, salesReceipts: salesReceipts,
    customerOutstanding: customerOutstanding, arDueInWeek: arDueInWeek,
    customerById: customerById, weekIdxOf: weekIdxOf, arLag: arLag, arCollectWeek: arCollectWeek, AR_LAG_KEY: AR_LAG_KEY, AR_LAG_DEFAULT: AR_LAG_DEFAULT,
    computed: computed, isHist: isHist, fcOf: fcOf, acOf: acOf, eff: eff, payOf: payOf, fcPayOf: fcPayOf,
    series: series, forecastCloses: forecastCloses, committedCloses: committedCloses,
    fmt: fmt, wan: wan, yuan0: yuan0, donut: donut
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Engine; // Node tests
  else global.FFEngine = Engine;                                               // browser
})(typeof window !== 'undefined' ? window : globalThis);
