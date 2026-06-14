'use strict';
/* =====================================================================
 * fixtures.js — rich demo dataset for the regression suite ONLY.
 * =====================================================================
 *
 * The shipped app (src/store.js → defaultModel) seeds a BLANK template:
 * structure and names, but zero financial figures. The test suite needs
 * realistic numbers to assert drivers flow through. That demo data lives
 * HERE — in test/, never in src/ — so it never ships in dist/.
 *
 * Data model (post-redesign): shipments (进货验货, per supplier) + payables
 * (苗/花应付款, each links a shipment via shipmentId and a payWeek).
 * ===================================================================== */
var E = require('../src/engine.js');

function demoModel() {
  var weeks = E.genWeeks('2026-02-17', '2027-02-05');
  var wTarget = 0;
  weeks.forEach(function (w, i) { if ('2026-05-26' >= w.startISO && '2026-05-26' <= w.endISO) wTarget = i; });
  var W = '' + wTarget, Wn = '' + (wTarget + 1);

  var sales = {};
  var seedSales = { fx28: [1940, 32456], fx35: [4100, 102424], xj28: [2206, 30053], xj35: [17812, 314316], dn28: [613, 9203], dn35: [3720, 60496], cut: [1940, 9490] };
  Object.keys(seedSales).forEach(function (c) {
    sales[wTarget + ':' + c + ':qty'] = '' + seedSales[c][0];
    sales[wTarget + ':' + c + ':amt'] = '' + seedSales[c][1];
  });

  var actualSeed = {};
  actualSeed[wTarget + ':foreign'] = '118000';
  actualSeed[wTarget + ':domestic'] = '372000';
  actualSeed[wTarget + ':payroll'] = '82000';
  actualSeed[wTarget + ':materials'] = '151000';
  actualSeed[wTarget + ':utilrent'] = '96000';

  return {
    page: 'dash',
    weekIdx: wTarget,
    config: { name: '昆明统一生物', startISO: '2026-02-17', endISO: '2027-02-05', asOfISO: '2026-06-10', asOfManual: true, unit: '万', openingBalance: '4227701.72' },
    assume: {
      priceForLarge: '19', priceForSmall: '16', priceForDye: '0', priceForCut: '0',
      priceDomLarge: '18.25', priceDomSmall: '15.07', priceDomDye: '40', priceDomCut: '7.5',
      collectInWeek: '1',
      qtyForLarge: '24000', qtyForSmall: '8000', qtyForDye: '0', qtyForCut: '0',
      qtyDomLarge: '70000', qtyDomSmall: '12000', qtyDomDye: '5000', qtyDomCut: '14000',
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
      { id: 'c1', name: '斗南门市批发', cat: '省内', note: '每周结算', collectWeek: '' + (wTarget + 2) },
      { id: 'c2', name: '小街基地走量客户', cat: '省内', note: '', collectWeek: '' },
      { id: 'c3', name: '俄罗斯出口客户', cat: '国外', note: '已到账未结汇', collectWeek: '' + (wTarget + 2) },
      { id: 'c4', name: '广东全美（转售）', cat: '省外', note: '', collectWeek: '' },
      { id: 'c5', name: '染色花经销商', cat: '省内', note: '', collectWeek: '' },
      { id: 'c6', name: '切花批发商', cat: '国内', note: '', collectWeek: '' }
    ],
    assumeWeek: {}, customItems: [],
    // 进货验货 — per-supplier shipments (单价 = 金额/数量 auto)
    shipments: [
      { id: 'sh1', type: '苗', channel: '国内', supplier: '山东绿航', spec: '2.8寸成熟苗', qty: '41342', amount: '310065', iq: 'IQ26020', freight: '1046.6', freightWeek: W },
      { id: 'sh2', type: '苗', channel: '国内', supplier: '和鸣花卉', spec: '3.5寸成熟苗', qty: '48904', amount: '224958', iq: 'IQ26042', freight: '687', freightWeek: W },
      { id: 'sh3', type: '花', channel: '国外', supplier: '漳州新百盛', spec: '大花', qty: '2700', amount: '40366', iq: 'KMTYP-25040', freight: '1432.31', freightWeek: W }
    ],
    // 苗/花应付款 — payables link a shipment + a pay week; blank amount = full shipment amount
    payables: [
      { id: 'pa1', shipmentId: 'sh1', payWeek: W, amount: '', urgency: '三级' },
      { id: 'pa2', shipmentId: 'sh2', payWeek: Wn, amount: '', urgency: '二级' },
      { id: 'pa3', shipmentId: 'sh3', payWeek: W, amount: '', urgency: '四级' }
    ],
    arShipments: [
      { id: 'ar1', custId: 'c1', value: '186000', date: '2026-05-20' },
      { id: 'ar2', custId: 'c3', value: '515000', date: '2026-05-18' },
      { id: 'ar3', custId: 'c2', value: '240000', date: '2026-05-25' }
    ],
    sales: sales, fcst: {}, actual: actualSeed
  };
}

module.exports = demoModel;
