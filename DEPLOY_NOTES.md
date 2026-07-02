# Deploy notes / handoff

Working branch: **`main`** (single branch; all app work lands here).

## Goal
Deploy the app to **Cloudflare Pages** on the owner's account. The build is
**dist-based**: `npm run build` copies `index.html` + `styles.css` + `src/*`
into `dist/`, and the committed `wrangler.toml` sets
`pages_build_output_dir = "dist"` (plus the D1 binding). The backend
(Pages Functions in `functions/` + D1) is live via the `RemoteAdapter`
in `src/store.js`.

## ⚠️ Shared-account guardrail (must respect)
A DIFFERENT project already exists on this Cloudflare account. **Do not touch
it.** Cloudflare isolates by name/ID, so safety = discipline:
- Use ONLY these unique names:
  - Pages project: **`kmty-financial-forecaster`**
  - Worker (later): `kmty-forecaster-api`
  - D1 (later): `kmty-forecaster-db`
- **Never** run destructive commands (`pages project delete`, `d1 delete`,
  `wrangler delete`, etc.) against anything.
- Inventory first; only create/deploy against our own names.

## Auth
`CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID`) are set in the cloud
**environment settings** (env-var visibility caveat noted — keep token scoped
to Pages/Workers/D1 Edit only, rotate if needed). Network access is set to
**Custom** including `api.cloudflare.com` and `*.cloudflare.com` plus the
default package registries.

## Deploying
**Automatic:** every push to `main` runs `.github/workflows/deploy.yml`
(tests → build → deploy to production). One-time setup: add the
`CLOUDFLARE_API_TOKEN` repository secret on GitHub.

**Manual (fallback):**
```bash
npx wrangler whoami        # MUST show the correct account/email — stop if not
npm ci && npm run test:all # regression gate: engine + DOM smoke + wiring
npm run build              # regenerates dist/ from src/
npx wrangler pages deploy --project-name kmty-financial-forecaster --branch main
```
(`wrangler.toml` supplies `pages_build_output_dir = "dist"`; `functions/` at
the repo root is bundled automatically.)
