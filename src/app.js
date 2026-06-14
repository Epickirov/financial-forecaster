/* =====================================================================
 * app.js — UI layer (rendering + events). No framework.
 * =====================================================================
 *
 * Rendering model: on every state change we rebuild the page's HTML from
 * `state` (single render path = no stale UI), then restore keyboard focus
 * and caret position by element id so typing stays smooth. Inputs are the
 * source of truth for their own text; the store is updated on each edit,
 * which recomputes every derived number (KPIs, chart, totals, variance)
 * live and across pages — exactly the assumptions→forecast→actuals loop.
 * ===================================================================== */
(function () {
  'use strict';
  var E = window.FFEngine;
  var FFStore = window.FFStore;

  // ----- small string helpers -----
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escA(s) { return esc(s).replace(/"/g, '&quot;'); }

  // binding attribute builders (id is used only for focus restoration)
  function bMap(map, key) { return 'data-map="' + escA(map) + '" data-key="' + escA(key) + '" id="m|' + escA(map) + '|' + escA(key) + '"'; }
  function bArr(arr, idx, key) { return 'data-arr="' + escA(arr) + '" data-idx="' + idx + '" data-key="' + escA(key) + '" id="r|' + escA(arr) + '|' + idx + '|' + escA(key) + '"'; }
  function bCfg(key) { return 'data-config="' + escA(key) + '" id="c|' + escA(key) + '"'; }

  // ===================================================================
  //  VIEW MODEL  (pure-ish: derives everything the templates need)
  // ===================================================================
  var HOV = null; // chart hover dataset, refreshed each build

  function buildView(state) {
    var S = state;
    var fmt = function (y) { return E.fmt(S, y); };
    var wan = E.wan, yuan0 = E.yuan0, num = E.num;
    var open0 = num(S.config.openingBalance);

    var navDef = [
      { id: 'dash', label: '总览', sym: '◧' }, { id: 'hist', label: '历史数据', sym: '◷' },
      { id: 'fcst', label: '预测', sym: '⤴' }, { id: 'assume', label: '假设', sym: '⚙' },
      { id: 'seedpay', label: '苗/花应付款', sym: '❀' }, { id: 'logi', label: '物流成本', sym: '⇄' },
      { id: 'ar', label: '应收账款', sym: '▤' }, { id: 'report', label: '管理层报告', sym: '⎙' },
      { id: 'tut', label: '教程', sym: '✎' }
    ];
    var page = S.page;
    var navItems = navDef.map(function (n) {
      var on = n.id === page;
      return { id: n.id, label: n.label, sym: n.sym,
        bg: on ? 'rgba(110,131,72,.16)' : 'transparent', bd: on ? 'rgba(110,131,72,.34)' : 'transparent',
        color: on ? '#46552c' : '#7d7567', weight: on ? 700 : 500 };
    });
    var titles = {
      dash: ['财务总览', '历史 + 预测合并的全年财务全景'],
      hist: ['历史数据', '按周录入实际销售、进货与现金流'],
      fcst: ['预测', '由假设自动生成 · 每周可覆盖'],
      assume: ['假设', '逐周设定 · 默认继承上一周 · 驱动该周预测'],
      seedpay: ['苗/花应付款', '按付款周登记应付苗款 / 开花株款 · 分国内 / 国外 · 含逾期与紧急度汇总'],
      logi: ['物流成本', '各批次运费 · 按付款周计入「生产物资运费」现金流'],
      ar: ['应收账款', '客户应收余额与每周预计回款'],
      report: ['管理层报告', '一页式 · 非财务人员也能读懂'],
      tut: ['使用教程', '三步了解 HD / AR / FD 如何录入与联动']
    };
    var fy = (S.config.startISO || '').slice(2).replace(/-/g, '.') + ' → ' + (S.config.endISO || '').slice(2).replace(/-/g, '.');

    // ---- series + chart geometry ----
    var ser = E.series(S);
    var fcCloses = E.forecastCloses(S);
    var cmCloses = E.committedCloses(S);
    var cmVals = cmCloses.filter(function (v) { return v != null; });
    var acCloses = ser.map(function (s) { return s.close; });
    var minV = Math.min.apply(null, fcCloses.concat(acCloses, cmVals, [open0]));
    var maxV = Math.max.apply(null, fcCloses.concat(acCloses, cmVals, [open0]));
    var span = (maxV - minV) || 1;
    var Wd = 1000, Hd = 250, pl = 44, pr = 8, pt = 30, pb = 32, iw = Wd - pl - pr, ih = Hd - pt - pb;
    var xs = function (i) { return pl + (ser.length <= 1 ? iw / 2 : iw * i / (ser.length - 1)); };
    var ys = function (v) { return pt + ih * (1 - (v - minV) / span); };
    var lastHist = ser.reduce(function (acc, s, i) { return s.isHist ? i : acc; }, 0);
    var forecastPts = fcCloses.map(function (v, i) { return (+xs(i).toFixed(1)) + ',' + (+ys(v).toFixed(1)); }).join(' ');
    var actualPts = acCloses.slice(0, lastHist + 1).map(function (v, i) { return (+xs(i).toFixed(1)) + ',' + (+ys(v).toFixed(1)); }).join(' ');
    var committedPts = cmCloses.map(function (v, i) { return v == null ? null : (+xs(i).toFixed(1)) + ',' + (+ys(v).toFixed(1)); }).filter(Boolean).join(' ');
    var trajArea = ser.length ? 'M' + (+xs(0).toFixed(1)) + ',' + (Hd - pb) + ' L' +
      fcCloses.map(function (v, i) { return (+xs(i).toFixed(1)) + ',' + (+ys(v).toFixed(1)); }).join(' L') +
      ' L' + (+xs(ser.length - 1).toFixed(1)) + ',' + (Hd - pb) + ' Z' : '';
    HOV = {
      xs: ser.map(function (_, i) { return +xs(i).toFixed(1); }),
      yf: fcCloses.map(function (v) { return +ys(v).toFixed(1); }),
      ya: ser.map(function (s, i) { return i <= lastHist ? +ys(acCloses[i]).toFixed(1) : null; }),
      lab: ser.map(function (s) { return s.w.month + '月 ' + s.w.label; }),
      fcStr: fcCloses.map(function (v) { return fmt(v); }),
      acStr: acCloses.map(function (v) { return fmt(v); }),
      varStr: ser.map(function (s, i) { var f = fcCloses[i]; if (!f) return '—'; var p = (acCloses[i] - f) / Math.abs(f) * 100; return (p >= 0 ? '+' : '') + p.toFixed(1) + '%'; }),
      varCol: ser.map(function (s, i) { var f = fcCloses[i]; var p = f ? (acCloses[i] - f) / Math.abs(f) * 100 : 0; return Math.abs(p) < 0.5 ? '#8a8273' : (p >= 0 ? '#6e8348' : '#c24433'); })
    };
    // 今天 marker: place it at the ACTUAL as-of date, interpolated between the
    // weekly points (each point i sits at the END of week i), rather than
    // quantizing to the last fully-elapsed week — otherwise moving the as-of
    // date within a week wouldn't move the line.
    var asOfX = (function () {
      var dayMs = 86400000, t = function (iso) { return new Date(iso + 'T00:00:00').getTime(); };
      var cw = E.currentWeekIdx(S);                       // week containing the as-of date
      if (!ser[cw]) return +xs(lastHist).toFixed(1);
      var endCur = t(ser[cw].w.endISO);
      var endPrev = cw > 0 && ser[cw - 1] ? t(ser[cw - 1].w.endISO) : t(ser[cw].w.startISO) - dayMs;
      var g = endCur > endPrev ? (t(S.config.asOfISO) - endPrev) / (endCur - endPrev) : 1;
      var frac = (cw - 1) + Math.max(0, Math.min(1, g));
      frac = Math.max(0, Math.min(ser.length - 1, frac));
      return +xs(frac).toFixed(1);
    })();
    // Extend the solid ACTUAL line flat to the 今天 mark: the in-progress week
    // has no actuals yet, so carry the last known balance forward. This keeps
    // "solid behind today, dotted (forecast) ahead" aligned exactly to the mark.
    if (asOfX > +xs(lastHist).toFixed(1)) {
      actualPts += (actualPts ? ' ' : '') + asOfX + ',' + (+ys(acCloses[lastHist]).toFixed(1));
    }
    var yTicks = [0, 1, 2, 3].map(function (k) { var v = maxV - span * (k / 3); return { y: pt + ih * (k / 3) + 3, label: wan(v, 0) }; });
    var xTicks = ser.filter(function (_, i) { return i % Math.ceil(ser.length / 7) === 0; }).map(function (s) { return { x: +xs(s.i).toFixed(1), label: s.w.month + '月' }; });

    // ---- monthly bars ----
    var monthMap = {};
    ser.forEach(function (s) { var m = s.w.month; if (!monthMap[m]) monthMap[m] = { cin: 0, pays: 0 }; monthMap[m].cin += s.cin; monthMap[m].pays += s.pays; });
    var monthOrder = ser.map(function (s) { return s.w.month; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    var maxBar = Math.max.apply(null, monthOrder.map(function (m) { return Math.max(monthMap[m].cin, monthMap[m].pays); }).concat([1]));
    var monthBars = monthOrder.map(function (m) {
      return { label: m + '月', inH: (monthMap[m].cin / maxBar * 150).toFixed(0) + 'px', outH: (monthMap[m].pays / maxBar * 150).toFixed(0) + 'px' };
    });

    // ---- expense donut (full year) ----
    var payTotals = {};
    E.PAYCATS.forEach(function (c) { payTotals[c] = ser.reduce(function (s, x) { return s + E.payOf(S, x.i, c); }, 0); });
    var donutItems = E.PAYCATS.map(function (c) { return { k: E.PAY_NAMES[c], v: payTotals[c], color: E.PAY_COLORS[c] }; })
      .sort(function (a, b) { return b.v - a.v; }).filter(function (x) { return x.v > 0; });
    var dashDonut = E.donut(donutItems, 65, 65, 56, 31);
    var totalPay = Object.keys(payTotals).reduce(function (a, k) { return a + payTotals[k]; }, 0);

    var totalCin = ser.reduce(function (s, x) { return s + x.cin; }, 0);
    var histCin = ser.filter(function (s) { return s.isHist; }).reduce(function (s, x) { return s + x.cin; }, 0);
    var fcstCin = totalCin - histCin;
    var yearEnd = ser.length ? ser[ser.length - 1].close : 0;
    var minClose = Math.min.apply(null, acCloses);
    var minWeek = ser.find(function (s) { return s.close === minClose; });
    var arTotal = S.customers.reduce(function (s, c) { return s + E.customerOutstanding(S, c.id); }, 0);

    // ---- selected week ----
    var selIdx = Math.min(Math.max(S.weekIdx | 0, 0), Math.max(ser.length - 1, 0));
    var selRow = ser[selIdx] || { open: 0, cin: 0, pays: 0, close: 0, net: 0 };
    var selWk = ser[selIdx] ? ser[selIdx].w : { label: '', month: 0 };
    // dashboard "预计本周回款" = the week containing the as-of date (真正的"本周"),
    // not whatever week is selected on another page.
    var curW = E.currentWeekIdx(S);
    var _aop = (S.config.asOfISO || '').split('-');
    var asOfMD = _aop.length === 3 ? (+_aop[1]) + '月' + (+_aop[2]) + '日' : '';
    var arWeekCollect = (function () { var d = E.arDueInWeek(S, curW); return d.foreign + d.domestic; })();

    var dashKpis = [
      { label: '现可用款 / 期初', val: fmt(open0), color: 'var(--plum)', sub: '农历财年起始余额', subColor: 'var(--muted)' },
      { label: '全年收款', val: fmt(totalCin), color: 'var(--leaf)', sub: '已收 ' + wan(histCin) + ' · 预测 ' + wan(fcstCin) + ' · 应收(已订) ' + wan(arTotal) + '万', subColor: 'var(--muted)' },
      { label: '全年支出', val: fmt(totalPay), color: 'var(--rose)', sub: '7 大类合计', subColor: 'var(--muted)' },
      { label: '年末预计余额', val: fmt(yearEnd), color: 'var(--plum2)', sub: (yearEnd >= open0 ? '↑ 较期初增长' : '↓ 较期初下降'), subColor: yearEnd >= open0 ? 'var(--leaf)' : 'var(--rose)' },
      { label: '最低现金谷底', val: fmt(minClose), color: minClose < 1000000 ? 'var(--rose)' : 'var(--gold)', sub: (minWeek ? minWeek.w.month + '月 (' + minWeek.w.label + ')' : ''), subColor: 'var(--muted)' }
    ];

    // ---- week chips ----
    function weekChip(s) {
      var on = s.i === selIdx;
      return { idx: s.i, label: s.w.label, month: s.w.month + '月',
        selBg: on ? 'var(--leaf)' : '#fff', selColor: on ? '#fff' : 'var(--ink)', selBd: on ? 'var(--leaf)' : 'var(--line)',
        selShadow: on ? '0 6px 14px -6px rgba(110,131,72,.55)' : '0 1px 0 rgba(0,0,0,.02)',
        netColor: s.net >= 0 ? (on ? '#dfeccb' : 'var(--leaf)') : (on ? '#f4cabf' : 'var(--rose)'),
        net: (s.net >= 0 ? '+' : '−') + wan(Math.abs(s.net)) };
    }
    var histWeeks = ser.filter(function (s) { return s.isHist; }).map(weekChip);
    var fcstWeeks = ser.filter(function (s) { return !s.isHist; }).map(weekChip);
    var allWeeks = ser.map(weekChip);

    // ---- sales / purchasing (selected week) ----
    var salesRows = E.SALESCATS.map(function (c) {
      var qk = selIdx + ':' + c.id + ':qty', ak = selIdx + ':' + c.id + ':amt';
      var qty = S.sales[qk] != null ? S.sales[qk] : '', amt = S.sales[ak] != null ? S.sales[ak] : '';
      var q = num(qty), a = num(amt);
      return { name: c.name, grp: c.grp, qtyKey: qk, amtKey: ak, qty: qty, amt: amt, price: q > 0 ? (a / q).toFixed(2) : '—' };
    });
    var salesQsum = salesRows.reduce(function (s, r) { return s + num(r.qty); }, 0);
    var salesAsum = salesRows.reduce(function (s, r) { return s + num(r.amt); }, 0);

    // (进货验货 is now a per-supplier shipment register — see shipmentRows below)

    // ---- forecast/historical cash rows (selected week) ----
    var recDefs = E.RECEIPT_DEFS, payRowDefs = E.PAY_ROW_DEFS;
    function fcstRow(f, label) {
      var sub = '';
      if (f === 'seedling') sub = '本周(第' + (curW + 1) + '周)应付苗款合计 ' + fmt(E.dueInWeek(S, curW, '苗'));
      else if (f === 'flowering') sub = '本周(第' + (curW + 1) + '周)应付开花株款合计 ' + fmt(E.dueInWeek(S, curW, '花'));
      else if (f === 'freight') sub = '本周(第' + (curW + 1) + '周)应付运费合计 ' + fmt(E.freightDueInWeek(S, curW));
      return { key: selIdx + ':' + f, label: label, sub: sub, val: (S.fcst[selIdx + ':' + f]) != null ? S.fcst[selIdx + ':' + f] : '', ph: '≈' + yuan0(E.computed(S, selIdx)[f] || 0) };
    }
    var fcstReceiptRows = recDefs.map(function (d) { return fcstRow(d[0], d[1]); });
    var fcstPayRows = payRowDefs.map(function (d) { return fcstRow(d[0], d[1]); });

    function acVar(f) {
      var fc = E.fcOf(S, selIdx, f), ac = E.acOf(S, selIdx, f);
      if (ac === null || fc === 0) return { pct: '', color: 'transparent' };
      var p = (ac - fc) / fc * 100;
      return { pct: (p >= 0 ? '+' : '') + p.toFixed(1) + '%', color: Math.abs(p) < 1 ? 'var(--muted)' : (p >= 0 ? 'var(--leaf)' : 'var(--rose)') };
    }
    function histRow(f, label) {
      var v = acVar(f);
      var ph;
      if (f === 'foreign' || f === 'domestic') { var sr = E.salesReceipts(S, selIdx); ph = '销售明细 ' + yuan0(f === 'foreign' ? sr.foreign : sr.domestic); }
      else ph = '预测 ' + yuan0(E.fcOf(S, selIdx, f));
      return { key: selIdx + ':' + f, label: label, val: (S.actual[selIdx + ':' + f]) != null ? S.actual[selIdx + ':' + f] : '', ph: ph, varPct: v.pct, varColor: v.color };
    }
    var histReceiptRows = recDefs.map(function (d) { return histRow(d[0], d[1]); });
    var histPayRows = payRowDefs.map(function (d) { return histRow(d[0], d[1]); });

    var selFcNet = recDefs.reduce(function (a, d) { return a + E.fcOf(S, selIdx, d[0]); }, 0) - E.PAYCATS.reduce(function (a, f) { return a + E.fcOf(S, selIdx, f); }, 0);
    var selVarP = selFcNet !== 0 ? (selRow.net - selFcNet) / Math.abs(selFcNet) * 100 : 0;
    var hasActual = recDefs.concat(payRowDefs).some(function (d) { return E.acOf(S, selIdx, d[0]) !== null; });

    // ---- revenue breakdown (收款测算) with the AR-collection line ----
    var c0 = E.computed(S, selIdx);
    var keep = c0._keep;
    var gA = function (id) { return E.effAN(S, selIdx, id); };
    function rb(qid, pid) { var qW = gA(qid) * keep; return { qty: Math.round(qW).toLocaleString('zh-CN'), price: gA(pid), amt: yuan0(qW * gA(pid)) }; }
    var revBreak = {
      defect: (gA('defectRate') * 100).toFixed(1) + '%',
      collectRate: (gA('collectInWeek') * 100).toFixed(0) + '%',
      forLarge: rb('qtyForLarge', 'priceForLarge'), forSmall: rb('qtyForSmall', 'priceForSmall'), forDye: rb('qtyForDye', 'priceForDye'), forCut: rb('qtyForCut', 'priceForCut'),
      domLarge: rb('qtyDomLarge', 'priceDomLarge'), domSmall: rb('qtyDomSmall', 'priceDomSmall'), domDye: rb('qtyDomDye', 'priceDomDye'), domCut: rb('qtyDomCut', 'priceDomCut'),
      foreignGross: yuan0(c0._foreignGross), domGross: yuan0(c0._domGross),
      foreignSales: fmt(c0._foreignSales),  // 国外销售收款 (× 当周回款率)
      domSales: fmt(c0._domSales),          // 国内销售收款 (× 当周回款率)
      arCollect: fmt(c0._arCollect),        // 应收账款本周回款 (国内)
      arForeign: fmt(c0._arForeign),        // 应收账款本周回款 (国外)
      foreignTotal: fmt(E.fcOf(S, selIdx, 'foreign')),
      domesticTotal: fmt(E.fcOf(S, selIdx, 'domestic'))
    };
    var revBreakForeign = [merge({ label: '国外大花 3.5/3.8寸' }, revBreak.forLarge), merge({ label: '国外小花 2.8/3.0寸' }, revBreak.forSmall), merge({ label: '国外染色花' }, revBreak.forDye), merge({ label: '国外切花' }, revBreak.forCut)];
    var revBreakDom = [merge({ label: '国内大花 3.5/3.8寸' }, revBreak.domLarge), merge({ label: '国内小花 2.8/3.0寸' }, revBreak.domSmall), merge({ label: '国内染色花' }, revBreak.domDye), merge({ label: '国内切花' }, revBreak.domCut)];

    // ---- shipments (进货验货) / payables (苗·花应付款) / logistics ----------
    var shipmentRows = (S.shipments || []).map(function (sh, i) {
      return { idx: i, id: sh.id, type: sh.type || '苗', channel: sh.channel || '国内', supplier: sh.supplier, spec: sh.spec,
        qty: sh.qty != null ? sh.qty : '', amount: sh.amount != null ? sh.amount : '', iq: sh.iq != null ? sh.iq : '',
        unit: num(sh.qty) > 0 ? (num(sh.amount) / num(sh.qty)).toFixed(2) : '—',
        freight: sh.freight != null ? sh.freight : '', freightWeek: (sh.freightWeek === '' || sh.freightWeek == null) ? '' : parseInt(sh.freightWeek, 10) };
    });
    var supplierRows = (S.suppliers || []).map(function (sp, i) { return { idx: i, id: sp.id, name: sp.name != null ? sp.name : '' }; });
    var supplierNames = (S.suppliers || []).map(function (sp) { return sp.name; }).filter(function (n) { return n; });
    var payablesView = (S.payables || []).map(function (p, i) {
      var m = E.payableMeta(S, p);
      return { idx: i, id: p.id, shipmentId: p.shipmentId || '', type: m.type, channel: m.channel,
        supplier: m.supplier, spec: m.spec, iq: m.iq, qty: m.qty,
        amount: p.amount != null ? p.amount : '', amountFull: yuan0(E.payableAmt(S, p)),
        urgency: p.urgency || '三级', uColor: E.URGENCY_COLORS[p.urgency] || 'var(--muted)', paid: E.payablePaid(p),
        payWeek: (p.payWeek === '' || p.payWeek == null) ? '' : parseInt(p.payWeek, 10) };
    });
    function fmtBuckets(b) {
      var out = {};
      E.CHANNELS.forEach(function (ch) {
        out[ch] = { _t: {} };
        ['overdue', 'thisWeek', 'nextWeek', 'thisMonth', 'total'].forEach(function (bk) {
          out[ch][bk] = {}; out[ch]._t[bk] = fmt(b[ch]._t[bk]);
          E.URGENCY_OPTIONS.forEach(function (u) { out[ch][bk][u] = b[ch][bk][u] ? fmt(b[ch][bk][u]) : '·'; });
        });
      });
      return out;
    }
    var bucketsMiao = fmtBuckets(E.payableBuckets(S, '苗'));
    var bucketsHua = fmtBuckets(E.payableBuckets(S, '花'));
    var freightTotal = (S.shipments || []).reduce(function (s, sh) { return s + num(sh.freight); }, 0);
    var overdueTotal = E.overduePayables(S);
    var weeksList = ser.map(function (s) { return s.w; });

    var upcoming = ser.slice(selIdx, selIdx + 9).map(function (s) {
      return { label: s.w.label, month: s.w.month + '月', cin: wan(s.cin), pays: wan(s.pays),
        net: (s.net >= 0 ? '+' : '−') + wan(Math.abs(s.net)), netColor: s.net >= 0 ? 'var(--leaf)' : 'var(--rose)',
        close: wan(s.close), rowBg: s.i === selIdx ? 'var(--lilac)' : 'transparent', tag: s.isHist ? '实际' : '预测', tagColor: s.isHist ? 'var(--plum)' : 'var(--orchid)' };
    });

    // ---- assumptions groups ----
    function phf(v) { return (v === undefined || v === '') ? '—' : String(v); }
    function fld(id, label, unit, hint) {
      var k = selIdx + ':' + id, ov = S.assumeWeek[k];
      var has = ov !== undefined && ov !== '';
      return { key: k, label: label, unit: unit, hint: hint || '', val: ov != null ? ov : '', ph: '继承 ' + phf(E.inheritedA(S, selIdx, id)),
        badge: has ? '本周覆盖' : '', badgeColor: has ? 'var(--orchid)' : 'transparent' };
    }
    function grpCustom(gid) {
      return S.customItems.map(function (c, i) { return { c: c, i: i }; }).filter(function (o) { return o.c.group === gid; }).map(function (o) {
        var k = selIdx + ':' + o.c.id, ov = S.assumeWeek[k];
        return { custIdx: o.i, id: o.c.id, name: o.c.name, unit: o.c.unit, key: k, val: ov != null ? ov : '', ph: '继承 ' + phf(E.inheritedA(S, selIdx, o.c.id)) };
      });
    }
    var assumeGroups = [
      { gid: 'price', title: '销售单价', desc: '每株价格', sym: '¥', fields: [fld('priceForLarge', '国外大花 3.5/3.8寸', '元/株'), fld('priceForSmall', '国外小花 2.8/3.0寸', '元/株'), fld('priceForDye', '国外染色花', '元/株'), fld('priceForCut', '国外切花', '元/株'), fld('priceDomLarge', '国内大花 3.5/3.8寸', '元/株'), fld('priceDomSmall', '国内小花 2.8/3.0寸', '元/株'), fld('priceDomDye', '国内染色花', '元/株'), fld('priceDomCut', '国内切花', '元/株')], custom: grpCustom('price') },
      { gid: 'collect', title: '回款节奏', desc: '当周销售收款比例 · 应收账款分类账期（周）', sym: '%', fields: [fld('collectInWeek', '当周回款率', '比例', '0.7 = 当周收回 70%'), fld('lagForeign', '国外应收账期', '周', '出货后约几周回款 · 默认 4'), fld('lagDomestic', '国内应收账期', '周', '默认 2'), fld('lagProvIn', '省内应收账期', '周', '默认 2'), fld('lagProvOut', '省外应收账期', '周', '默认 2')], custom: grpCustom('collect') },
      { gid: 'volume', title: '销量与淘汰', desc: '各渠道周销量、规格与预测淘汰率', sym: '≋', fields: [fld('qtyForLarge', '国外大花 3.5/3.8寸', '株/周'), fld('qtyForSmall', '国外小花 2.8/3.0寸', '株/周'), fld('qtyForDye', '国外染色花', '株/周'), fld('qtyForCut', '国外切花', '株/周'), fld('qtyDomLarge', '国内大花 3.5/3.8寸', '株/周'), fld('qtyDomSmall', '国内小花 2.8/3.0寸', '株/周'), fld('qtyDomDye', '国内染色花', '株/周'), fld('qtyDomCut', '国内切花', '株/周'), fld('defectRate', '预测淘汰率', '比例', '0.05 = 扣减5%可售量')], custom: grpCustom('volume') },
      { gid: 'seed', title: '种苗采购', desc: '每月进苗与成本', sym: '❀', fields: [fld('seedlingMonthly', '月进苗株数', '株/月'), fld('seedlingPrice', '种苗平均单价', '元/株')], custom: grpCustom('seed') },
      { gid: 'material', title: '生产物料成本', desc: '每株物料成本', sym: '▦', fields: [fld('pkgCost', '包装材料', '元/株'), fld('prodCost', '生产材料', '元/株')], custom: grpCustom('material') },
      { gid: 'opex', title: '人工 · 水电 · 运费 · 其他', desc: '每月固定运营支出', sym: '⚙', fields: [fld('payrollMonthly', '工资社保税费', '元/月'), fld('utilitiesMonthly', '水电费', '元/月'), fld('freightMonthly', '运费', '元/月'), fld('projectsMonthly', '项目及工程', '元/月'), fld('travelWeekly', '差旅招待（每周）', '元/周'), fld('loanMonthly', '房贷/借款', '元/月')], custom: grpCustom('opex') }
    ];

    // ---- receivables (per customer: shipments → outstanding; collection week) ----
    var allArShip = S.arShipments || [];
    var custRows = S.customers.map(function (c, i) {
      var ships = [];
      allArShip.forEach(function (sh, si) { if (sh.custId === c.id) ships.push({ si: si, value: sh.value != null ? sh.value : '', date: sh.date != null ? sh.date : '', collectWeek: (sh.collectWeek === '' || sh.collectWeek == null) ? '' : parseInt(sh.collectWeek, 10), computedWeek: E.arCollectWeek(S, sh) }); });
      var out = E.customerOutstanding(S, c.id);
      return { idx: i, id: c.id, name: c.name, note: c.note, cat: c.cat || '国内', catColor: E.AR_CAT_COLORS[c.cat] || '#c96442',
        collectWeek: (c.collectWeek === '' || c.collectWeek == null) ? '' : parseInt(c.collectWeek, 10),
        outstanding: out, outstandingStr: yuan0(out), ships: ships, barW: 0 };
    });
    var arMax = Math.max.apply(null, custRows.map(function (c) { return c.outstanding; }).concat([1]));
    custRows.forEach(function (c) { c.barW = (c.outstanding / arMax * 100).toFixed(0) + '%'; });
    var arOut = custRows.reduce(function (s, c) { return s + c.outstanding; }, 0);
    var catSummary = E.AR_CATS.map(function (cat) {
      return { cat: cat, color: E.AR_CAT_COLORS[cat], val: fmt(S.customers.reduce(function (s, c) { return s + ((c.cat || '国内') === cat ? E.customerOutstanding(S, c.id) : 0); }, 0)) };
    });

    // ---- report ----
    var histPay = ser.reduce(function (a, s) { return s.isHist ? a + s.pays : a; }, 0);   // Paid (settled outflow)
    var fcstPay = totalPay - histPay;                                                     // expected future outflow
    var apOutstanding = (S.payables || []).reduce(function (a, p) { return E.payablePaid(p) ? a : a + E.payableAmt(S, p); }, 0);
    var profit = totalCin - totalPay;
    var repLines = [
      '本农历财年（' + fy + '）期初可用资金 ' + fmt(open0) + '，预计年末余额 ' + fmt(yearEnd) + '，较期初' + (yearEnd >= open0 ? '增长' : '下降') + ' ' + fmt(Math.abs(yearEnd - open0)) + '。',
      '全年预计收款 ' + fmt(totalCin) + '（实际 ' + fmt(histCin) + ' + 预测 ' + fmt(fcstCin) + '），合计支出 ' + fmt(totalPay) + '，全年净现金流 ' + (profit >= 0 ? '盈余' : '缺口') + ' ' + fmt(Math.abs(profit)) + '。',
      '现金最紧张出现在 ' + (minWeek ? minWeek.w.month + '月' : '—') + '，余额降至 ' + fmt(minClose) + (minClose < 1000000 ? '，需重点关注流动性' : '，整体安全') + '。',
      '应收账款合计 ' + fmt(arOut) + '，来自 ' + S.customers.length + ' 位客户，是后续回款的主要来源。'
    ];
    var repKpis = [
      { label: '期初可用资金', val: fmt(open0), color: 'var(--plum)' },
      { label: '全年收款', val: fmt(totalCin), color: 'var(--leaf)' },
      { label: '全年支出', val: fmt(totalPay), color: 'var(--rose)' },
      { label: '年末预计余额', val: fmt(yearEnd), color: 'var(--plum2)' }
    ];

    // ---- aggregate forecast variance over elapsed weeks ----
    var aN = 0, fN = 0, anyAct = false;
    ser.forEach(function (s) {
      if (!s.isHist) return;
      var fnet = E.fcOf(S, s.i, 'foreign') + E.fcOf(S, s.i, 'domestic') - E.PAYCATS.reduce(function (a, f) { return a + E.fcOf(S, s.i, f); }, 0);
      fN += fnet; aN += s.net;
      if (recDefs.concat(payRowDefs).some(function (d) { return E.acOf(S, s.i, d[0]) !== null; })) anyAct = true;
    });
    var varAgg = (anyAct && fN !== 0) ? (aN - fN) / Math.abs(fN) * 100 : null;
    var varAggStr = varAgg === null ? '尚无实际数据录入' : '已发生周实际净现金流较预测 ' + (varAgg >= 0 ? '+' : '') + varAgg.toFixed(1) + '%';
    var varAggColor = varAgg === null ? 'var(--muted)' : (varAgg >= 0 ? 'var(--leaf)' : 'var(--rose)');

    return {
      page: page, navItems: navItems, pageTitle: titles[page] ? titles[page][0] : '', pageSub: titles[page] ? titles[page][1] : '',
      cfg: S.config, fy: fy, unitLabel: '单位：' + S.config.unit,
      dashKpis: dashKpis, varAggStr: varAggStr, varAggColor: varAggColor,
      yTicks: yTicks, xTicks: xTicks, trajArea: trajArea, trajForecast: forecastPts, trajActual: actualPts, trajCommitted: committedPts, asOfX: asOfX, asOfWeekNo: curW + 1, asOfDate: asOfMD,
      monthBars: monthBars, dashDonut: dashDonut, totalPayWan: wan(totalPay) + '万',
      arTotalWan: fmt(arTotal), arCount: S.customers.length, arWeekCollectWan: fmt(arWeekCollect),
      selWeekLabel: selWk.label, selCloseWan: fmt(selRow.close),
      selNet: (selRow.net >= 0 ? '+' : '−') + fmt(Math.abs(selRow.net)), selNetColor: selRow.net >= 0 ? 'var(--leaf)' : 'var(--rose)',
      selFcNetWan: (selFcNet >= 0 ? '+' : '−') + fmt(Math.abs(selFcNet)),
      selVarStr: (hasActual ? (selVarP >= 0 ? '+' : '') + selVarP.toFixed(1) + '%' : '—'), selVarColor: !hasActual ? 'var(--muted)' : (selVarP >= 0 ? 'var(--leaf)' : 'var(--rose)'),
      histWeeks: histWeeks, fcstWeeks: fcstWeeks, allWeeks: allWeeks,
      salesRows: salesRows, salesQstr: salesQsum.toLocaleString('zh-CN'), salesAstr: fmt(salesAsum),
      fcstReceiptRows: fcstReceiptRows, fcstPayRows: fcstPayRows, histReceiptRows: histReceiptRows, histPayRows: histPayRows,
      revBreak: revBreak, revBreakForeign: revBreakForeign, revBreakDom: revBreakDom,
      shipmentRows: shipmentRows, supplierRows: supplierRows, supplierNames: supplierNames, payablesView: payablesView, bucketsMiao: bucketsMiao, bucketsHua: bucketsHua,
      freightTotal: fmt(freightTotal), overdueWan: fmt(overdueTotal), hasOverdue: overdueTotal > 0, weeksList: weeksList, curW: curW, urgencyOptions: E.URGENCY_OPTIONS,
      upcoming: upcoming, assumeGroups: assumeGroups, rents: S.rents, fixed: S.fixed,
      custRows: custRows, arOutWan: fmt(arOut), catSummary: catSummary, catOptions: E.AR_CATS,
      repCompany: S.config.name, repFy: fy, repKpis: repKpis, repLines: repLines,
      repProv: { cinHd: fmt(histCin), cinFd: fmt(fcstCin), cinAr: fmt(arTotal), payPaid: fmt(histPay), payFp: fmt(fcstPay), payAp: fmt(apOutstanding) }
    };
  }

  function merge(a, b) { var o = {}; for (var k in a) o[k] = a[k]; for (var j in b) o[j] = b[j]; return o; }

  // ===================================================================
  //  RENDERERS  (return HTML strings)
  // ===================================================================
  var FLD = 'border:1px solid var(--field-bd); background:var(--field); border-radius:7px; padding:6px 9px; font-size:13px;';

  function renderHeader(V) {
    var nav = V.navItems.map(function (n) {
      return '<button data-action="nav" data-page="' + n.id + '" style="display:flex; align-items:center; gap:6px; white-space:nowrap; border:1px solid ' + n.bd + '; cursor:pointer; padding:7px 10px; border-radius:9px; background:' + n.bg + '; color:' + n.color + '; font-size:12.5px; font-weight:' + n.weight + ';">' +
        '<span style="font-size:13px;">' + n.sym + '</span><span>' + esc(n.label) + '</span></button>';
    }).join('');

    return '' +
      '<header class="no-print bg-fabric" style="display:flex; align-items:center; gap:16px; padding:10px 24px; border-bottom:1px solid #d9cfb9; position:sticky; top:0; z-index:30;">' +
        '<div style="display:flex; align-items:center; gap:11px; flex:none;">' +
          logoBox(34, 9) +
          '<div style="line-height:1.18;">' +
            '<div style="font-weight:700; font-size:13.5px; letter-spacing:.2px; white-space:nowrap;">昆明统一生物科技有限公司</div>' +
            '<div style="font-size:10.5px; color:var(--muted); letter-spacing:1.5px;">财务分析系统 · v1.0</div>' +
          '</div>' +
        '</div>' +
        '<nav style="display:flex; align-items:center; justify-content:center; gap:2px; flex:1; margin:0 8px; flex-wrap:nowrap; overflow-x:auto;">' + nav + '</nav>' +
        '<div style="display:flex; align-items:center; gap:8px; flex:none;">' +
          (currentUser && currentUser.email ? '<span title="' + escA(currentUser.email) + '" style="font-size:11px; color:var(--muted); max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(currentUser.email) + '</span>' : '') +
          '<button data-action="logout" style="background:#fff; border:1px solid var(--field-bd); color:var(--plum2); font-size:11.5px; padding:7px 12px; border-radius:8px; cursor:pointer;">退出</button>' +
        '</div>' +
      '</header>' +
      '<header class="no-print bg-cloth" style="border-bottom:1px solid #564327; box-shadow:inset 0 1px 0 rgba(255,255,255,.08); padding:13px 28px; display:flex; align-items:center; gap:18px; flex-wrap:wrap;">' +
        '<div style="flex:none;">' +
          '<div style="font-size:18px; font-weight:700; letter-spacing:.3px; white-space:nowrap; color:#f7f2e7;">' + esc(V.pageTitle) + '</div>' +
          '<div style="font-size:12px; color:#d8cbb0; margin-top:1px; white-space:nowrap;">' + esc(V.pageSub) + '</div>' +
        '</div>' +
        '<div style="flex:1;"></div>' +
        '<div style="display:flex; align-items:center; gap:8px; background:rgba(255,255,255,.12); border:1px solid rgba(255,255,255,.2); border-radius:11px; padding:7px 11px; flex-wrap:wrap;">' +
          '<span style="font-size:11px; color:#ece0c8; font-weight:600;">农历财年</span>' +
          '<input class="fld" type="date" ' + bCfg('startISO') + ' value="' + escA(V.cfg.startISO) + '" style="border:1px solid var(--field-bd); background:var(--field); border-radius:7px; padding:5px 7px; font-size:12px; color:var(--ink);">' +
          '<span style="color:#ece0c8;">→</span>' +
          '<input class="fld" type="date" ' + bCfg('endISO') + ' value="' + escA(V.cfg.endISO) + '" style="border:1px solid var(--field-bd); background:var(--field); border-radius:7px; padding:5px 7px; font-size:12px; color:var(--ink);">' +
          '<span style="width:1px; height:20px; background:rgba(255,255,255,.2); margin:0 3px;"></span>' +
          '<span style="font-size:11px; color:#ece0c8; font-weight:600;">截至</span>' +
          '<input class="fld" type="date" ' + bCfg('asOfISO') + ' value="' + escA(V.cfg.asOfISO) + '" style="border:1px solid var(--field-bd); background:var(--field); border-radius:7px; padding:5px 7px; font-size:12px; color:var(--ink);">' +
          '<span style="width:1px; height:20px; background:rgba(255,255,255,.2); margin:0 3px;"></span>' +
          '<span style="font-size:11px; color:#ece0c8; font-weight:600;">起初资金(元)</span>' +
          '<input class="fld" inputmode="decimal" ' + bCfg('openingBalance') + ' value="' + escA(V.cfg.openingBalance) + '" title="农历财年起始可用资金（元）" style="width:118px; text-align:right; border:1px solid var(--field-bd); background:var(--field); border-radius:7px; padding:5px 7px; font-size:12px; color:var(--ink);">' +
        '</div>' +
        '<button data-action="toggleUnit" style="background:#f4efe3; color:#5a472b; border:none; border-radius:9px; padding:8px 14px; font-size:12.5px; font-weight:700; cursor:pointer;">' + esc(V.unitLabel) + '</button>' +
      '</header>';
  }

  function chips(list) {
    var arrow = function (dir, sym) {
      return '<button data-action="scrollChips" data-dir="' + dir + '" class="no-print" aria-label="' + (dir < 0 ? '更早的周' : '更晚的周') + '" style="flex:none; align-self:center; width:28px; height:28px; border:1px solid var(--line); background:#fff; color:var(--muted); border-radius:8px; cursor:pointer; font-size:16px; line-height:1; display:flex; align-items:center; justify-content:center;">' + sym + '</button>';
    };
    return '<div style="display:flex; align-items:stretch; gap:7px;">' + arrow(-1, '‹') +
      '<div class="chips" id="weekChipScroll" style="display:flex; gap:7px; overflow-x:auto; padding-bottom:4px; flex:1; min-width:0; scroll-behavior:smooth;">' +
        list.map(function (w) {
          return '<button data-action="selectWeek" data-idx="' + w.idx + '" style="flex:none; cursor:pointer; border:1px solid ' + w.selBd + '; background:' + w.selBg + '; color:' + w.selColor + '; border-radius:10px; padding:7px 12px 8px; min-width:90px; box-shadow:' + w.selShadow + ';">' +
            '<div style="font-size:9px; opacity:.7;">第' + (w.idx + 1) + '周 · ' + esc(w.month) + '</div>' +
            '<div class="num" style="font-size:12px; font-weight:600;">' + esc(w.label) + '</div>' +
            (w.net != null ? '<div class="num" style="font-size:10px; color:' + w.netColor + ';">' + esc(w.net) + '万</div>' : '') +
            '</button>';
        }).join('') +
      '</div>' + arrow(1, '›') +
    '</div>';
  }

  function cashChart(V, idprefix, dashedForecast) {
    var grid = [40, 100, 160, 220].map(function (y) { return '<line x1="44" y1="' + y + '" x2="1000" y2="' + y + '"></line>'; }).join('');
    var yt = V.yTicks.map(function (t) { return '<text x="38" y="' + t.y + '" text-anchor="end" class="num" style="font-size:10px; fill:var(--muted);">' + esc(t.label) + '</text>'; }).join('');
    var xt = V.xTicks.map(function (t) { return '<text x="' + t.x + '" y="244" text-anchor="middle" style="font-size:10px; fill:var(--muted);">' + esc(t.label) + '</text>'; }).join('');
    var dash = dashedForecast ? ' stroke-dasharray="2 4"' : '';
    return '<svg viewBox="0 0 1000 250" style="width:100%; height:auto; display:block;">' +
      '<g stroke="var(--line)" stroke-width="1">' + grid + '</g>' + yt +
      '<text x="10" y="18" style="font-size:9.5px; fill:var(--muted);">余额/万</text>' +
      '<path d="' + V.trajArea + '" fill="rgba(201,100,66,0.09)"></path>' +
      '<polyline points="' + V.trajForecast + '" fill="none" stroke="var(--orchid)" stroke-width="2"' + dash + ' stroke-linecap="round" stroke-linejoin="round"></polyline>' +
      (V.trajCommitted ? '<polyline points="' + V.trajCommitted + '" fill="none" stroke="#3f8f6b" stroke-width="2" stroke-dasharray="5 3" stroke-linecap="round" stroke-linejoin="round"></polyline>' : '') +
      '<polyline points="' + V.trajActual + '" fill="none" stroke="var(--plum)" stroke-width="2.5" stroke-linejoin="round"></polyline>' +
      '<line x1="' + V.asOfX + '" y1="28" x2="' + V.asOfX + '" y2="218" stroke="var(--gold)" stroke-width="1.5" stroke-dasharray="3 3"></line>' +
      '<text x="' + V.asOfX + '" y="11" text-anchor="middle" style="font-size:10px; fill:var(--gold); font-weight:700;">今日</text>' +
      '<text x="' + V.asOfX + '" y="22" text-anchor="middle" style="font-size:8.5px; fill:var(--gold);">第' + V.asOfWeekNo + '周 · ' + esc(V.asOfDate) + '</text>' +
      '<line id="' + idprefix + 'Guide" x1="0" y1="28" x2="0" y2="218" stroke="var(--plum2)" stroke-width="1" stroke-opacity="0.5" style="opacity:0;"></line>' +
      '<circle id="' + idprefix + 'DotF" r="4" fill="#fff" stroke="var(--orchid)" stroke-width="2" style="opacity:0;"></circle>' +
      '<circle id="' + idprefix + 'DotA" r="4" fill="#fff" stroke="var(--plum)" stroke-width="2" style="opacity:0;"></circle>' +
      '<rect id="cashHover" x="44" y="28" width="956" height="190" fill="transparent" style="cursor:crosshair;"></rect>' +
      xt + '</svg>';
  }

  function card(inner, extra) { return '<div style="background:#fff; border-radius:16px; padding:20px 22px; box-shadow:0 10px 30px -20px rgba(60,42,28,.34); border:1px solid var(--line);' + (extra || '') + '">' + inner + '</div>'; }
  // company mark — inline SVG (green check + red bud), no external asset
  function logoSVG(px) {
    return '<svg viewBox="0 0 110 110" width="' + px + '" height="' + px + '" style="display:block;" role="img" aria-label="logo">' +
      '<path d="M18 54 L47 88 L95 26" fill="none" stroke="#16a34a" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<ellipse cx="55" cy="35" rx="14" ry="18" fill="#e0231a"/></svg>';
  }
  function logoBox(px, radius) {
    return '<div style="width:' + px + 'px; height:' + px + 'px; border-radius:' + radius + 'px; background:#fff; border:1px solid var(--line); display:flex; align-items:center; justify-content:center; box-shadow:0 6px 16px -10px rgba(60,42,28,.4); flex:none;">' + logoSVG(Math.round(px * 0.72)) + '</div>';
  }
  function h2(t) { return '<div class="serif" style="font-size:17px; font-weight:700;">' + esc(t) + '</div>'; }

  // ---------- DASHBOARD ----------
  function renderDash(V) {
    var kpis = V.dashKpis.map(function (k) {
      return '<div style="background:#fff; border-radius:15px; padding:16px 17px; box-shadow:0 10px 28px -18px rgba(60,42,28,.4); border:1px solid var(--line);">' +
        '<div style="font-size:12px; color:var(--muted); margin-bottom:10px;">' + esc(k.label) + '</div>' +
        '<div class="num" style="font-size:20px; font-weight:600; color:' + k.color + '; white-space:nowrap;">' + esc(k.val) + '</div>' +
        '<div style="font-size:11px; color:' + k.subColor + '; margin-top:6px;">' + esc(k.sub) + '</div></div>';
    }).join('');

    var bars = V.monthBars.map(function (m) {
      return '<div style="flex:1; display:flex; flex-direction:column; align-items:center; gap:5px; height:100%; justify-content:flex-end;">' +
        '<div style="display:flex; gap:3px; align-items:flex-end; height:150px;">' +
          '<div style="width:9px; background:#5e8c5e; border-radius:3px 3px 0 0; height:' + m.inH + ';"></div>' +
          '<div style="width:9px; background:#c75a44; border-radius:3px 3px 0 0; height:' + m.outH + ';"></div>' +
        '</div><span style="font-size:10px; color:var(--muted);">' + esc(m.label) + '</span></div>';
    }).join('');

    var donutPaths = V.dashDonut.map(function (s) { return '<path d="' + s.d + '" fill="' + s.color + '"></path>'; }).join('');
    var donutLegend = V.dashDonut.map(function (s) {
      return '<div style="display:flex; align-items:center; gap:7px; margin-bottom:5px; font-size:11.5px;">' +
        '<span style="width:8px; height:8px; border-radius:2px; background:' + s.color + '; flex:none;"></span>' +
        '<span style="color:#4a4136; flex:1;">' + esc(s.k) + '</span>' +
        '<span class="num" style="color:var(--muted);">' + esc(s.pct) + '</span></div>';
    }).join('');

    return '<div>' +
      '<div class="kpi-row" style="display:grid; grid-template-columns:repeat(5,1fr); gap:14px; margin-bottom:18px;">' + kpis + '</div>' +
      card(
        '<div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:6px;">' +
          '<div><div class="serif" style="font-size:18px; font-weight:700;">全年现金轨迹</div>' +
          '<div style="font-size:12px; color:var(--muted); margin-top:3px;">每周末预计银行余额 · <b style="color:var(--plum);">实线＝实际</b>，<b style="color:var(--orchid);">橙点线＝预测(FD·贯穿全年)</b>，<b style="color:#3f8f6b;">绿点线＝已订(AR·应收，仅数周)</b> · <b style="color:' + V.varAggColor + ';">' + esc(V.varAggStr) + '</b></div></div>' +
          '<div style="display:flex; gap:14px; font-size:12px; flex-wrap:wrap;">' +
            '<span style="display:flex; align-items:center; gap:6px;"><span style="width:16px; height:3px; background:var(--plum); border-radius:2px; display:inline-block;"></span>实际</span>' +
            '<span style="display:flex; align-items:center; gap:6px;"><span style="width:16px; height:0; border-top:3px dashed var(--orchid); display:inline-block;"></span>预测 FD</span>' +
            '<span style="display:flex; align-items:center; gap:6px;"><span style="width:16px; height:0; border-top:3px dashed #3f8f6b; display:inline-block;"></span>已订 AR</span>' +
          '</div>' +
        '</div>' +
        '<div style="position:relative;">' + cashChart(V, 'cash', true) +
          '<div id="cashTip" style="position:absolute; transform:translate(-50%,-115%); background:#fffdf8; border:1px solid var(--line); border-radius:9px; padding:8px 11px; font-size:11.5px; box-shadow:0 8px 22px -10px rgba(60,42,28,.5); pointer-events:none; opacity:0; white-space:nowrap; z-index:5; min-width:120px;"></div>' +
        '</div>', ' margin-bottom:18px;') +
      '<div style="display:grid; grid-template-columns:1.5fr 1fr; gap:18px;">' +
        card('<div class="serif" style="font-size:17px; font-weight:700; margin-bottom:3px;">月度收款 vs 支出</div>' +
          '<div style="font-size:12px; color:var(--muted); margin-bottom:16px;">单位：万元</div>' +
          '<div style="display:flex; align-items:flex-end; gap:10px; height:180px;">' + bars + '</div>' +
          '<div style="display:flex; gap:18px; font-size:12px; margin-top:14px; padding-top:12px; border-top:1px solid var(--line);">' +
            '<span style="display:flex; align-items:center; gap:6px;"><span style="width:10px; height:10px; border-radius:3px; background:var(--leaf);"></span>收款</span>' +
            '<span style="display:flex; align-items:center; gap:6px;"><span style="width:10px; height:10px; border-radius:3px; background:var(--rose);"></span>支出</span></div>') +
        '<div style="display:flex; flex-direction:column; gap:18px;">' +
          card('<div class="serif" style="font-size:17px; font-weight:700; margin-bottom:12px;">全年支出结构</div>' +
            '<div style="display:flex; align-items:center; gap:16px;">' +
              '<svg viewBox="0 0 130 130" style="width:122px; height:122px; flex:none;">' + donutPaths +
                '<circle cx="65" cy="65" r="31" fill="#fff"></circle>' +
                '<text x="65" y="61" text-anchor="middle" style="font-size:10px; fill:var(--muted);">合计支出</text>' +
                '<text x="65" y="77" text-anchor="middle" class="num" style="font-size:12px; font-weight:600; fill:var(--plum2);">' + esc(V.totalPayWan) + '</text>' +
              '</svg><div style="flex:1;">' + donutLegend + '</div></div>') +
          '<div style="background:#c0613f; color:#fff; border-radius:16px; padding:20px 22px; box-shadow:0 14px 34px -18px rgba(60,42,28,.6);">' +
            '<div style="font-size:13px; color:#ecc6ab;">应收账款合计</div>' +
            '<div class="num" style="font-size:28px; font-weight:600; margin:6px 0 4px;">' + esc(V.arTotalWan) + '</div>' +
            '<div style="font-size:12px; color:#d2bfa6;">' + V.arCount + ' 位客户 · 预计本周回款 ' + esc(V.arWeekCollectWan) + '</div></div>' +
        '</div>' +
      '</div></div>';
  }

  // ---------- HISTORICAL ----------
  function renderHist(V) {
    var sales = V.salesRows.map(function (r) {
      return '<tr><td style="padding:5px 6px; border-bottom:1px solid #f1ebdf;"><span style="font-size:10px; color:var(--orchid); background:var(--lilac); padding:1px 6px; border-radius:5px; margin-right:7px;">' + esc(r.grp) + '</span>' + esc(r.name) + '</td>' +
        '<td style="padding:4px 6px; border-bottom:1px solid #f1ebdf;"><input class="fld" inputmode="numeric" ' + bMap('sales', r.qtyKey) + ' value="' + escA(r.qty) + '" placeholder="0" style="width:100%; text-align:right; ' + FLD + '"></td>' +
        '<td style="padding:4px 6px; border-bottom:1px solid #f1ebdf;"><input class="fld" inputmode="numeric" ' + bMap('sales', r.amtKey) + ' value="' + escA(r.amt) + '" placeholder="0" style="width:100%; text-align:right; ' + FLD + '"></td>' +
        '<td class="num" style="padding:5px 6px; border-bottom:1px solid #f1ebdf; text-align:right; color:var(--muted);">' + esc(r.price) + '</td></tr>';
    }).join('');

    var shipTypeOpt = function (sel) { return E.PTYPES.map(function (t) { return '<option value="' + t.id + '"' + (t.id === sel ? ' selected' : '') + '>' + (t.id === '花' ? '开花株' : '苗') + '</option>'; }).join(''); };
    var shipChanOpt = function (sel) { return E.CHANNELS.map(function (c) { return '<option value="' + escA(c) + '"' + (c === sel ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join(''); };
    var supplierOpt = function (sel) {
      var seen = {}, opts = '<option value="">— 供应商 —</option>';
      V.supplierNames.forEach(function (n) { if (n && !seen[n]) { seen[n] = 1; opts += '<option value="' + escA(n) + '"' + (n === sel ? ' selected' : '') + '>' + esc(n) + '</option>'; } });
      if (sel && !seen[sel]) opts += '<option value="' + escA(sel) + '" selected>' + esc(sel) + '</option>';
      return opts;
    };
    var supPanel = '<div style="margin-bottom:12px; padding:9px 11px; background:#faf6ee; border-radius:9px; display:flex; align-items:center; gap:7px; flex-wrap:wrap;">' +
      '<span style="font-size:12px; font-weight:600; color:var(--plum2); flex:none;">供应商名单</span>' +
      V.supplierRows.map(function (sp) {
        return '<span style="display:inline-flex; align-items:center; background:#fff; border:1px solid var(--field-bd); border-radius:7px; padding:1px 2px 1px 4px;">' +
          '<input class="fld txt" ' + bArr('suppliers', sp.idx, 'name') + ' value="' + escA(sp.name) + '" style="width:92px; border:none; background:transparent; font-size:12px; padding:3px 2px;">' +
          '<button data-action="delRow" data-arr="suppliers" data-idx="' + sp.idx + '" style="background:none; border:none; color:var(--rose); cursor:pointer; font-size:13px; opacity:.6;">×</button></span>';
      }).join('') +
      '<button data-action="addRow" data-arr="suppliers" style="background:var(--lilac); color:var(--plum); border:1px solid var(--field-bd); border-radius:7px; padding:4px 10px; font-size:11.5px; font-weight:600; cursor:pointer; flex:none;">+ 新增供应商</button></div>';
    function shipCell(r, key, val, mode) {
      return '<td style="padding:3px 4px; border-bottom:1px solid #f1ebdf;"><input class="fld' + (mode === 'txt' ? ' txt' : '') + '"' + (mode && mode !== 'txt' ? ' inputmode="' + mode + '"' : '') + ' ' + bArr('shipments', r.idx, key) + ' value="' + escA(val) + '" style="width:100%; ' + (mode === 'txt' ? '' : 'text-align:right; ') + 'border:1px solid var(--field-bd); background:var(--field); border-radius:6px; padding:5px 6px; font-size:12px;"></td>';
    }
    var ship = V.shipmentRows.map(function (r) {
      function selc(key, html) { return '<td style="padding:3px 4px; border-bottom:1px solid #f1ebdf;"><select class="fld txt" ' + bArr('shipments', r.idx, key) + ' style="width:100%; border:1px solid var(--field-bd); background:var(--field); border-radius:6px; padding:5px 4px; font-size:11.5px;">' + html + '</select></td>'; }
      return '<tr>' + selc('type', shipTypeOpt(r.type)) + selc('channel', shipChanOpt(r.channel)) +
        selc('supplier', supplierOpt(r.supplier)) + shipCell(r, 'spec', r.spec, 'txt') +
        shipCell(r, 'qty', r.qty, 'numeric') + shipCell(r, 'amount', r.amount, 'numeric') +
        '<td class="num" style="padding:3px 6px; border-bottom:1px solid #f1ebdf; text-align:right; color:var(--muted);">' + esc(r.unit) + '</td>' +
        shipCell(r, 'iq', r.iq, 'txt') +
        '<td style="padding:3px 4px; border-bottom:1px solid #f1ebdf; text-align:center;"><button data-action="delRow" data-arr="shipments" data-idx="' + r.idx + '" style="background:none; border:none; color:var(--rose); cursor:pointer; font-size:15px; opacity:.6;">×</button></td></tr>';
    }).join('');

    function cashRow(c) {
      return '<div style="display:flex; align-items:center; gap:10px; margin-bottom:7px;">' +
        '<span style="flex:1; font-size:13px;">' + esc(c.label) + '</span>' +
        '<input class="fld" inputmode="numeric" ' + bMap('actual', c.key) + ' value="' + escA(c.val) + '" placeholder="' + escA(c.ph) + '" style="width:138px; text-align:right; ' + FLD + '">' +
        '<span class="num" style="width:52px; text-align:right; font-size:11.5px; color:' + c.varColor + ';">' + esc(c.varPct) + '</span></div>';
    }

    return '<div>' +
      card('<div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:10px;">' +
        '<div style="font-size:13px; font-weight:700; color:var(--plum2);">选择周次 · 已发生（实际录入）</div>' +
        '<div style="display:flex; align-items:center; gap:8px; font-size:11.5px; color:var(--muted);"><span style="display:inline-flex; align-items:center; gap:5px;"><span style="width:13px; height:13px; border-radius:4px; background:var(--field); border:1px solid var(--field-bd);"></span>可输入</span><span style="display:inline-flex; align-items:center; gap:5px;"><span style="width:13px; height:13px; border-radius:4px; background:#f1ede2;"></span>自动计算</span></div></div>' +
        chips(V.histWeeks), ' margin-bottom:16px;') +
      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; align-items:start;">' +
        card('<div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:14px;">' + h2('销售明细 · ' + V.selWeekLabel) + '<div style="font-size:12px; color:var(--muted);">按渠道 × 规格 · 数量与金额录入，单价自动计算</div></div>' +
          '<table style="width:100%; border-collapse:collapse; font-size:13px;"><thead><tr style="color:var(--muted); font-size:11.5px;">' +
            '<th style="text-align:left; font-weight:500; padding:7px 6px; border-bottom:1px solid var(--line);">渠道 / 规格</th>' +
            '<th style="text-align:right; font-weight:500; padding:7px 6px; border-bottom:1px solid var(--line); width:160px;">数量（株）</th>' +
            '<th style="text-align:right; font-weight:500; padding:7px 6px; border-bottom:1px solid var(--line); width:180px;">金额（元）</th>' +
            '<th style="text-align:right; font-weight:500; padding:7px 6px; border-bottom:1px solid var(--line); width:110px;">平均单价</th></tr></thead>' +
          '<tbody>' + sales +
            '<tr style="font-weight:700; color:var(--plum2);"><td style="padding:10px 6px;">合计</td><td class="num" style="padding:10px 6px; text-align:right;">' + esc(V.salesQstr) + '</td><td class="num" style="padding:10px 6px; text-align:right;">' + esc(V.salesAstr) + '</td><td></td></tr>' +
          '</tbody></table>', ' grid-column:1 / -1;') +
        card('<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; flex-wrap:wrap; gap:8px;"><div>' + h2('进货验货 · 按供应商') + '<div style="font-size:12px; color:var(--muted);">各供应商批次：类型 · 渠道 · 规格 · 数量 · 金额（单价自动）· IQ号 → 路由至「苗/花应付款」；运费见「物流成本」</div></div>' +
          '<button data-action="addRow" data-arr="shipments" style="background:var(--lilac); color:var(--plum); border:1px solid var(--field-bd); border-radius:8px; padding:7px 13px; font-size:12.5px; font-weight:600; cursor:pointer; white-space:nowrap;">+ 添加进货验货项目</button></div>' +
          supPanel +
          '<div style="overflow-x:auto;"><table style="border-collapse:collapse; font-size:12px; min-width:900px; width:100%;"><thead><tr style="color:var(--muted); font-size:11px;">' +
            ['类型', '渠道', '供应商', '规格', '数量(株)', '金额(元)', '单价', 'IQ号'].map(function (t, i) { return '<th style="text-align:' + (i >= 4 && i <= 6 ? 'right' : 'left') + '; font-weight:500; padding:6px 5px; border-bottom:1px solid var(--line);">' + t + '</th>'; }).join('') +
            '<th style="width:28px; border-bottom:1px solid var(--line);"></th></tr></thead>' +
          '<tbody>' + (ship || '<tr><td colspan="9" style="padding:14px; text-align:center; color:var(--muted); font-size:12px;">暂无批次 · 点击「+ 添加进货验货项目」录入供应商到货</td></tr>') + '</tbody></table></div>', ' grid-column:1 / -1;') +
        card(h2('现金流实际') + '<div style="font-size:12px; color:var(--muted); margin:4px 0 14px;">把当周预测改为实际（元）· 灰字为原预测值 · 右侧为偏差</div>' +
          '<div style="font-size:11px; color:var(--leaf); font-weight:700; margin:4px 0 8px;">收款</div>' + V.histReceiptRows.map(cashRow).join('') +
          '<div style="font-size:11px; color:var(--rose); font-weight:700; margin:14px 0 8px;">付款</div>' + V.histPayRows.map(cashRow).join('') +
          '<div style="display:flex; justify-content:space-between; margin-top:14px; padding-top:12px; border-top:1px solid var(--line);">' +
            '<div><div style="font-size:11px; color:var(--muted);">实际净额</div><div class="num" style="font-size:15px; font-weight:600; color:' + V.selNetColor + ';">' + esc(V.selNet) + '</div></div>' +
            '<div style="text-align:center;"><div style="font-size:11px; color:var(--muted);">原预测净额</div><div class="num" style="font-size:15px; font-weight:600; color:var(--muted);">' + esc(V.selFcNetWan) + '</div></div>' +
            '<div style="text-align:right;"><div style="font-size:11px; color:var(--muted);">净额偏差</div><div class="num" style="font-size:15px; font-weight:700; color:' + V.selVarColor + ';">' + esc(V.selVarStr) + '</div></div>' +
          '</div>') +
      '</div></div>';
  }

  // ---------- FORECAST ----------
  function renderFcst(V) {
    function ovRow(c) {
      return '<div style="margin-bottom:7px;">' +
        '<div style="display:flex; align-items:center; gap:10px;">' +
          '<span style="flex:1; font-size:13px;">' + esc(c.label) + '</span>' +
          '<input class="fld" inputmode="numeric" ' + bMap('fcst', c.key) + ' value="' + escA(c.val) + '" placeholder="' + escA(c.ph) + '" style="width:150px; text-align:right; ' + FLD + '"></div>' +
        (c.sub ? '<div style="font-size:10.5px; color:var(--gold); margin-top:2px;">' + esc(c.sub) + '</div>' : '') +
        '</div>';
    }
    var up = V.upcoming.map(function (m) {
      return '<tr style="text-align:right; background:' + m.rowBg + ';">' +
        '<td style="text-align:left; padding:8px 6px; border-bottom:1px solid #f1ebdf; font-weight:600;">' + esc(m.label) + '</td>' +
        '<td style="padding:8px 6px; border-bottom:1px solid #f1ebdf;"><span style="font-size:10px; color:' + m.tagColor + ';">' + esc(m.tag) + '</span></td>' +
        '<td class="num" style="padding:8px 6px; border-bottom:1px solid #f1ebdf; color:var(--leaf);">' + esc(m.cin) + '</td>' +
        '<td class="num" style="padding:8px 6px; border-bottom:1px solid #f1ebdf; color:var(--rose);">' + esc(m.pays) + '</td>' +
        '<td class="num" style="padding:8px 6px; border-bottom:1px solid #f1ebdf; color:' + m.netColor + ';">' + esc(m.net) + '</td>' +
        '<td class="num" style="padding:8px 6px; border-bottom:1px solid #f1ebdf; font-weight:600;">' + esc(m.close) + '</td></tr>';
    }).join('');

    var foreign = V.revBreakForeign.map(function (r) {
      return '<div style="display:flex; align-items:center; gap:8px; font-size:12.5px; margin-bottom:8px;"><span style="flex:1; color:#4a4136;">' + esc(r.label) + '</span><span class="num" style="color:var(--muted);">' + esc(r.qty) + ' 株 × ' + esc(r.price) + '</span><span class="num" style="width:80px; text-align:right; font-weight:600;">' + esc(r.amt) + '</span></div>';
    }).join('');
    var dom = V.revBreakDom.map(function (r) {
      return '<div style="display:flex; align-items:center; gap:8px; font-size:12.5px; margin-bottom:8px;"><span style="flex:1; color:#4a4136;">' + esc(r.label) + '</span><span class="num" style="color:var(--muted);">' + esc(r.qty) + ' 株 × ' + esc(r.price) + '</span><span class="num" style="width:80px; text-align:right; font-weight:600;">' + esc(r.amt) + '</span></div>';
    }).join('');

    return '<div>' +
      card('<div style="font-size:13px; font-weight:700; color:var(--plum2); margin-bottom:10px;">选择预测周次 · 默认由假设自动生成，可逐项覆盖</div>' + chips(V.fcstWeeks), ' margin-bottom:16px;') +
      '<div style="display:grid; grid-template-columns:380px 1fr; gap:16px; align-items:start;">' +
        card('<div class="serif" style="font-size:17px; font-weight:700;">' + esc(V.selWeekLabel) + ' 预测</div>' +
          '<div style="font-size:12px; color:var(--muted); margin:3px 0 14px;">留空＝采用该周假设值（灰色提示）· 填写＝手动覆盖</div>' +
          '<div style="font-size:11px; color:var(--leaf); font-weight:700; margin:4px 0 8px;">收款</div>' + V.fcstReceiptRows.map(ovRow).join('') +
          '<div style="font-size:11px; color:var(--rose); font-weight:700; margin:14px 0 8px;">付款</div>' + V.fcstPayRows.map(ovRow).join('') +
          '<div style="margin-top:14px; padding-top:12px; border-top:1px solid var(--line); display:flex; justify-content:space-between; align-items:center;"><span style="font-size:12px; color:var(--muted);">本周末预计余额</span><span class="num" style="font-size:18px; font-weight:700; color:var(--plum);">' + esc(V.selCloseWan) + '</span></div>') +
        card('<div class="serif" style="font-size:17px; font-weight:700; margin-bottom:14px;">未来 9 周现金流（万元）</div>' +
          '<table style="width:100%; border-collapse:collapse; font-size:13px;"><thead><tr style="color:var(--muted); font-size:11.5px; text-align:right;">' +
            '<th style="text-align:left; font-weight:500; padding:8px 6px; border-bottom:1px solid var(--line);">周次</th><th style="font-weight:500; padding:8px 6px; border-bottom:1px solid var(--line);">类型</th><th style="font-weight:500; padding:8px 6px; border-bottom:1px solid var(--line);">收款</th><th style="font-weight:500; padding:8px 6px; border-bottom:1px solid var(--line);">支出</th><th style="font-weight:500; padding:8px 6px; border-bottom:1px solid var(--line);">净额</th><th style="font-weight:500; padding:8px 6px; border-bottom:1px solid var(--line);">周末余额</th></tr></thead>' +
          '<tbody>' + up + '</tbody></table>' +
          '<div style="font-size:11.5px; color:var(--muted); margin-top:12px;">提示：预测金额由「假设」页的命名因子驱动（单价、回款率、销量、淘汰率、成本、租金计划等）。修改对应周的假设，此处实时更新。</div>') +
      '</div>' +
      card('<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">' + h2('收款测算 · ' + V.selWeekLabel + '（每周 · 元）') + '<span style="font-size:11.5px; color:var(--gold); background:#f6edda; padding:4px 10px; border-radius:7px;">已扣除预测淘汰率 ' + esc(V.revBreak.defect) + '</span></div>' +
        '<div style="font-size:12px; color:var(--muted); margin-bottom:16px;">数量 × 单价 → 预测收款（FD：各渠道大花 + 小花 + 染色花 + 切花，再 × 当周回款率）· 应收账款（已订 AR）<b>并列显示、不计入 FD</b>，仅供对比</div>' +
        '<div style="display:grid; grid-template-columns:1fr 1.4fr; gap:22px;">' +
          '<div><div style="font-size:13px; font-weight:700; color:var(--gold); margin-bottom:10px;">国外收款</div>' + foreign +
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px; padding-top:8px; border-top:1px dashed var(--line); font-size:12px; color:var(--muted);"><span>国外毛收入小计</span><span class="num">' + esc(V.revBreak.foreignGross) + '</span></div>' +
            '<div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; color:var(--muted); margin-top:4px;"><span>× 当周回款率 ' + esc(V.revBreak.collectRate) + '</span><span class="num">' + esc(V.revBreak.foreignSales) + '</span></div>' +
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; padding-top:10px; border-top:1px solid var(--line);"><span style="font-size:13px; font-weight:700; color:var(--orchid);">预测收款 (FD)</span><span class="num" style="font-size:16px; font-weight:700; color:var(--orchid);">' + esc(V.revBreak.foreignTotal) + '</span></div>' +
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px;"><span style="font-size:13px; font-weight:700; color:#3f8f6b;">应收账款 (已订 AR)</span><span class="num" style="font-size:16px; font-weight:700; color:#3f8f6b;">' + esc(V.revBreak.arForeign) + '</span></div></div>' +
          '<div><div style="font-size:13px; font-weight:700; color:var(--plum); margin-bottom:10px;">国内收款</div>' + dom +
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px; padding-top:8px; border-top:1px dashed var(--line); font-size:12px; color:var(--muted);"><span>国内毛收入小计</span><span class="num">' + esc(V.revBreak.domGross) + '</span></div>' +
            '<div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; color:var(--muted); margin-top:4px;"><span>× 当周回款率 ' + esc(V.revBreak.collectRate) + '</span><span class="num">' + esc(V.revBreak.domSales) + '</span></div>' +
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; padding-top:10px; border-top:1px solid var(--line);"><span style="font-size:13px; font-weight:700; color:var(--orchid);">预测收款 (FD)</span><span class="num" style="font-size:16px; font-weight:700; color:var(--orchid);">' + esc(V.revBreak.domesticTotal) + '</span></div>' +
            '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px;"><span style="font-size:13px; font-weight:700; color:#3f8f6b;">应收账款 (已订 AR)</span><span class="num" style="font-size:16px; font-weight:700; color:#3f8f6b;">' + esc(V.revBreak.arCollect) + '</span></div></div>' +
        '</div>', ' margin-top:16px;') +
    '</div>';
  }

  // ---------- ASSUMPTIONS ----------
  function renderAssume(V) {
    var groups = V.assumeGroups.map(function (g) {
      var fields = g.fields.map(function (f) {
        return '<div style="display:flex; align-items:center; gap:12px; margin-bottom:9px;">' +
          '<div style="flex:1;"><div style="font-size:13px;">' + esc(f.label) + (f.badge ? ' <span style="font-size:10px; color:#fff; background:' + f.badgeColor + '; padding:1px 6px; border-radius:5px; margin-left:4px;">' + esc(f.badge) + '</span>' : '') + '</div>' +
          (f.hint ? '<div style="font-size:10.5px; color:var(--muted);">' + esc(f.hint) + '</div>' : '') + '</div>' +
          '<input class="fld" inputmode="decimal" ' + bMap('assumeWeek', f.key) + ' value="' + escA(f.val) + '" placeholder="' + escA(f.ph) + '" style="width:128px; text-align:right; border:1px solid var(--field-bd); background:var(--field); border-radius:7px; padding:7px 9px; font-size:13.5px; font-weight:600;">' +
          '<span style="font-size:11px; color:var(--muted); width:42px;">' + esc(f.unit) + '</span></div>';
      }).join('');
      var customs = g.custom.map(function (f) {
        return '<div style="display:flex; align-items:center; gap:8px; margin-bottom:9px; padding-top:9px; border-top:1px dashed var(--line);">' +
          '<input class="fld txt" ' + bArr('customItems', f.custIdx, 'name') + ' value="' + escA(f.name) + '" style="flex:1; min-width:0; border:1px solid var(--field-bd); background:var(--field); border-radius:7px; padding:6px 8px; font-size:12.5px;">' +
          '<input class="fld" inputmode="decimal" ' + bMap('assumeWeek', f.key) + ' value="' + escA(f.val) + '" placeholder="' + escA(f.ph) + '" style="width:100px; text-align:right; border:1px solid var(--field-bd); background:var(--field); border-radius:7px; padding:6px 8px; font-size:13px; font-weight:600;">' +
          '<input class="fld txt" ' + bArr('customItems', f.custIdx, 'unit') + ' value="' + escA(f.unit) + '" style="width:48px; border:1px solid var(--field-bd); background:var(--field); border-radius:7px; padding:6px 4px; font-size:10.5px; text-align:center;">' +
          '<button data-action="delCustom" data-id="' + escA(f.id) + '" style="background:none; border:none; color:var(--rose); cursor:pointer; font-size:15px; opacity:.6;">×</button></div>';
      }).join('');
      return card('<div style="display:flex; align-items:center; gap:10px; margin-bottom:4px;">' +
        '<span style="width:30px; height:30px; border-radius:9px; background:var(--lilac); color:var(--plum); display:flex; align-items:center; justify-content:center; font-size:15px; font-weight:700;">' + esc(g.sym) + '</span>' +
        '<div class="serif" style="font-size:16px; font-weight:700; flex:1;">' + esc(g.title) + '</div>' +
        (['seed', 'material', 'opex'].indexOf(g.gid) >= 0 ? '<button data-action="addAssume" data-group="' + g.gid + '" style="background:var(--lilac); color:var(--plum); border:1px solid var(--field-bd); border-radius:8px; padding:5px 10px; font-size:11.5px; font-weight:600; cursor:pointer;">+ 新增项目</button>' : '') + '</div>' +
        '<div style="font-size:12px; color:var(--muted); margin:0 0 14px 40px;">' + esc(g.desc) + '</div>' + fields + customs);
    }).join('');

    function schedTable(title, desc, arr, rows, addLabel, ph) {
      var body = rows.map(function (r, i) {
        return '<tr>' +
          '<td style="padding:4px 6px; border-bottom:1px solid #f1ebdf;"><input class="fld txt" ' + bArr(arr, i, 'name') + ' value="' + escA(r.name) + '" style="width:100%; border:1px solid var(--field-bd); background:var(--field); border-radius:6px; padding:6px 8px; font-size:13px;"></td>' +
          '<td style="padding:4px 6px; border-bottom:1px solid #f1ebdf;"><input class="fld" inputmode="numeric" ' + bArr(arr, i, 'amount') + ' value="' + escA(r.amount) + '" style="width:100%; text-align:right; border:1px solid var(--field-bd); background:var(--field); border-radius:6px; padding:6px 8px; font-size:13px;"></td>' +
          '<td style="padding:4px 6px; border-bottom:1px solid #f1ebdf;"><input class="fld" ' + bArr(arr, i, 'months') + ' value="' + escA(r.months) + '" placeholder="' + escA(ph) + '" style="width:100%; border:1px solid var(--field-bd); background:var(--field); border-radius:6px; padding:6px 8px; font-size:13px;"></td>' +
          '<td style="padding:4px 6px; border-bottom:1px solid #f1ebdf; text-align:center;"><button data-action="delRow" data-arr="' + arr + '" data-idx="' + i + '" style="background:none; border:none; color:var(--rose); cursor:pointer; font-size:16px; opacity:.6;">×</button></td></tr>';
      }).join('');
      return card('<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;"><div>' + h2(title) + '<div style="font-size:12px; color:var(--muted);">' + esc(desc) + '</div></div>' +
        '<button data-action="addRow" data-arr="' + arr + '" style="background:var(--lilac); color:var(--plum); border:1px solid var(--field-bd); border-radius:8px; padding:7px 13px; font-size:12.5px; font-weight:600; cursor:pointer;">' + esc(addLabel) + '</button></div>' +
        '<table style="width:100%; border-collapse:collapse; font-size:13px;"><thead><tr style="color:var(--muted); font-size:11.5px;">' +
          '<th style="text-align:left; font-weight:500; padding:7px 6px; border-bottom:1px solid var(--line);">' + (arr === 'rents' ? '基地 / 项目' : '项目') + '</th>' +
          '<th style="text-align:right; font-weight:500; padding:7px 6px; border-bottom:1px solid var(--line); width:180px;">每次金额（元）</th>' +
          '<th style="text-align:left; font-weight:500; padding:7px 6px; border-bottom:1px solid var(--line); width:150px;">到期月份</th>' +
          '<th style="width:40px; border-bottom:1px solid var(--line);"></th></tr></thead><tbody>' + body + '</tbody></table>', ' grid-column:1 / -1;');
    }

    return '<div>' +
      card('<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;"><div style="font-size:13px; font-weight:700; color:var(--plum2);">选择周次 · 各周假设独立，留空＝继承上一周</div><div style="font-size:11.5px; color:var(--muted);">正在编辑：<b style="color:var(--plum);">' + esc(V.selWeekLabel) + '</b> 的假设</div></div>' + chips(V.allWeeks), ' margin-bottom:16px;') +
      '<div style="display:grid; grid-template-columns:repeat(2,1fr); gap:16px; align-items:start;">' + groups +
        schedTable('租金计划 · 按基地', '每处基地的租金、金额与到期月份（逗号分隔，如 5,11 表示 5 月与 11 月各付一次）', 'rents', V.rents, '+ 新增基地', '如 5,11') +
        schedTable('固定支出与保险', '房贷、车辆/人寿/出口保险、软件与专利年费等长期固定支付', 'fixed', V.fixed, '+ 新增条目', '如 1,4,7,10') +
      '</div></div>';
  }

  // week-tile picker: months listed, current week highlighted (gold), selected
  // (leaf); hovering a tile shows its distance from "today" (+x周 / 本周).
  function weekPicker(arr, idx, key, sel, V) {
    var W = V.weeksList, cur = V.curW;
    // selectable weeks: current week and later only (no past / negative)
    var byMonth = {}, order = [];
    W.forEach(function (w) { if (w.idx < cur) return; if (!byMonth[w.month]) { byMonth[w.month] = []; order.push(w.month); } byMonth[w.month].push(w); });
    var months = order.map(function (m) {
      var tiles = byMonth[m].map(function (w) {
        var isSel = w.idx === sel, isCur = w.idx === cur, diff = w.idx - cur;
        var tip = diff === 0 ? '本周' : '+' + diff + '周';
        var bg = isSel ? 'var(--leaf)' : (isCur ? '#f6edda' : '#fff');
        var col = isSel ? '#fff' : 'var(--ink)';
        var bd = isSel ? 'var(--leaf)' : (isCur ? 'var(--gold)' : 'var(--line)');
        return '<button data-action="pickWeek" data-arr="' + arr + '" data-idx="' + idx + '" data-key="' + key + '" data-week="' + w.idx + '" title="' + tip + '" style="flex:none; cursor:pointer; border:1px solid ' + bd + '; background:' + bg + '; color:' + col + '; border-radius:6px; padding:2px 6px; font-size:9.5px; line-height:1.2; min-width:46px;' + (isCur && !isSel ? ' font-weight:700;' : '') + '"><div style="font-size:8px; opacity:.65;">第' + (w.idx + 1) + '周' + (isCur ? '·本周' : '') + '</div><div class="num">' + esc(w.label) + '</div></button>';
      }).join('');
      return '<details style="margin-bottom:3px;"><summary style="font-size:11px; color:var(--plum2); font-weight:600; padding:3px 6px; background:#faf6ee; border-radius:6px;">' + m + '月 · ' + byMonth[m].length + '周</summary><div style="display:flex; flex-wrap:wrap; gap:3px; padding:5px 2px 2px;">' + tiles + '</div></details>';
    }).join('');
    var selW = (sel === '' || sel == null) ? null : W[sel];
    var trigger = selW ? ('已选 第' + (selW.idx + 1) + '周 · ' + esc(selW.label)) : '点击选择周次';
    return '<details style="border:1px solid var(--line); border-radius:8px; background:#fffdf8;">' +
      '<summary style="padding:7px 10px; font-size:12px; font-weight:600; color:' + (selW ? 'var(--leaf)' : 'var(--muted)') + '; display:flex; justify-content:space-between; align-items:center; gap:8px;"><span>' + trigger + '</span><span style="color:var(--muted); font-size:10px; flex:none;">▾ 选择月/周</span></summary>' +
      '<div style="max-height:200px; overflow-y:auto; padding:6px 8px; border-top:1px solid var(--line);">' + (months || '<div style="font-size:11px; color:var(--muted); padding:6px;">无可选周次</div>') + '</div>' +
    '</details>';
  }

  // ---------- 苗 / 花 应付款 (combined; 国内/国外; week-keyed; bucket summary) --
  function renderSeedpay(V) {
    var opts = function (sel) { return V.urgencyOptions.map(function (u) { return '<option value="' + escA(u) + '"' + (u === sel ? ' selected' : '') + '>' + esc(u) + '</option>'; }).join(''); };
    function shipOptions(sel) {
      var bySup = {}, order = [];
      V.shipmentRows.forEach(function (sh) { if (!bySup[sh.supplier]) { bySup[sh.supplier] = []; order.push(sh.supplier); } bySup[sh.supplier].push(sh); });
      var groups = order.map(function (sup) {
        return '<optgroup label="' + escA(sup) + '">' + bySup[sup].map(function (sh) {
          var lbl = (sh.type === '花' ? '开花株' : '苗') + ' · ' + (sh.spec || '—') + (sh.iq ? ' · ' + sh.iq : '') + (sh.qty ? ' · ' + sh.qty + '株' : '');
          return '<option value="' + escA(sh.id) + '"' + (sh.id === sel ? ' selected' : '') + '>' + esc(lbl) + '</option>';
        }).join('') + '</optgroup>';
      }).join('');
      return '<option value="">— 选择批次（供应商 / 规格 / IQ号）—</option>' + groups;
    }
    function bucketTable(bf) {
      var BK = [['overdue', '欠款(逾期)', 'var(--rose)'], ['thisWeek', '本周', 'var(--plum)'], ['nextWeek', '下周', 'var(--gold)'], ['thisMonth', '本月内', 'var(--leaf)'], ['total', '合计', 'var(--plum2)']];
      var head = '<tr style="color:var(--muted); font-size:10px;"><th style="text-align:left; font-weight:500; padding:3px 5px; border-bottom:1px solid var(--line);">类别</th>' +
        V.urgencyOptions.map(function (u) { return '<th style="text-align:right; font-weight:600; padding:3px 5px; border-bottom:1px solid var(--line); color:' + (E.URGENCY_COLORS[u] || 'var(--muted)') + ';">' + esc(u) + '</th>'; }).join('') +
        '<th style="text-align:right; font-weight:700; padding:3px 5px; border-bottom:1px solid var(--line);">合计</th></tr>';
      var body = BK.map(function (bk) {
        return '<tr><td style="padding:3px 5px; border-bottom:1px solid #f3eee2; font-size:11px; color:' + bk[2] + '; font-weight:600;">' + bk[1] + '</td>' +
          V.urgencyOptions.map(function (u) { return '<td class="num" style="text-align:right; padding:3px 5px; border-bottom:1px solid #f3eee2; font-size:10.5px;">' + esc(bf[bk[0]][u]) + '</td>'; }).join('') +
          '<td class="num" style="text-align:right; padding:3px 5px; border-bottom:1px solid #f3eee2; font-weight:700; font-size:10.5px;">' + esc(bf._t[bk[0]]) + '</td></tr>';
      }).join('');
      return '<table style="width:100%; border-collapse:collapse;">' + head + body + '</table>';
    }
    function typeBlock(label, bf) {
      return card('<div class="serif" style="font-size:16px; font-weight:700; margin-bottom:10px;">' + label + ' · 应付汇总（按紧急度）</div>' +
        E.CHANNELS.map(function (ch) {
          return '<div style="margin-bottom:12px;"><div style="font-size:12px; font-weight:600; color:var(--plum2); margin-bottom:4px;">' + ch + '</div>' + bucketTable(bf[ch]) + '</div>';
        }).join(''));
    }
    var entries = V.payablesView.map(function (p) {
      var tag = (p.type === '花' ? '开花株' : '苗') + ' · ' + p.channel;
      return '<div style="border:1px solid var(--line); border-radius:11px; padding:12px 14px; margin-bottom:10px; background:' + (p.paid ? '#f6f4ef' : '#fff') + ';' + (p.paid ? ' opacity:.72;' : '') + '">' +
        '<div style="display:flex; align-items:center; gap:10px; margin-bottom:8px; flex-wrap:wrap;">' +
          '<span style="font-size:10.5px; font-weight:700; color:#fff; background:' + (p.type === '花' ? 'var(--gold)' : 'var(--plum)') + '; padding:2px 8px; border-radius:6px;">' + esc(tag) + '</span>' +
          '<select class="fld txt" ' + bArr('payables', p.idx, 'shipmentId') + ' style="flex:1; min-width:210px; border:1px solid var(--field-bd); background:var(--field); border-radius:7px; padding:6px 8px; font-size:12px;">' + shipOptions(p.shipmentId) + '</select>' +
          '<button data-action="delRow" data-arr="payables" data-idx="' + p.idx + '" style="background:none; border:none; color:var(--rose); cursor:pointer; font-size:16px; opacity:.6;">×</button>' +
        '</div>' +
        '<div style="display:flex; gap:16px; flex-wrap:wrap; align-items:flex-end; margin-bottom:8px;">' +
          '<div style="font-size:11px; color:var(--muted);">数量(株)<div class="num" style="font-size:13px; color:var(--ink);">' + esc(p.qty || '—') + '</div></div>' +
          '<div style="font-size:11px; color:var(--muted);">IQ号<div class="num" style="font-size:13px; color:var(--ink);">' + esc(p.iq || '—') + '</div></div>' +
          '<div style="font-size:11px; color:var(--muted);">应付金额(元)<input class="fld" inputmode="numeric" ' + bArr('payables', p.idx, 'amount') + ' value="' + escA(p.amount) + '" placeholder="' + escA(p.amountFull) + '" style="display:block; width:130px; text-align:right; ' + FLD + '"></div>' +
          '<div style="font-size:11px; color:var(--muted);">紧急度<select class="fld txt" ' + bArr('payables', p.idx, 'urgency') + ' style="display:block; width:82px; border:1px solid var(--field-bd); background:var(--field); border-radius:7px; padding:6px 4px; font-size:12px; font-weight:600; color:' + p.uColor + ';">' + opts(p.urgency) + '</select></div>' +
          '<div style="font-size:11px; color:var(--muted);">状态<button data-action="togglePaid" data-idx="' + p.idx + '" title="标记已付：移出应付汇总并停止逾期滚入" style="display:block; margin-top:2px; border:1px solid var(--field-bd); border-radius:7px; padding:6px 14px; font-size:12px; font-weight:700; cursor:pointer; background:' + (p.paid ? '#e7f0e2' : '#fff') + '; color:' + (p.paid ? 'var(--leaf)' : 'var(--muted)') + ';">' + (p.paid ? '已付' : '未付') + '</button></div>' +
        '</div>' +
        '<div style="font-size:11px; color:var(--muted); margin-bottom:3px;">付款周（金色＝本周 · 绿色＝已选 · 悬停看距今 +x周）</div>' + weekPicker('payables', p.idx, 'payWeek', p.payWeek, V) +
      '</div>';
    }).join('');

    return '<div>' +
      (V.hasOverdue ? '<div style="background:#fbe7e2; border:1px solid #f0cfc6; border-radius:11px; padding:11px 14px; margin-bottom:14px; font-size:12.5px; color:#a23a28;">⚠ 逾期应付合计 <b>' + esc(V.overdueWan) + '</b> — 已计入现金轨迹「已订 (AR)」线本周应付；点对应条目「已付」可移出。</div>' : '') +
      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:16px;">' + typeBlock('苗款', V.bucketsMiao) + typeBlock('开花株款', V.bucketsHua) + '</div>' +
      card('<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:8px;"><div>' + h2('应付款登记') + '<div style="font-size:12px; color:var(--muted);">选择进货验货批次 → 应付金额（默认全额，可拆分/部分付）· 紧急度 · 付款周</div></div>' +
        '<button data-action="addRow" data-arr="payables" style="background:var(--lilac); color:var(--plum); border:1px solid var(--field-bd); border-radius:8px; padding:7px 13px; font-size:12.5px; font-weight:600; cursor:pointer;">+ 新增应付款</button></div>' +
        (entries || '<div style="padding:16px; text-align:center; color:var(--muted); font-size:12px;">暂无应付款 · 先在「历史数据 · 进货验货」录入批次，再点「+ 新增应付款」选择批次并设定付款周</div>')) +
    '</div>';
  }

  // ---------- 物流成本 (freight per shipment → 生产物资运费 cash flow) --------
  function renderLogi(V) {
    var rows = V.shipmentRows.map(function (r) {
      var picked = r.freightWeek === '' ? '<span style="font-size:11px; color:var(--muted);">未设置</span>' : '<span style="font-size:11px; color:var(--plum2); font-weight:600;">第' + (r.freightWeek + 1) + '周</span>';
      return '<div style="border:1px solid var(--line); border-radius:11px; padding:12px 14px; margin-bottom:10px; background:#fff;">' +
        '<div style="display:flex; gap:14px; align-items:flex-end; flex-wrap:wrap; margin-bottom:8px;">' +
          '<div style="font-size:11px; color:var(--muted); min-width:160px; flex:1;">供应商 / 规格<div style="font-size:13px; color:var(--ink);">' + esc(r.supplier || '—') + ' · ' + esc(r.spec || '—') + (r.iq ? ' · ' + esc(r.iq) : '') + '</div></div>' +
          '<div style="font-size:11px; color:var(--muted);">运费(元)<input class="fld" inputmode="numeric" ' + bArr('shipments', r.idx, 'freight') + ' value="' + escA(r.freight) + '" placeholder="0" style="display:block; width:130px; text-align:right; ' + FLD + '"></div>' +
          '<div style="font-size:11px; color:var(--muted);">付款周 ' + picked + '</div>' +
        '</div>' +
        '<div style="font-size:11px; color:var(--muted); margin-bottom:3px;">运费付款周（计入该周「生产物资运费」）</div>' + weekPicker('shipments', r.idx, 'freightWeek', r.freightWeek, V) +
      '</div>';
    }).join('');
    return '<div>' +
      '<div style="display:grid; grid-template-columns:1.3fr 2fr; gap:14px; margin-bottom:16px;">' +
        '<div style="background:#b07a52; color:#fff; border-radius:15px; padding:18px 20px;"><div style="font-size:13px; color:#f0ddc9;">物流成本（运费）合计</div><div class="num" style="font-size:27px; font-weight:600; margin-top:6px;">' + esc(V.freightTotal) + '</div></div>' +
        '<div style="background:#fff; border-radius:15px; padding:18px 20px; box-shadow:0 10px 30px -20px rgba(60,42,28,.34); border:1px solid var(--line); display:flex; align-items:center;"><div style="font-size:11.5px; color:var(--muted); line-height:1.6;">每批运费按所选「付款周」计入该周<b style="color:var(--plum);">物流运费</b>现金流（独立类别 · 收款人为物流公司），体现在现金轨迹与支出结构中。批次本身在「历史数据 · 进货验货」维护。</div></div>' +
      '</div>' +
      card('<div style="margin-bottom:12px;">' + h2('各批次运费') + '<div style="font-size:12px; color:var(--muted);">为每个进货批次登记运费与付款周</div></div>' +
        (rows || '<div style="padding:16px; text-align:center; color:var(--muted); font-size:12px;">暂无批次 · 先在「历史数据 · 进货验货」录入</div>')) +
    '</div>';
  }

  // ---------- RECEIVABLES ----------
  function renderAr(V) {
    var catOpt = function (sel) { return V.catOptions.map(function (o) { return '<option value="' + escA(o) + '"' + (o === sel ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join(''); };
    var cats = V.catSummary.map(function (c) {
      return '<div style="background:#fff; border-radius:13px; padding:12px 15px; box-shadow:0 8px 22px -18px rgba(60,42,28,.4); border:1px solid var(--line); border-left:4px solid ' + c.color + ';"><div style="font-size:12px; color:var(--muted);">' + esc(c.cat) + '</div><div class="num" style="font-size:18px; font-weight:600; margin-top:4px; color:var(--plum2);">' + esc(c.val) + '</div></div>';
    }).join('');
    var customers = V.custRows.map(function (c) {
      var ships = c.ships.map(function (sh) {
        var cwLbl = sh.computedWeek != null ? '第' + (sh.computedWeek + 1) + '周' : '未定';
        var overridden = sh.collectWeek !== '';
        return '<div style="border:1px solid #f1ebdf; border-radius:8px; padding:8px 10px; margin-bottom:6px;">' +
          '<div style="display:flex; gap:7px; align-items:center; flex-wrap:wrap;">' +
            '<span style="font-size:10.5px; color:var(--muted);">货值</span>' +
            '<input class="fld" inputmode="numeric" ' + bArr('arShipments', sh.si, 'value') + ' value="' + escA(sh.value) + '" placeholder="0" style="width:104px; text-align:right; ' + FLD + '">' +
            '<span style="font-size:10.5px; color:var(--muted);">出货日期</span>' +
            '<input class="fld" type="date" ' + bArr('arShipments', sh.si, 'date') + ' value="' + escA(sh.date) + '" style="width:140px; ' + FLD + '">' +
            '<span style="font-size:10.5px; color:var(--muted);">预计回款</span>' +
            '<span style="font-size:11.5px; font-weight:700; color:var(--leaf);">' + cwLbl + '</span>' +
            '<span style="font-size:9.5px; color:' + (overridden ? 'var(--orchid)' : 'var(--muted)') + ';">' + (overridden ? '覆盖' : '自动(出货日+账期)') + '</span>' +
            '<button data-action="delRow" data-arr="arShipments" data-idx="' + sh.si + '" style="margin-left:auto; background:none; border:none; color:var(--rose); cursor:pointer; font-size:14px; opacity:.6;">×</button>' +
          '</div>' +
          '<div style="margin-top:6px; display:flex; align-items:center; gap:8px;">' +
            '<span style="font-size:10.5px; color:var(--muted); flex:none;">回款周覆盖</span><div style="flex:1; min-width:0;">' + weekPicker('arShipments', sh.si, 'collectWeek', sh.collectWeek, V) + '</div>' +
            (overridden ? '<button data-action="clearArWeek" data-idx="' + sh.si + '" style="flex:none; background:none; border:1px solid var(--field-bd); border-radius:6px; padding:5px 9px; font-size:10.5px; color:var(--rose); cursor:pointer;">清除</button>' : '') +
          '</div>' +
        '</div>';
      }).join('');
      return '<div style="border:1px solid var(--line); border-radius:12px; padding:13px 15px; margin-bottom:12px; background:#fff;">' +
        '<div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">' +
          '<input class="fld txt" ' + bArr('customers', c.idx, 'name') + ' value="' + escA(c.name) + '" style="flex:1; min-width:140px; border:1px solid var(--field-bd); background:var(--field); border-radius:7px; padding:6px 9px; font-size:13px; font-weight:600;">' +
          '<select class="fld txt" ' + bArr('customers', c.idx, 'cat') + ' style="width:82px; border:1px solid var(--field-bd); background:var(--field); border-radius:7px; padding:6px 4px; font-size:11.5px; font-weight:600; color:' + c.catColor + ';">' + catOpt(c.cat) + '</select>' +
          '<input class="fld txt" ' + bArr('customers', c.idx, 'note') + ' value="' + escA(c.note) + '" placeholder="备注" style="width:130px; border:1px solid var(--field-bd); background:var(--field); border-radius:7px; padding:6px 9px; font-size:12px;">' +
          '<span style="font-size:11px; color:var(--muted);">应收余额 <b class="num" style="font-size:14px; color:var(--plum2);">' + esc(c.outstandingStr) + '</b></span>' +
          '<button data-action="delRow" data-arr="customers" data-idx="' + c.idx + '" style="margin-left:auto; background:none; border:none; color:var(--rose); cursor:pointer; font-size:16px; opacity:.6;">×</button>' +
        '</div>' +
        '<div style="display:grid; grid-template-columns:1.15fr 1fr; gap:14px; align-items:start;">' +
          '<div><div style="font-size:11px; color:var(--muted); margin-bottom:5px;">出货记录（货值 + 出货日期，汇总为应收余额）</div>' + ships +
            '<button data-action="addArShip" data-cust="' + escA(c.id) + '" style="background:var(--lilac); color:var(--plum); border:1px solid var(--field-bd); border-radius:7px; padding:4px 10px; font-size:11px; font-weight:600; cursor:pointer;">+ 添加出货</button></div>' +
          '<div><div style="font-size:11px; color:var(--muted); margin-bottom:3px;">默认回款周（兜底：仅用于没有出货日期的出货 · 每笔出货优先用上方「预计回款」）</div>' + weekPicker('customers', c.idx, 'collectWeek', c.collectWeek, V) + '</div>' +
        '</div>' +
      '</div>';
    }).join('');

    return '<div>' +
      '<div style="display:grid; grid-template-columns:1.3fr 1fr 1fr; gap:14px; margin-bottom:16px;">' +
        '<div style="background:#c0613f; color:#fff; border-radius:15px; padding:18px 20px;"><div style="font-size:13px; color:#ecc6ab;">应收账款合计</div><div class="num" style="font-size:27px; font-weight:600; margin-top:6px;">' + esc(V.arOutWan) + '</div></div>' +
        '<div style="background:#fff; border-radius:15px; padding:18px 20px; box-shadow:0 10px 30px -20px rgba(60,42,28,.34); border:1px solid var(--line);"><div style="font-size:13px; color:var(--muted);">本周预计回款（自动）</div><div class="num" style="font-size:24px; font-weight:600; margin-top:6px; color:var(--leaf);">' + esc(V.arWeekCollectWan) + '</div></div>' +
        '<div style="background:#fff; border-radius:15px; padding:18px 20px; box-shadow:0 10px 30px -20px rgba(60,42,28,.34); border:1px solid var(--line);"><div style="font-size:13px; color:var(--muted);">客户数</div><div class="num" style="font-size:24px; font-weight:600; margin-top:6px; color:var(--plum2);">' + V.arCount + ' <span style="font-size:13px; color:var(--muted);">位</span></div></div>' +
      '</div>' +
      '<div style="display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:16px;">' + cats + '</div>' +
      card('<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; flex-wrap:wrap; gap:8px;"><div>' + h2('客户应收账款') + '<div style="font-size:12px; color:var(--muted);">每位客户：出货记录（货值+日期）汇总为应收余额 · 选择回款周 → 自动计入该周「国内/国外收款」及上方汇总</div></div>' +
        '<button data-action="addRow" data-arr="customers" style="background:var(--lilac); color:var(--plum); border:1px solid var(--field-bd); border-radius:8px; padding:7px 13px; font-size:12.5px; font-weight:600; cursor:pointer;">+ 新增客户</button></div>' +
        (customers || '<div style="padding:16px; text-align:center; color:var(--muted); font-size:12px;">暂无客户 · 点击「+ 新增客户」</div>')) +
    '</div>';
  }

  // ---------- REPORT ----------
  function renderReport(V) {
    var kpis = V.repKpis.map(function (k) { return '<div style="background:var(--lilac); border-radius:12px; padding:15px 16px;"><div style="font-size:12px; color:var(--muted); margin-bottom:8px;">' + esc(k.label) + '</div><div class="num" style="font-size:17px; font-weight:700; color:' + k.color + '; white-space:nowrap;">' + esc(k.val) + '</div></div>'; }).join('');
    var P = V.repProv;
    function provRow(label, hd, hdLbl, fc, apLbl, ap) {
      return '<tr><td style="padding:8px 6px; border-bottom:1px solid #f1ebdf; font-weight:700;">' + label + '</td>' +
        '<td class="num" style="text-align:right; padding:8px 6px; border-bottom:1px solid #f1ebdf; color:var(--plum);">' + hdLbl + ' ' + esc(hd) + '</td>' +
        '<td class="num" style="text-align:right; padding:8px 6px; border-bottom:1px solid #f1ebdf; color:var(--orchid);">' + esc(fc) + '</td>' +
        '<td class="num" style="text-align:right; padding:8px 6px; border-bottom:1px solid #f1ebdf; color:#3f8f6b;">' + apLbl + ' ' + esc(ap) + '</td></tr>';
    }
    var provTable =
      '<table style="width:100%; border-collapse:collapse; font-size:13px;">' +
        '<thead><tr style="color:var(--muted); font-size:11.5px;">' +
          '<th style="text-align:left; font-weight:500; padding:7px 6px; border-bottom:1px solid var(--line);">现金口径</th>' +
          '<th style="text-align:right; font-weight:600; padding:7px 6px; border-bottom:1px solid var(--line); color:var(--plum);">已实现（事实）</th>' +
          '<th style="text-align:right; font-weight:600; padding:7px 6px; border-bottom:1px solid var(--line); color:var(--orchid);">预测</th>' +
          '<th style="text-align:right; font-weight:600; padding:7px 6px; border-bottom:1px solid var(--line); color:#3f8f6b;">其中已订</th></tr></thead>' +
        '<tbody>' +
          provRow('收款', P.cinHd, '已收', P.cinFd, '应收', P.cinAr) +
          provRow('支出', P.payPaid, '已付', P.payFp, '应付', P.payAp) +
        '</tbody></table>' +
      '<div style="font-size:11px; color:var(--muted); margin:8px 0 24px;">现金口径：仅「已实现」为事实（已收 / 已付现金）；「预测」为模型预估；「已订」为已出货应收(AR) / 已登记应付(AP)，用于校验预测、不与预测相加。</div>';
    var lines = V.repLines.map(function (l) { return '<div style="display:flex; gap:10px; margin-bottom:11px; font-size:14px; line-height:1.6;"><span style="width:7px; height:7px; border-radius:50%; background:var(--orchid); margin-top:8px; flex:none;"></span><span style="color:#3a342a;">' + esc(l) + '</span></div>'; }).join('');
    return '<div>' +
      '<div class="no-print" style="display:flex; justify-content:flex-end; margin-bottom:14px;"><button data-action="print" style="background:var(--plum); color:#fff; border:none; border-radius:10px; padding:10px 20px; font-size:13px; font-weight:600; cursor:pointer;">打印 / 导出 PDF</button></div>' +
      '<div class="print-area" style="background:#fff; border-radius:16px; padding:42px 48px; box-shadow:0 14px 40px -24px rgba(60,42,28,.45); border:1px solid var(--line); max-width:920px; margin:0 auto;">' +
        '<div style="display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid var(--plum); padding-bottom:18px; margin-bottom:24px;"><div><div class="serif" style="font-size:23px; font-weight:900; color:var(--plum2); white-space:nowrap;">' + esc(V.repCompany) + ' · 财务预测报告</div><div style="font-size:13px; color:var(--muted); margin-top:6px;">农历财年 ' + esc(V.repFy) + '</div></div>' + logoBox(46, 13) + '</div>' +
        '<div class="serif" style="font-size:16px; font-weight:700; margin-bottom:12px; color:var(--plum2);">关键指标</div>' +
        '<div style="display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:28px;">' + kpis + '</div>' +
        '<div class="serif" style="font-size:16px; font-weight:700; margin-bottom:12px; color:var(--plum2);">情况说明</div>' +
        '<div style="margin-bottom:28px;">' + lines + '</div>' +
        '<div class="serif" style="font-size:16px; font-weight:700; margin-bottom:12px; color:var(--plum2);">数据构成（HD / AR / FD · 现金口径）</div>' +
        provTable +
        '<div class="serif" style="font-size:16px; font-weight:700; margin-bottom:12px; color:var(--plum2);">全年现金轨迹</div>' +
        cashChart(V, 'rep', true) +
        '<div style="font-size:11px; color:var(--muted); border-top:1px solid var(--line); padding-top:14px; margin-top:20px;">本报告由昆明统一生物科技有限公司财务预测系统自动生成 · 实线为实际、虚线为预测 · ' + esc(V.unitLabel) + '</div>' +
      '</div></div>';
  }

  // ---------- TUTORIAL (interactive HD / AR / FD walkthrough) ----------
  // Each stage: what it is, where to key it, a field→meaning→destination table,
  // and the page its "highlight" button jumps to (CSS in styles.css glows the
  // matching inputs via their data attributes).
  var TUT = {
    hd: {
      label: '已收 / 已付 · 事实', color: 'var(--plum)', page: 'hist',
      title: 'HD · 历史数据（已收 / 已付）',
      what: '已经发生、而且钱已经收到或付出的交易。这是“事实”，不会再变——就像银行流水。',
      where: '「历史数据」标签页，先在上方选中一个已经结束的周。',
      fields: [
        ['销售明细 · 金额(元)', '该周每个渠道/规格实际收到的货款', '国外项 → 国外收款；其余 → 国内收款（HD）'],
        ['销售明细 · 数量(株)', '卖出的株数（只用来算平均单价，不直接进现金）', '平均单价 = 金额 ÷ 数量（核对用）'],
        ['现金流实际 · 收款', '该周实际到账现金（会覆盖上面的销售明细汇总）', 'HD 收款 → 现金轨迹【实线】'],
        ['现金流实际 · 付款', '该周实际付出的各类支出', 'HD 已付 → 现金轨迹【实线】'],
        ['进货验货', '供应商到货批次（类型 / 数量 / 金额 / IQ号）', '生成「苗/花应付款」(AP)']
      ],
      hooks: '汇总进现金轨迹的【实线】，以及报告里的【已实现（事实）】列。'
    },
    ar: {
      label: '已出货 · 待收', color: '#3f8f6b', page: 'ar',
      title: 'AR · 应收账款（已出货、待收款）',
      what: '货已经发出去了，但钱还没收回来。金额是确定的（货值），你只需要预测“什么时候”能收到。',
      where: '「应收账款」标签页（账期在「假设 · 回款节奏」里设定）。',
      fields: [
        ['客户 · 分类(国外/国内/省内/省外)', '决定收款走哪条线、用哪个账期', '路由 + 账期'],
        ['出货记录 · 货值(元)', '这批已发货物的金额（应收金额）', 'AR 金额'],
        ['出货记录 · 出货日期', '发货日期；＋账期 = 预计回款周', 'AR 时间'],
        ['回款周覆盖（每笔）', '手动指定回款周（可选，留空＝自动）', 'AR 时间（覆盖）'],
        ['账期 · 假设·回款节奏', '出货后约几周收到钱，按分类设定（默认 4/2/2/2）', 'AR 时间']
      ],
      hooks: '汇总进现金轨迹的【绿色点线“已订(AR)”】（只伸到有订单的几周），以及报告里的【应收】列；并和 FD 对比看预测准不准。'
    },
    fd: {
      label: '未发货 · 预测', color: 'var(--orchid)', page: 'assume',
      title: 'FD · 预测（还没发货、还没收款）',
      what: '还没发生的销售。金额和时间都要预测，系统按“单价 × 销量 × 当周回款率”自动算出预计收款。',
      where: '「假设」标签页设定驱动因子；结果在「预测」标签页查看，可逐周覆盖。',
      fields: [
        ['销售单价(元/株)', '每个渠道/规格每株的价格', 'FD 收入'],
        ['销量与淘汰(株/周)', '每周各渠道卖出的株数 + 预测淘汰率', 'FD 收入'],
        ['当周回款率', '当周销售里有多少比例当周就收到（0.7 = 70%）', 'FD 收款时间'],
        ['种苗 / 物料 / 运营 等', '各项支出的预测（每月 / 每周）', 'FP 支出预测'],
        ['预测页 · 逐周覆盖', '某周想手动改预测值就直接填（留空＝用假设）', 'FD 覆盖']
      ],
      hooks: '汇总进现金轨迹的【橙色点线“预测(FD)”】（贯穿全年），以及报告里的【预测】列。'
    }
  };

  function renderTutorial() {
    var order = ['hd', 'ar', 'fd'], stage = TUT[tutDoc] ? tutDoc : 'hd', t = TUT[stage];
    var sel = order.map(function (k) {
      var x = TUT[k], on = k === stage;
      return '<button data-action="tutSelect" data-stage="' + k + '" style="flex:1; cursor:pointer; text-align:left; border:1px solid ' + (on ? x.color : 'var(--line)') + '; background:' + (on ? x.color : '#fff') + '; color:' + (on ? '#fff' : 'var(--ink)') + '; border-radius:12px; padding:13px 14px; box-shadow:' + (on ? '0 8px 20px -12px ' + x.color : 'none') + ';">' +
        '<div class="num" style="font-size:16px; font-weight:700;">' + k.toUpperCase() + '</div>' +
        '<div style="font-size:11px; opacity:.9; margin-top:2px;">' + esc(x.label) + '</div></button>';
    }).join('');
    var rows = t.fields.map(function (f) {
      return '<tr><td style="padding:8px 6px; border-bottom:1px solid #f1ebdf; font-weight:600;">' + esc(f[0]) + '</td>' +
        '<td style="padding:8px 6px; border-bottom:1px solid #f1ebdf; color:#4a4136;">' + esc(f[1]) + '</td>' +
        '<td style="padding:8px 6px; border-bottom:1px solid #f1ebdf; color:' + t.color + '; font-weight:600;">' + esc(f[2]) + '</td></tr>';
    }).join('');
    return '<div>' +
      card('<div class="serif" style="font-size:18px; font-weight:700; margin-bottom:6px;">三步看懂这套系统</div>' +
        '<div style="font-size:13px; color:#3a342a; line-height:1.75;">每一笔生意都会经过三个阶段，像水一样从“预测”流到“收到”：<br>' +
        '<b style="color:var(--orchid);">FD 预测</b>（还没发货）→ <b style="color:#3f8f6b;">AR 应收</b>（已发货、等收钱）→ <b style="color:var(--plum);">HD 已收</b>（钱到账，结束）。<br>' +
        '你在不同标签页录入不同阶段的数据，系统自动把它们画到“现金轨迹”上并互相对比。点下面任意一块，看它怎么填、连到哪里。</div>', ' margin-bottom:16px;') +
      '<div style="display:flex; gap:12px; margin-bottom:16px;">' + sel + '</div>' +
      card('<div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;"><span style="width:11px; height:11px; border-radius:50%; background:' + t.color + ';"></span><div class="serif" style="font-size:17px; font-weight:700;">' + esc(t.title) + '</div></div>' +
        '<div style="font-size:13.5px; color:#3a342a; line-height:1.7; margin-bottom:12px;"><b>是什么：</b>' + esc(t.what) + '</div>' +
        '<div style="font-size:13px; color:#3a342a; margin-bottom:14px;"><b>在哪里填：</b>' + esc(t.where) + '</div>' +
        '<table style="width:100%; border-collapse:collapse; font-size:12.5px; margin-bottom:14px;"><thead><tr style="color:var(--muted); font-size:11.5px;">' +
          '<th style="text-align:left; font-weight:500; padding:7px 6px; border-bottom:1px solid var(--line);">字段</th>' +
          '<th style="text-align:left; font-weight:500; padding:7px 6px; border-bottom:1px solid var(--line);">填什么</th>' +
          '<th style="text-align:left; font-weight:500; padding:7px 6px; border-bottom:1px solid var(--line);">连接到</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div style="font-size:12.5px; color:var(--muted); margin-bottom:16px;"><b>最终去向：</b>' + esc(t.hooks) + '</div>' +
        '<button data-action="tutHi" data-stage="' + stage + '" data-page="' + t.page + '" style="background:' + t.color + '; color:#fff; border:none; border-radius:10px; padding:11px 18px; font-size:13.5px; font-weight:700; cursor:pointer;">在页面中高亮这些字段 →</button>') +
    '</div>';
  }

  function renderTutBanner(stage) {
    var t = TUT[stage];
    var items = t.fields.map(function (f) { return '<li style="margin-bottom:2px;"><b>' + esc(f[0]) + '</b> — ' + esc(f[1]) + '</li>'; }).join('');
    return '<div class="no-print" style="background:#fffaf0; border:1px solid ' + t.color + '; border-left:5px solid ' + t.color + '; border-radius:12px; padding:12px 16px; margin-bottom:16px;">' +
      '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">' +
        '<span style="font-size:11px; font-weight:700; color:#fff; background:' + t.color + '; padding:2px 8px; border-radius:6px;">教程 · ' + stage.toUpperCase() + '</span>' +
        '<span style="font-size:13px; font-weight:700;">' + esc(t.title) + '</span>' +
        '<span style="margin-left:auto; display:flex; gap:8px;">' +
          '<button data-action="nav" data-page="tut" style="background:#fff; border:1px solid var(--field-bd); border-radius:8px; padding:6px 11px; font-size:12px; cursor:pointer;">返回教程</button>' +
          '<button data-action="tutExit" style="background:' + t.color + '; color:#fff; border:none; border-radius:8px; padding:6px 11px; font-size:12px; font-weight:700; cursor:pointer;">退出高亮</button>' +
        '</span>' +
      '</div>' +
      '<div style="font-size:12px; color:#4a4136; margin-top:8px;">金色高亮的就是要填的字段：<ul style="margin:6px 0 0; padding-left:18px; line-height:1.6;">' + items + '</ul></div>' +
    '</div>';
  }

  var PAGES = { dash: renderDash, hist: renderHist, fcst: renderFcst, assume: renderAssume, seedpay: renderSeedpay, logi: renderLogi, ar: renderAr, report: renderReport, tut: renderTutorial };

  // ===================================================================
  //  MOUNT + EVENTS
  // ===================================================================
  var store, root;
  var tutDoc = 'hd';               // which stage's guide is shown on the 教程 page
  var tutHi = null;                // active highlight stage on a real page ('hd'|'ar'|'fd'|null)
  var currentUser = null;          // {id,email} once authenticated, else null
  var authTab = 'login';           // 'login' | 'signup'
  var authError = '';
  var authBusy = false;
  var authEmailVal = '';           // preserve the typed email across auth re-renders

  function captureFocus() {
    var el = document.activeElement;
    if (!el || !el.id) return null;
    var f = { id: el.id };
    try { if (el.selectionStart != null) { f.s = el.selectionStart; f.e = el.selectionEnd; } } catch (e) {}
    return f;
  }
  function restoreFocus(f) {
    if (!f) return;
    var el = document.getElementById(f.id);
    if (!el) return;
    el.focus();
    try { if (f.s != null && el.setSelectionRange) el.setSelectionRange(f.s, f.e); } catch (e) {}
  }

  function render(state) {
    var f = captureFocus();
    var V = buildView(state);
    var pageFn = PAGES[V.page] || renderDash;
    var hiOn = tutHi && TUT[tutHi] && V.page === TUT[tutHi].page;   // only glow on the stage's own page
    var tutBanner = hiOn ? renderTutBanner(tutHi) : '';
    root.innerHTML = renderHeader(V) +
      '<main style="flex:1; min-width:0; display:flex; flex-direction:column;">' +
        '<div style="padding:26px 28px 60px; flex:1;">' + tutBanner + pageFn(V) + '</div>' +
      '</main>';
    root.setAttribute('data-tut', hiOn ? tutHi : '');
    restoreFocus(f);
    wireChart();
  }

  // ---- coalesced rendering (perf) -------------------------------------
  // A render rebuilds the whole page (50-week series, chart, every panel) and
  // restores focus. Doing that synchronously on every keystroke is what made
  // typing lag. So edit-driven renders are debounced: while you keep typing the
  // input stays native/responsive, and derived values (KPIs, chart, totals)
  // refresh shortly after you pause. Clicks flush immediately for snappy
  // navigation, and tests force synchronous rendering via FFApp.enterWithState.
  var syncRender = false, _renderTimer = null;
  function scheduleRender(state) {
    if (syncRender) { render(state); return; }
    if (_renderTimer) clearTimeout(_renderTimer);
    _renderTimer = setTimeout(function () { _renderTimer = null; if (store) render(store.state); }, 60);
  }
  function flushRender() {
    if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; }
    if (store) render(store.state);
  }

  // chart hover (re-bound each render since the SVG is rebuilt)
  function wireChart() {
    var rect = document.getElementById('cashHover');
    if (!rect) return;
    rect.addEventListener('mousemove', onChartMove);
    rect.addEventListener('mouseleave', onChartLeave);
  }
  function onChartMove(e) {
    var svg = e.target.ownerSVGElement, h = HOV; if (!svg || !h) return;
    var m = svg.getScreenCTM(); if (!m) return;
    var p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    var loc = p.matrixTransform(m.inverse());
    var bi = 0, bd = 1e9;
    for (var i = 0; i < h.xs.length; i++) { var d = Math.abs(h.xs[i] - loc.x); if (d < bd) { bd = d; bi = i; } }
    var g = document.getElementById('cashGuide'); if (g) { g.setAttribute('x1', h.xs[bi]); g.setAttribute('x2', h.xs[bi]); g.style.opacity = 1; }
    var df = document.getElementById('cashDotF'); if (df) { df.setAttribute('cx', h.xs[bi]); df.setAttribute('cy', h.yf[bi]); df.style.opacity = 1; }
    var da = document.getElementById('cashDotA'), hasA = h.ya[bi] != null;
    if (da) { if (hasA) { da.setAttribute('cx', h.xs[bi]); da.setAttribute('cy', h.ya[bi]); da.style.opacity = 1; } else { da.style.opacity = 0; } }
    var tip = document.getElementById('cashTip');
    if (tip) {
      tip.style.opacity = 1;
      tip.style.left = (h.xs[bi] / 1000 * 100) + '%';
      tip.style.top = ((hasA ? Math.min(h.yf[bi], h.ya[bi]) : h.yf[bi]) / 250 * 100) + '%';
      tip.innerHTML = '<div style="font-weight:700;margin-bottom:4px;color:#2a2620">' + h.lab[bi] + '</div>' +
        '<div style="display:flex;gap:10px;justify-content:space-between"><span style="color:#c2613c">预测</span><span class="num">' + h.fcStr[bi] + '</span></div>' +
        (hasA ? '<div style="display:flex;gap:10px;justify-content:space-between"><span style="color:#46552c">实际</span><span class="num">' + h.acStr[bi] + '</span></div><div style="display:flex;gap:10px;justify-content:space-between"><span style="color:' + h.varCol[bi] + '">变差</span><span class="num" style="color:' + h.varCol[bi] + '">' + h.varStr[bi] + '</span></div>' : '<div style="color:#8a8273">尚未发生</div>');
    }
  }
  function onChartLeave() {
    ['cashGuide', 'cashDotF', 'cashDotA', 'cashTip'].forEach(function (id) { var el = document.getElementById(id); if (el) el.style.opacity = 0; });
  }

  // current stored value for an edit target (dedupe input/change pairs)
  function currentValue(ds) {
    if (ds.config != null) return store.state.config[ds.config];
    if (ds.map != null) { var m = store.state[ds.map] || {}; return m[ds.key]; }
    if (ds.arr != null) { var row = store.state[ds.arr][+ds.idx]; return row ? row[ds.key] : undefined; }
    return undefined;
  }
  function applyEdit(el) {
    var ds = el.dataset;
    var cur = currentValue(ds);
    var nv = el.value;
    if (cur === nv) return; // no-op (dedupes input+change, blur change, etc.)
    if (ds.config != null) store.editConfig(ds.config, nv);
    else if (ds.map != null) store.editMap(ds.map, ds.key, nv);
    else if (ds.arr != null) store.editArr(ds.arr, +ds.idx, ds.key, nv);
  }

  function onEditEvent(e) {
    var el = e.target;
    if (!el || el.dataset == null) return;
    if (el.dataset.config != null || el.dataset.map != null || el.dataset.arr != null) applyEdit(el);
  }

  // Per-tab default selected week, applied when navigating into a tab:
  //   历史 → the latest COMPLETED (elapsed) week — where finished actuals are entered.
  //   预测 / 假设 → current week + 1 — the first week you actually plan.
  // Other pages keep the current selection (null = leave weekIdx alone).
  function defaultWeekForPage(state, page) {
    var W = E.weeks(state), last = W.length - 1;
    if (page === 'hist') {
      var h = -1;
      for (var i = 0; i < W.length; i++) { if (E.isHist(state, i)) h = i; }
      return h >= 0 ? h : 0;
    }
    if (page === 'fcst' || page === 'assume') return Math.min(E.currentWeekIdx(state) + 1, Math.max(last, 0));
    return null;
  }

  function onClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!btn) return;
    var a = btn.dataset.action;
    switch (a) {
      case 'nav': { tutHi = null; var dw = defaultWeekForPage(store.state, btn.dataset.page); if (dw != null) store.set({ page: btn.dataset.page, weekIdx: dw }); else store.setPage(btn.dataset.page); break; }
      case 'tutSelect': tutDoc = btn.dataset.stage; break;
      case 'tutHi': tutHi = btn.dataset.stage; store.setPage(btn.dataset.page); break;
      case 'tutExit': tutHi = null; break;
      case 'toggleUnit': store.toggleUnit(); break;
      case 'selectWeek': store.selectWeek(+btn.dataset.idx); break;
      case 'pickWeek': store.editArr(btn.dataset.arr, +btn.dataset.idx, btn.dataset.key, +btn.dataset.week); break;
      case 'scrollChips': { var sc = document.getElementById('weekChipScroll'); if (sc && sc.scrollBy) sc.scrollBy({ left: (+btn.dataset.dir) * Math.max(sc.clientWidth * 0.8, 200), behavior: 'smooth' }); break; }
      case 'addRow': store.addRow(btn.dataset.arr); break;
      case 'addArShip': store.addRow('arShipments', { custId: btn.dataset.cust }); break;
      case 'delRow': store.delRow(btn.dataset.arr, +btn.dataset.idx); break;
      case 'addAssume': store.addAssumeItem(btn.dataset.group); break;
      case 'delCustom': store.delCustom(btn.dataset.id); break;
      case 'togglePaid': { var pp = store.state.payables[+btn.dataset.idx]; if (pp) store.editArr('payables', +btn.dataset.idx, 'paid', !pp.paid); break; }
      case 'clearArWeek': store.editArr('arShipments', +btn.dataset.idx, 'collectWeek', ''); break;
      case 'print': window.print(); break;
      case 'logout': doLogout(); break;
      case 'authToggle': e.preventDefault(); authTab = (authTab === 'signup' ? 'login' : 'signup'); authError = ''; renderAuth(); break;
    }
    // Clicks that change state should feel instant — flush the debounced
    // render now. (scrollChips only scrolls the DOM; print/auth manage their
    // own view, so skip those.)
    if (a !== 'scrollChips' && a !== 'print' && a !== 'logout' && a !== 'authToggle') flushRender();
  }

  function doLogout() {
    var done = function () {
      store = null; currentUser = null; authTab = 'login'; authError = ''; authEmailVal = '';
      if (window.FFApp) { window.FFApp.store = null; window.FFApp.user = null; }
      renderAuth();
    };
    if (typeof fetch !== 'function') { done(); return; }
    fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).then(done, done);
  }

  // ===================================================================
  //  AUTH SCREEN  (login / signup — same visual system as the app)
  // ===================================================================
  var AUTH_FLD = 'width:100%; box-sizing:border-box; border:1px solid var(--field-bd); background:var(--field); border-radius:9px; padding:11px 12px; font-size:14px; color:var(--ink);';

  function renderAuth() {
    var isSignup = authTab === 'signup';
    var title = isSignup ? '注册账户' : '登录';
    var sub = isSignup ? '创建账户以保存并同步您的财务预测数据' : '登录以访问您的财务预测工作区';
    var inner =
      '<div class="serif" style="font-size:20px; font-weight:700; margin-bottom:4px;">' + title + '</div>' +
      '<div style="font-size:12px; color:var(--muted); margin-bottom:18px;">' + sub + '</div>' +
      '<form id="authForm" novalidate>' +
        '<label style="display:block; margin-bottom:13px;"><span style="display:block; font-size:12px; color:var(--muted); margin-bottom:5px;">邮箱</span>' +
          '<input class="fld txt" id="authEmail" type="email" value="' + escA(authEmailVal) + '" autocomplete="username" style="' + AUTH_FLD + '"></label>' +
        '<label style="display:block; margin-bottom:' + (isSignup ? '13px' : '4px') + ';"><span style="display:block; font-size:12px; color:var(--muted); margin-bottom:5px;">密码</span>' +
          '<input class="fld txt" id="authPassword" type="password" autocomplete="' + (isSignup ? 'new-password' : 'current-password') + '" style="' + AUTH_FLD + '"></label>' +
        (isSignup ? ('<label style="display:block; margin-bottom:4px;"><span style="display:block; font-size:12px; color:var(--muted); margin-bottom:5px;">确认密码</span>' +
          '<input class="fld txt" id="authPassword2" type="password" autocomplete="new-password" style="' + AUTH_FLD + '"></label>') : '') +
        (authError ? '<div style="margin:12px 0 2px; font-size:12.5px; color:var(--rose); background:#fbeae6; border:1px solid #f0cfc6; border-radius:8px; padding:8px 11px;">' + esc(authError) + '</div>' : '') +
        '<button type="submit"' + (authBusy ? ' disabled' : '') + ' style="width:100%; margin-top:16px; background:' + (authBusy ? '#9aa888' : 'var(--leaf)') + '; color:#fff; border:none; border-radius:10px; padding:12px; font-size:14px; font-weight:700; cursor:' + (authBusy ? 'default' : 'pointer') + ';">' + (authBusy ? '请稍候…' : title) + '</button>' +
      '</form>' +
      '<div style="text-align:center; margin-top:15px; font-size:12.5px; color:var(--muted);">' +
        (isSignup ? '已有账户？' : '还没有账户？') +
        ' <a href="#" data-action="authToggle" style="color:var(--plum); font-weight:600; text-decoration:none;">' + (isSignup ? '去登录' : '注册新账户') + '</a></div>';

    root.innerHTML =
      '<div class="bg-cross" style="min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;">' +
        '<div style="width:100%; max-width:380px;">' +
          '<div style="display:flex; flex-direction:column; align-items:center; gap:12px; margin-bottom:22px;">' +
            logoBox(54, 15) +
            '<div style="text-align:center;"><div style="font-weight:700; font-size:15px; letter-spacing:.2px;">昆明统一生物科技有限公司</div>' +
              '<div style="font-size:10.5px; color:var(--muted); letter-spacing:1.6px;">财务分析系统 · v1.0</div></div>' +
          '</div>' +
          card(inner, ' padding:26px 26px 22px;') +
          '<div style="text-align:center; margin-top:16px; font-size:10.5px; color:var(--muted);">数据按账户隔离存储 · 仅您本人可见</div>' +
        '</div>' +
      '</div>';
    var f = document.getElementById('authEmail');
    if (f && !f.value) { try { f.focus(); } catch (e) {} }
  }

  function renderLoading() {
    root.innerHTML = '<div class="bg-cross" style="min-height:100vh; display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:13px;">载入中…</div>';
  }

  // merge a (possibly partial / older-schema) state over a fresh blank model
  function mergeDefault(s) {
    var d = FFStore.defaultModel();
    if (!s || typeof s !== 'object') return d;
    var merged = Object.assign({}, d, s);
    merged.config = Object.assign({}, d.config, s.config || {}); // guard new config keys
    // migration guards (older saved states): ensure customer ids + new arrays
    merged.customers = (merged.customers || []).map(function (c) {
      return c && c.id ? c : Object.assign({ id: 'c_' + Math.random().toString(36).slice(2, 8) }, c);
    });
    if (!Array.isArray(merged.arShipments)) merged.arShipments = [];
    if (!Array.isArray(merged.shipments)) merged.shipments = d.shipments;
    if (!Array.isArray(merged.payables)) merged.payables = [];
    if (!Array.isArray(merged.suppliers)) {  // derive supplier list from existing shipment suppliers
      var supSeen = {}; merged.suppliers = [];
      (merged.shipments || []).forEach(function (sh) { var n = sh && sh.supplier; if (n && !supSeen[n]) { supSeen[n] = 1; merged.suppliers.push({ id: 'sup_' + Math.random().toString(36).slice(2, 8), name: n }); } });
    }
    return merged;
  }

  function doAuth() {
    if (authBusy) return;
    var emailEl = document.getElementById('authEmail');
    var pwEl = document.getElementById('authPassword');
    var email = emailEl ? emailEl.value.trim() : '';
    var pw = pwEl ? pwEl.value : '';
    authEmailVal = email;
    authError = '';
    if (!email || !pw) { authError = '请输入邮箱和密码'; renderAuth(); return; }
    if (authTab === 'signup') {
      var pw2El = document.getElementById('authPassword2');
      var pw2 = pw2El ? pw2El.value : '';
      if (pw.length < 8) { authError = '密码至少需要 8 位'; renderAuth(); return; }
      if (pw !== pw2) { authError = '两次输入的密码不一致'; renderAuth(); return; }
    }
    authBusy = true; renderAuth();
    fetch('/api/' + (authTab === 'signup' ? 'signup' : 'login'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ email: email, password: pw })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) { return { ok: r.ok, data: data }; });
    }).then(function (res) {
      authBusy = false;
      if (!res.ok) { authError = (res.data && res.data.error) || '操作失败，请重试'; renderAuth(); return; }
      authError = ''; authEmailVal = '';
      currentUser = res.data.user;
      enterApp();
    }).catch(function () {
      authBusy = false; authError = '网络错误，请重试'; renderAuth();
    });
  }

  function onAuthSubmit(e) {
    var form = e.target && e.target.closest ? e.target.closest('#authForm') : null;
    if (!form) return;
    e.preventDefault();
    doAuth();
  }

  // ===================================================================
  //  BOOT  (auth-gated, async)
  // ===================================================================
  // Mount the app for an authenticated user. `prefetchedState` (when defined)
  // short-circuits the /api/state fetch — used after login once we already
  // have the state, and by the test harness to bypass the network gate.
  function enterApp(prefetchedState) {
    function mount(serverState) {
      store = new FFStore.Store(new FFStore.RemoteAdapter(), mergeDefault(serverState));
      store.subscribe(scheduleRender);
      render(store.state);
      window.FFApp.store = store;
      window.FFApp.user = currentUser;
    }
    if (prefetchedState !== undefined) { mount(prefetchedState); return; }
    renderLoading();
    fetch('/api/state', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { state: null }; })
      .then(function (d) { mount(d.state); })
      .catch(function () { mount(null); });
  }

  function start() {
    // No backend reachable (e.g. jsdom tests, file://) → show the gate; the
    // test harness mounts the app directly via FFApp.enterWithState().
    if (typeof fetch !== 'function') { renderAuth(); return; }
    renderLoading();
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { user: null }; })
      .then(function (d) {
        if (d && d.user) { currentUser = d.user; enterApp(); }
        else { authTab = 'login'; renderAuth(); }
      })
      .catch(function () { authTab = 'login'; renderAuth(); });
  }

  function boot() {
    root = document.getElementById('app');
    root.addEventListener('input', onEditEvent);
    root.addEventListener('change', onEditEvent);
    root.addEventListener('click', onClick);
    root.addEventListener('submit', onAuthSubmit);

    // Integration handle, established before the async auth boot so it always
    // exists. `enterWithState` is the seam the test harness uses to mount the
    // app with a known state without the network auth round-trip.
    window.FFApp = {
      store: null, engine: E, buildView: buildView, user: null,
      rerender: function () { if (store) render(store.state); },
      enterWithState: function (state) { syncRender = true; enterApp(state); }
    };

    start();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
