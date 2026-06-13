# Deploy notes / handoff

Working branch: **`claude/amazing-hypatia-d0c7n6`** (all app work is here).

## Goal
Deploy the static app (repo root: `index.html` + `styles.css` + `src/*`) to
**Cloudflare Pages** on the owner's account (the correct email — a fresh,
minimally-scoped API token was created for it). Backend (Worker + D1) comes
later via the `RemoteAdapter` seam in `src/store.js`.

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

## First steps in the new session (in order)
```bash
git fetch origin && git checkout claude/amazing-hypatia-d0c7n6   # get the app
npx wrangler whoami                                              # MUST show the correct account/email — stop if not
# read-only inventory: confirm our names don't collide with the existing project
npx wrangler pages project list
npx wrangler d1 list
npx wrangler kv namespace list
```
Only after `whoami` shows the right account AND the inventory shows no
`kmty-financial-forecaster` collision:
```bash
# scaffold a secrets-free wrangler.toml (name = kmty-financial-forecaster, pages_build_output_dir = ".")
npx wrangler pages deploy . --project-name kmty-financial-forecaster
```

## Tests (regression safety before deploying)
```bash
npm test          # engine, zero-dep
npm install && npm run test:dom   # jsdom DOM/wiring tests
```
