# 昆明统一生物科技有限公司 · 财务分析系统

A **weekly-keyed, full-year cash-flow forecaster**. The fiscal year is split
into ~50 weeks. An *as-of* date (`截至`) divides **elapsed weeks** (where you
key in real **actuals**) from **future weeks** (computed from named
**assumptions**). History + Forecast together produce the full-year picture,
and every edit autosaves.

> The core loop this app delivers:
> **assumptions → fill the forecast → as real time elapses, actuals are keyed
> in and replace the forecast for that week → repeat, until the whole year
> becomes predictable for management.**

This is a clean, **dependency-free, build-free static web app**. It was
rebuilt from an earlier Claude "artifact" prototype (kept under
[`reference/`](reference/) for provenance) so that it no longer depends on any
proprietary runtime or foreign CDN, and so it can be hooked to a real backend.

---

## 运行 / Running it

No build step, no `npm install`, no internet required.

```bash
# Option A — just open the file
open index.html            # macOS  (or double-click it)

# Option B — serve it (recommended; identical behaviour)
python3 -m http.server 8080   # then visit http://localhost:8080
# or:  npx serve .
```

Run the tests:

```bash
npm test         # engine unit tests — pure Node, ZERO dependencies (11 checks)
npm install      # (once) installs jsdom, the only dev dependency, for DOM tests
npm run test:dom # end-to-end DOM tests in jsdom: renders every page and drives
                 # every field through real events (20 + 56 assertions)
npm run test:all # everything (87 checks)
```

The DOM tests are the field-wiring guarantee: they assert that **every input
lands at the right state key and flows to its derived output** (KPIs, chart,
totals, variance, the actual-replaces-forecast ladder, AR→国内收款, etc.).

### 为什么没有外部依赖？(China-friendly by design)
The original prototype loaded React, Babel **and Google Fonts** from foreign
CDNs (`unpkg.com`, `fonts.googleapis.com`) — all of which are unreachable or
unreliable behind the Great Firewall. This rebuild ships **zero external
requests**: vanilla JS, and Chinese type rendered with locally-installed
system fonts (PingFang SC / 微软雅黑 / Noto Sans CJK). It works fully offline.

---

## 架构 / Architecture

```
index.html        markup shell (loads the three scripts, in order)
styles.css        the visual system + China-safe CJK font stacks
src/
  engine.js       PURE forecasting engine — no DOM, no I/O, the "cash spine"
  store.js        application state + a SWAPPABLE persistence adapter
  app.js          UI: view-model builder, per-page renderers, event wiring
test/
  engine.test.js  Node unit tests for the engine
reference/        the original artifact + source spreadsheets (provenance)
```

**Strict separation of concerns** — this is what makes the backend swap easy:

- **`engine.js`** is pure and side-effect-free. It owns *all* the maths
  (week grid, assumption carry-forward, per-week forecast, actual/forecast/
  effective resolution, the chained balance series, formatting). It never
  touches the DOM or storage, so it's unit-tested directly in Node.
- **`store.js`** is the *only* place that knows about persistence. It exposes
  mutators (`editMap`, `editArr`, `addRow`, …), notifies subscribers, and
  writes through a **persistence adapter**. Today that's `LocalStorageAdapter`;
  a `RemoteAdapter` skeleton is already in the file.
- **`app.js`** rebuilds the page from `state` on every change (single render
  path = never-stale UI), preserving keyboard focus/caret by element id, and
  delegates all input/click events.

### The calculation spine
```
周末余额 = 周初余额 + 本周收款 − 本周支出     (chained week → week)
Week 1 opening balance = 财年期初余额 (editable in the header)
```

### How the pages connect (every field is wired to its destination)

| Page | You enter… | …which flows into |
|------|------------|-------------------|
| **假设** Assumptions | per-week named drivers (单价/回款率/销量/淘汰率/成本/租金/固定支出), inherited week-to-week | the **forecast** value of every future week |
| **预测** Forecast | optional per-field overrides | replaces that week's assumption-computed value |
| **历史数据** Historical | real actuals for elapsed weeks | **replaces** the forecast for that week in the series & variance |
| **苗款** Seedling payables | supplier / qty / price / **付款日期** | a payable dated inside a week becomes that week's **苗款** outflow |
| **应收账款** Receivables | per-week **本周预计回款** per customer | **added into the forecast's 国内收款** for that week |
| **总览 / 报告** | — (read-only) | KPIs, the actual-vs-forecast chart, variance, narrative |

### What was fixed vs. the prototype
1. **应收账款 → 国内收款**: the per-week expected collection now actually feeds
   the forecast's domestic collection (it was stored but never used). The 收款测算
   panel shows it as an explicit, reconciling line (销售回款 ＋ 应收账款回款).
2. **期初余额** is now editable (header), instead of a hard-coded constant.
3. **苗款 备注** column added (the field existed in the data but had no input).
4. **紧急度** select is now colour-coded by tier (amber/grey/green/blue).
5. Removed the proprietary runtime + all foreign-CDN dependencies.

---

## 后端路线图 / Backend roadmap (Cloudflare now, switch later)

The app is **backend-ready by construction**: persistence lives behind one
adapter in `store.js`, so wiring a server is a localized change — the engine
and UI don't move.

### Phase 1 — host the static app on **Cloudflare Pages**
The repo root *is* the site. In Cloudflare Pages: connect this repo, set
**Build command:** *(none)* and **Output directory:** `/` (root). Done — it
serves `index.html` + `styles.css` + `src/*`.

> ⚠️ **China note:** Cloudflare's normal network is throttled/unreliable from
> mainland China, and a `.cn` (or China-served) domain needs an **ICP 备案**.
> Cloudflare's *China Network* (via JD Cloud) requires an Enterprise plan + a
> filed ICP. This is fine for an internal management tool reached over VPN or
> from outside the mainland, but it's the main reason you'll want to switch
> hosts later (see Phase 3).

### Phase 2 — add a **Cloudflare Worker + D1** API
Persist the whole state document (it's already one JSON blob) per company/user.

1. Implement `RemoteAdapter` (skeleton already in `src/store.js`):
   `load()` → `GET /state`, `save(state)` → `PUT /state` (debounced).
2. In `src/app.js` `boot()`, swap one line:
   ```js
   // store = new FFStore.Store(new FFStore.LocalStorageAdapter());
   store = new FFStore.Store(new FFStore.RemoteAdapter('https://api.example.cn', token));
   ```
3. A minimal Worker (D1 or KV) storing `{ id, json, updated_at }` is enough.
   Because the engine is pure, server-side recomputation/validation can reuse
   `src/engine.js` *as-is* inside the Worker.

### Phase 3 — switching off Cloudflare later
Since the only coupling is the adapter's `load()/save()` HTTP calls, moving to
a **mainland-China host** (e.g. Tencent EdgeOne / 腾讯云, Aliyun / 阿里云, or a
self-hosted Nginx + a small API) means: re-point the `RemoteAdapter` base URL
and redeploy the same static files. No engine/UI changes.

---

## Data & units
- Money is **entered in 元** everywhere; the **单位：万 / 元** toggle only
  changes *display*. `万` shows `123.46万`; `元` shows `¥1,234,567`.
- Default fiscal year is the lunar boundary **2026-02-17 → 2027-02-05**;
  changing the dates regenerates the week grid. Everything autosaves to the
  browser (key `kmty.finance.v3`). **重置数据** restores the seeded demo data.
