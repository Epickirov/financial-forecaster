# Refactor Spec — 收款 (HD/AR/FD) + 付款 (FP/AP/Paid) provenance model

Status: **historical / superseded — kept as design record.** The three-state
provenance model described here IS implemented, but the AR side has since been
**redesigned**: the per-customer / per-shipment receivables (customers,
arShipments, 账期/lag, per-category 回款 lag fields) were removed and replaced
by a per-week 国内/国外 ledger (`state.ar`, fields 预计应收/本周新增/本周已收 —
see README). The fiscal window is now lunar-auto with the date controls on the
设置 page. Where this document and the code disagree, the code + README win.

This document is the implementation contract for reworking the forecaster around an
explicit three-state lifecycle on both the inflow (收款) and outflow (付款) sides.
Every surfaced figure must carry its provenance, and forecast vs booked vs settled
amounts must never be silently summed together.

---

## 1. Core principle

A transaction has a lifecycle. On each side there are three states:

| | 收款 / inflow | 付款 / outflow |
|---|---|---|
| **Forecast** (value + timing estimated) | **FD** — from assumptions (price × volume × 回款率) | **FP** — from assumption factors |
| **Booked, not settled** (value known, timing estimated) | **AR** — 应收账款 | **AP** — only 苗款 / 开花株款 / 运费 |
| **Settled** (factual, closed) | **HD** — collected | **Paid** |

Lifecycle: FD → AR → HD, and FP → AP → Paid. Transitions are **manual** (the user keys
in AR/AP as goods ship/arrive and HD/Paid as cash moves); forecasts are never
auto-promoted, only compared against what materialises.

### The non-negotiable rules

1. **Never sum forecast + booked within the same category-week.** FD and AR are parallel
   estimates of the same money, not additive components; likewise FP and AP. The booked
   band is the better-informed number and *replaces* the forecast for the live projection;
   the forecast is retained as a frozen comparison band.
2. **Lens = cash collection.** Only HD/Paid are factual (money actually moved). AR and FD
   are both "expected cash" (timing unrealised); AP and FP are both "expected payment".
   Report shading follows this.
3. **Provenance is always visible.** No aggregation may collapse the HD/AR/FD (or
   Paid/AP/FP) split into a single untagged number.
4. **Additivity is structural, never a per-item toggle.** A booked item is variance-within
   its forecast category; genuinely un-forecasted spend lives in 其他/custom (forecast ≈ 0),
   so it naturally stands alone and lifts the total without double-counting.

---

## 2. 收款 (inflow) details

- **FD** — forecast sales collection, from the 假设 page (per-channel price × weekly volume
  × 当周回款率, less 预测淘汰率). Full-year horizon.
- **AR** — 应收账款: shipments already made, awaiting collection. Value is known (已出货货值);
  only timing is forecast. Reaches only as far as bookings exist (~4–5 weeks).
- **HD** — collected: 销售明细 actuals + manual actuals for elapsed weeks.

### AR collection timing (per-shipment)

Each 出货 (arShipment) resolves its collection week by:

1. **Per-shipment manual override** if set → use it.
2. else **`出货日期 + category lag`**.

The single per-customer `collectWeek` is removed as the primary mechanism; it may remain
only as a per-customer fallback default when a shipment has neither override nor 出货日期.

### Per-category collection lags (editable, in 假设 → 回款节奏)

Four independent, per-week-inheritable lag fields (alongside 当周回款率). The lag applied to
a shipment uses the value effective at that shipment's 出货 week.

| Category | Default lag (weeks) |
|---|---|
| 国外 | 4 |
| 国内 | 2 |
| 省内 | 2 |
| 省外 | 2 |

### Receipt-line routing (unchanged)

国外 → 国外收款; 国内 / 省内 / 省外 → 国内收款. (Routing and lag are independent concerns.)

### Variance lenses

- **FD vs AR** — did forecast *sales* materialise (value variance).
- **AR vs HD** — did booked cash land *when* expected (timing variance; value already fixed).

### Projection chart

- Solid line = **HD** (realised cash, up to today).
- Dotted line = **AR-based** expected collection — short (~4–5 weeks).
- Dotted line = **FD-based** expected collection — full horizon.
- The two dotted lines are shown together where they overlap; the gap is the forecast error.
  They are **never merged** into one combined line.

---

## 3. 付款 (outflow) details

- **AP middle stage only for 苗款, 开花株款, 运费.** All other categories (工资社保, 水电租金,
  房贷/固定, 差旅, 项目) are scheduled forecast → paid, no booked-unpaid stage.
- **运费 is its own category** (lifted out of `materials`): freight is incurred on the same
  进货 batch that creates the 苗款/开花株款 payable, but it is a **separate payable to the
  logistics company** (different payee), so it gets its own FP/AP/Paid band.
  - FP (forecast freight) = the `freightMonthly` assumption (spread weekly).
  - AP (booked freight) = per-shipment `freight` scheduled at `freightWeek`.
  - `materials` keeps only `volume × (pkgCost + prodCost)`; its freight terms move to 运费.
- **FP + AP never summed** — projection uses booked AP where it exists, FP elsewhere; gap = variance.
- **Overdue unpaid payables roll forward** into the current week as a distinct **逾期应付** band
  (today they are stranded in their past `payWeek` and never re-surface as a live demand).
- **紧急度** stays informational — sorting/visibility only, no effect on cash math.

---

## 4. Data-model changes (`store.js`)

- `arShipments[]`: add `collectWeek` (manual override; blank → compute from `date` + lag).
  `date` (出货日期) becomes a *used* field (drives timing). 
- `customers[].collectWeek`: demoted to optional fallback default (no longer primary).
- `assume`: add four lag fields in the 回款节奏 group (e.g. `lagFor`, `lagDom`, `lagProv`, `lagProvOut`).
- `payables[]`: support a 运费 payable distinct from 苗/花 (separate payee/logistics).
- `PAYCATS`: add `freight` (运费); remove freight terms from `materials`.

## 5. Engine changes (`engine.js`)

- `computed()`: **remove** `foreign = foreignSales + arDue.foreign` / `domestic = domSales + arCollect`
  (lines ~241-243). FD is emitted alone; AR is a separate band.
- New AR helpers: per-shipment collection week (date + category lag + override); AR landing
  per (collection-week × channel).
- New outflow: FP (assumptions) and AP (`dueInWeek`) emitted as separate bands; 运费 split out;
  overdue roll-forward helper.
- Series: emit per-week `{hd, ar, fd}` (inflow) and `{paid, ap, fp}` (outflow) per channel/category.
- Two projection close-lines: FD/FP-based (full horizon) and AR/AP-based (near-term).

## 6. UI changes (`app.js`)

- **Dashboard**: chart = solid HD + two dotted (AR/AP near, FD/FP far); "全年收款" KPI split
  HD/AR/FD; expense split Paid/AP/FP.
- **预测**: FD bands + FD-vs-AR variance.
- **历史**: HD entry (largely unchanged).
- **应收账款**: per-shipment collection override + show computed collection week; category lag display.
- **假设**: four lag fields in 回款节奏.
- **苗/花应付款**: add 运费 payables; 逾期应付 band; provenance labels.
- **物流成本**: freight surfaced as its own AP line.
- **管理层报告**: explicit HD/AR/FD + Paid/AP/FP breakdown under the cash-collection lens.

## 7. Tests

- `test/engine.test.js`: no-sum invariants (FD≠FD+AR, FP≠FP+AP), per-shipment lag computation,
  overdue roll-forward, 运费 split out of materials.
- DOM tests: provenance bands present and wired; two-dotted-line chart; new 假设 lag fields.
