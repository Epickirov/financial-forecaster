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
    { id: 'fxdye', name: '国外染色花',       grp: '国外' },
    { id: 'fxcut', name: '国外切花',         grp: '国外' },
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
  var PTYPES = [{ id: '苗', label: '苗款' }, { id: '花', label: '开花株款' }, { id: '瓶苗', label: '瓶苗款' }];

  // ---- cash payment categories (drive 全年支出 / the expense donut) ------
  var PAYCATS = ['seedling', 'flowering', 'bottle', 'freight', 'loan', 'payroll', 'utilrent', 'projects', 'materials', 'travel', 'custom'];

  // receipt + payment line definitions shared by 历史/预测 panels
  var RECEIPT_DEFS = [['foreign', '国外收款'], ['domestic', '国内收款']];
  var PAY_ROW_DEFS = [
    ['seedling', '苗款'], ['flowering', '开花株款'], ['bottle', '瓶苗款'], ['freight', '物流运费'], ['payroll', '工资社保税费'],
    ['utilrent', '水电与租金'], ['projects', '项目及工程'], ['materials', '生产物资'],
    ['travel', '差旅招待加油伙食'], ['loan', '归还借款 / 固定支出'], ['custom', '其他自定义支出']
  ];

  var PAY_NAMES = {
    seedling: '苗款', flowering: '开花株款', bottle: '瓶苗款', freight: '物流运费', payroll: '工资社保', utilrent: '水电租金',
    materials: '生产物资', projects: '工程项目', loan: '借款/固定', travel: '差旅其他', custom: '其他自定义'
  };
  var PAY_COLORS = {
    seedling: '#c96442', flowering: '#b5862f', bottle: '#b9745a', freight: '#8a6d4f', payroll: '#4e7c4f', utilrent: '#dd8a63',
    materials: '#b07a52', projects: '#e0a079', loan: '#7c3a23', travel: '#f0cdb8', custom: '#a3886a'
  };

  var URGENCY_OPTIONS = ['一级', '二级', '三级', '四级'];
  var URGENCY_COLORS = { '一级': '#e8b84b', '二级': '#b9a7b3', '三级': '#5fb88a', '四级': '#6b9bd1' };
  var AR_CH = [{ id: 'dom', name: '国内应收' }, { id: 'for', name: '国外应收' }];   // 应收账款 channels

  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

  // ---------- 农历财年 (lunar fiscal year) ---------------------------------
  // 正月初一 (Chinese New Year / Spring Festival) Gregorian dates, 2024–2046.
  // The company's 农历财年 runs 正月初一 → the day BEFORE next year's 正月初一
  // (i.e. through 除夕), so the fiscal window is keyed to the lunar calendar and
  // rolls automatically each year. Dates verified against published almanacs;
  // extend this table to carry the auto window past 2046.
  var LUNAR_NEW_YEAR = {
    2024: '2024-02-10', 2025: '2025-01-29', 2026: '2026-02-17', 2027: '2027-02-06',
    2028: '2028-01-26', 2029: '2029-02-13', 2030: '2030-02-03', 2031: '2031-01-23',
    2032: '2032-02-11', 2033: '2033-01-31', 2034: '2034-02-19', 2035: '2035-02-08',
    2036: '2036-01-28', 2037: '2037-02-15', 2038: '2038-02-04', 2039: '2039-01-24',
    2040: '2040-02-12', 2041: '2041-02-01', 2042: '2042-01-22', 2043: '2043-02-10',
    2044: '2044-01-30', 2045: '2045-02-17', 2046: '2046-02-06'
  };

  // shift an ISO calendar date by whole days, entirely in UTC (no timezone drift)
  function isoAddDays(iso, n) {
    var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // The 农历财年 window (正月初一 → 次年除夕) that CONTAINS asOfISO. Auto-rolls:
  // once the as-of date crosses the year-end (除夕) the NEXT lunar year is returned.
  // Dates before / after the table clamp to the first / last covered year.
  function lunarFY(asOfISO) {
    var ys = Object.keys(LUNAR_NEW_YEAR).map(Number).sort(function (a, b) { return a - b; });
    var win = function (i) { return { year: ys[i], startISO: LUNAR_NEW_YEAR[ys[i]], endISO: isoAddDays(LUNAR_NEW_YEAR[ys[i + 1]], -1) }; };
    var iso = (typeof asOfISO === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asOfISO)) ? asOfISO : null;
    if (iso === null) return win(0);
    for (var i = 0; i < ys.length - 1; i++) { var w = win(i); if (iso >= w.startISO && iso <= w.endISO) return w; }
    return iso < LUNAR_NEW_YEAR[ys[0]] ? win(0) : win(ys.length - 2);   // clamp out-of-range
  }

  // 干支 + 生肖 label for a (Gregorian) lunar-year number, e.g. 2026 → "丙午（马）年"
  var GAN = '甲乙丙丁戊己庚辛壬癸', ZHI = '子丑寅卯辰巳午未申酉戌亥', ZODIAC = '鼠牛虎兔龙蛇马羊猴鸡狗猪';
  function lunarYearLabel(y) {
    if (!y) return '';
    var i = ((y - 4) % 10 + 10) % 10, j = ((y - 4) % 12 + 12) % 12;
    return GAN[i] + ZHI[j] + '（' + ZODIAC[j] + '）年';
  }

  // ---------- week grid ----------------------------------------------------
  function genWeeks(startISO, endISO) {
    // Treat fiscal dates as plain CALENDAR dates and parse/format ENTIRELY in UTC,
    // so the week grid never shifts with the viewer's device timezone. (The as-of
    // date is computed in China time; if weeks were parsed in local time, a non-UTC
    // viewer — e.g. Beijing UTC+8 — would see the grid and the 今日 marker off by a day.)
    var iso = function (d) { return d.toISOString().slice(0, 10); };
    var md = function (d) { return (d.getUTCMonth() + 1) + '.' + d.getUTCDate(); };
    var start = new Date(startISO + 'T00:00:00Z'), end = new Date(endISO + 'T00:00:00Z');
    var weeks = [], cur = new Date(start), i = 0;
    while (cur <= end && i < 60) {
      var ws = new Date(cur), we = new Date(cur); we.setUTCDate(we.getUTCDate() + 6);
      if (we > end) we.setTime(end.getTime());
      weeks.push({ idx: i, startISO: iso(ws), endISO: iso(we), label: md(ws) + '–' + md(we), month: ws.getUTCMonth() + 1 });
      cur.setUTCDate(cur.getUTCDate() + 7); i++;
    }
    return weeks;
  }
  // resolve the active fiscal window: MANUAL uses the stored dates; AUTO (default)
  // derives 正月初一→次年除夕 from the lunar calendar based on the as-of date, so it
  // rolls to the next 农历财年 on its own once 今日 passes the year-end.
  function fyWindow(state) {
    var cfg = (state && state.config) || {};
    if (cfg.fyMode === 'manual' && cfg.startISO && cfg.endISO) return { startISO: cfg.startISO, endISO: cfg.endISO };
    var w = lunarFY(cfg.asOfISO);
    return { startISO: w.startISO, endISO: w.endISO, year: w.year };
  }
  function weeks(state) { var w = fyWindow(state); return genWeeks(w.startISO, w.endISO); }

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
  // a payable marked 已付 has transitioned AP → Paid: it leaves the outstanding
  // buckets and no longer rolls forward as a live obligation.
  function payablePaid(p) { return !!(p && (p.paid === true || p.paid === 'true')); }

  // total OUTSTANDING (unpaid) payables due in a given week (optionally filtered by 苗/花)
  function dueInWeek(state, wIdx, type) {
    return (state.payables || []).reduce(function (s, p) {
      if (payablePaid(p)) return s;
      if (payWeekOf(p) !== wIdx) return s;
      if (type && payableMeta(state, p).type !== type) return s;
      return s + payableAmt(state, p);
    }, 0);
  }
  // 逾期应付: unpaid payables whose 付款周 is already behind the as-of week. They
  // are still owed, so the forward (committed) cash line rolls them into the
  // current week rather than leaving them stranded in a past bucket.
  function overduePayables(state) {
    var cw = currentWeekIdx(state);
    return (state.payables || []).reduce(function (s, p) {
      var w = payWeekOf(p);
      return (w != null && w < cw && !payablePaid(p)) ? s + payableAmt(state, p) : s;
    }, 0);
  }
  function freightPaid(sh) { return !!(sh && (sh.freightPaid === true || sh.freightPaid === 'true')); }
  // shipment freight (物流成本) charged to the cash flow in its 付款周 — UNPAID only
  function freightDueInWeek(state, wIdx) {
    return (state.shipments || []).reduce(function (s, sh) {
      if (freightPaid(sh)) return s;
      var w = parseInt(sh.freightWeek, 10);
      return (!isNaN(w) && w === wIdx) ? s + num(sh.freight) : s;
    }, 0);
  }
  // 逾期运费: unpaid freight whose 付款周 is already behind the as-of week (rolled into the current week)
  function overdueFreight(state) {
    var cw = currentWeekIdx(state);
    return (state.shipments || []).reduce(function (s, sh) {
      if (freightPaid(sh)) return s;
      var w = parseInt(sh.freightWeek, 10);
      return (!isNaN(w) && w < cw) ? s + num(sh.freight) : s;
    }, 0);
  }
  // 总金额 / 已付 / 未付 for one payable type (苗/花/瓶苗) and for freight
  function payableTotals(state, type) {
    var total = 0, paid = 0;
    (state.payables || []).forEach(function (p) {
      if (type && payableMeta(state, p).type !== type) return;
      var amt = payableAmt(state, p); total += amt; if (payablePaid(p)) paid += amt;
    });
    return { total: total, paid: paid, unpaid: total - paid };
  }
  function freightTotals(state) {
    var total = 0, paid = 0;
    (state.shipments || []).forEach(function (sh) { var amt = num(sh.freight); total += amt; if (freightPaid(sh)) paid += amt; });
    return { total: total, paid: paid, unpaid: total - paid };
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
      if (payablePaid(p)) return;
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

  // 应收账款 — a per-week ledger by channel (dom=国内, for=国外). Each week holds:
  //   exp 预计应收金额 — outstanding balance, CARRIES FORWARD (default = last week's value)
  //   add 本周新增应收金额 — new receivables this week (per-week, blank default)
  //   rcv 本周已收金额    — collected this week (per-week) → adds to that channel's 收款
  // (Replaces the old per-customer / per-shipment + 账期 model entirely.)
  function arVal(state, wIdx, ch, field) { var m = state.ar || {}; return m[wIdx + ':' + ch + ':' + field]; }
  function arExp(state, wIdx, ch) {                       // 预计应收: latest non-blank value at week <= wIdx
    for (var w = wIdx; w >= 0; w--) { var v = arVal(state, w, ch, 'exp'); if (v !== undefined && v !== '') return num(v); }
    return 0;
  }
  function arInheritedExp(state, wIdx, ch) {              // carry-forward value from strictly before wIdx (placeholder)
    for (var w = wIdx - 1; w >= 0; w--) { var v = arVal(state, w, ch, 'exp'); if (v !== undefined && v !== '') return num(v); }
    return 0;
  }
  function arRcv(state, wIdx, ch) { return num(arVal(state, wIdx, ch, 'rcv')); }   // 本周已收 → 收款
  function arAdd(state, wIdx, ch) { return num(arVal(state, wIdx, ch, 'add')); }   // 本周新增
  function arExpectedTotal(state, wIdx) { return arExp(state, wIdx, 'dom') + arExp(state, wIdx, 'for'); }
  function arReceivedTotal(state, wIdx) { return arRcv(state, wIdx, 'dom') + arRcv(state, wIdx, 'for'); }

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

    // 收款(FD) = (大花+小花+染色花+切花) per channel × weekly qty × 当周回款率.
    // 应收账款 collection (本周已收) is added separately in the cash series — never here.
    var foreignGross = qFL * g('priceForLarge') + qFS * g('priceForSmall') + qFDye * g('priceForDye') + qFCut * g('priceForCut');
    var domGross = qDL * g('priceDomLarge') + qDS * g('priceDomSmall') + qDDye * g('priceDomDye') + qDCut * g('priceDomCut');
    var collectWeek = g('collectInWeek');                  // 当周回款率
    var foreignSales = foreignGross * collectWeek;
    var domSales = domGross * collectWeek;
    var foreign = foreignSales;                             // FD only (new-sales collection)
    var domestic = domSales;                                // FD only

    // 苗款 / 开花株款: scheduled payables due this week (from the register), else assumption baseline
    var dueMiao = dueInWeek(state, wIdx, '苗'), dueHua = dueInWeek(state, wIdx, '花'), dueBottle = dueInWeek(state, wIdx, '瓶苗');
    // 假设 amounts are ALL per-week (the 假设 page is week-keyed) → no /WPM here. The
    // *Monthly field ids are legacy names kept for data continuity; values are weekly.
    // Only the 租金计划 / 固定支出 schedules stay month-based (paid on 到期月份, spread over the month).
    var seedling = dueMiao > 0 ? dueMiao : g('miaoAmount');                // 苗款: booked AP else 苗金额(元/周) FP
    var flowering = dueHua > 0 ? dueHua : g('huaAmount');                  // 开花株款: booked AP else 开花株金额(元/周) FP
    var bottle = dueBottle > 0 ? dueBottle : g('bottleAmount');            // 瓶苗款: booked AP else 瓶苗款(元/周) FP
    var payroll = g('payrollMonthly');                                     // 元/周
    var utilrent = g('utilitiesMonthly') + monthlyFrom(state.rents, m) / WPM;   // 水电(周) + 租金计划(按月分摊到周)
    var projects = g('projectsMonthly');                                   // 元/周
    var dueFreight = freightDueInWeek(state, wIdx);         // 运费 booked (AP) for this 付款周
    var freight = dueFreight > 0 ? dueFreight : g('freightMonthly');       // AP where booked, else 周 FP — never summed
    var materials = g('pkgCost') + g('prodCost');           // 生产物料(周), standalone (no 销量)
    var travel = g('travelWeekly');                                        // 元/周
    var loan = g('loanMonthly') + monthlyFrom(state.fixed, m) / WPM;       // 借款(周) + 固定支出(按月分摊到周)

    var custom = 0;
    (state.customItems || []).forEach(function (it) {
      var v = effAN(state, wIdx, it.id);
      if (it.kind === 'monthlyExpense') custom += v / WPM;
      else if (it.kind === 'weeklyExpense') custom += v;
    });

    return {
      foreign: foreign, domestic: domestic, seedling: seedling, flowering: flowering, bottle: bottle, freight: freight,
      payroll: payroll, utilrent: utilrent, projects: projects, materials: materials,
      travel: travel, loan: loan, custom: custom,
      // breakdown helpers (not part of the cash spine, used by 收款测算)
      _domSales: domSales, _foreignSales: foreignSales, _domGross: domGross, _foreignGross: foreignGross, _collectWeek: collectWeek, _keep: keep
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
  // outflow per category (freight is now its own 运费 category, fed by computed())
  function payOf(state, wIdx, cat) { return eff(state, wIdx, cat); }
  function fcPayOf(state, wIdx, cat) { return fcOf(state, wIdx, cat); }

  // ---------- the full-year series (the cash spine) ------------------------
  function series(state) {
    var W = weeks(state), cfg = state.config;
    var bal = num(cfg.openingBalance);
    return W.map(function (w, i) {
      var open = bal;
      // 收款 = FD/actual new-sales collection + 本周已收 (应收账款 collected this week)
      var cin = eff(state, i, 'foreign') + eff(state, i, 'domestic') + arReceivedTotal(state, i);
      var pays = PAYCATS.reduce(function (s, c) { return s + payOf(state, i, c); }, 0);
      var close = open + cin - pays;
      bal = close;
      return { i: i, w: w, open: open, cin: cin, pays: pays, close: close, net: cin - pays, isHist: w.endISO <= cfg.asOfISO };
    });
  }

  // pure-forecast closing balances — the 现金 dotted line (ignores actuals,
  // runs the WHOLE year). 收款 = FD new-sales collection + 本周已收 (应收账款).
  function forecastCloses(state) {
    var W = weeks(state), bal = num(state.config.openingBalance), out = [];
    for (var i = 0; i < W.length; i++) {
      var open = bal;
      var cin = fcOf(state, i, 'foreign') + fcOf(state, i, 'domestic') + arReceivedTotal(state, i);
      var pays = PAYCATS.reduce(function (s, c) { return s + fcPayOf(state, i, c); }, 0);
      var close = open + cin - pays;
      bal = close; out.push(close);
    }
    return out;
  }

  // 现金 + 应收 — the SECOND dotted line: the 现金 trajectory plus the outstanding
  // 预计应收 (国内+国外) at each week. The vertical gap to forecastCloses = how much
  // is still owed to you (uncollected receivables).
  function cashPlusARCloses(state) {
    var fc = forecastCloses(state);
    return fc.map(function (c, i) { return c + arExpectedTotal(state, i); });
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
    AR_CH: AR_CH,
    num: num,
    LUNAR_NEW_YEAR: LUNAR_NEW_YEAR, isoAddDays: isoAddDays, lunarFY: lunarFY, lunarYearLabel: lunarYearLabel, fyWindow: fyWindow,
    genWeeks: genWeeks, weeks: weeks, currentWeekIdx: currentWeekIdx,
    effA: effA, inheritedA: inheritedA, effAN: effAN, monthlyFrom: monthlyFrom,
    shipmentById: shipmentById, shipUnit: shipUnit, payableMeta: payableMeta, payableAmt: payableAmt,
    payWeekOf: payWeekOf, payablePaid: payablePaid, dueInWeek: dueInWeek, overduePayables: overduePayables, payableTotals: payableTotals,
    freightDueInWeek: freightDueInWeek, freightPaid: freightPaid, overdueFreight: overdueFreight, freightTotals: freightTotals,
    lastWeekOfMonth: lastWeekOfMonth, payableBuckets: payableBuckets, salesReceipts: salesReceipts,
    arVal: arVal, arExp: arExp, arInheritedExp: arInheritedExp, arRcv: arRcv, arAdd: arAdd, arExpectedTotal: arExpectedTotal, arReceivedTotal: arReceivedTotal,
    computed: computed, isHist: isHist, fcOf: fcOf, acOf: acOf, eff: eff, payOf: payOf, fcPayOf: fcPayOf,
    series: series, forecastCloses: forecastCloses, cashPlusARCloses: cashPlusARCloses,
    fmt: fmt, wan: wan, yuan0: yuan0, donut: donut
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Engine; // Node tests
  else global.FFEngine = Engine;                                               // browser
})(typeof window !== 'undefined' ? window : globalThis);
