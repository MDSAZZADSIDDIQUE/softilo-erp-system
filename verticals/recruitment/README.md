# Softilo Recruitment

Placements, timesheets, client billing, worker pay accruals, AWR tracking and gross margin for UK staffing agencies, built on the Softilo core ledger. The plan and the UK rules it follows are in [docs/plan.md](docs/plan.md).

| Package | What it holds |
|---|---|
| `domain` (`@softilo/recruitment-domain`) | Pure rules with tests: placement compliance (KID, IR35/SDS, NLW), timesheet validation and pricing, worker pay accrual posting, invoice lines, AWR 12-week assessment, margin, perm fees and rebates |
| `api` (`@softilo/recruitment-api`) | `rec_*` migrations with RLS, `/api/rec/*` routes registered on the core server, end-to-end test |
| `web` (`@softilo/recruitment-web`) | Next.js app in the Softilo brand. Recruitment screens, plus core screens (invoices, payments, banking, VAT, reports, journals, accounts) re-exported from `apps/web` |

## Running it

```bash
pnpm install
```

```bash
pnpm turbo run build --filter=./packages/* --filter=./verticals/recruitment/domain
```

```bash
pnpm --filter @softilo/recruitment-api dev
```

```bash
pnpm --filter @softilo/recruitment-web dev
```

The API listens on port 4070 (embedded PGlite in `.data/pglite-recruitment` unless `DATABASE_URL` is set) and the web app on http://localhost:3070. Sign up a new agency from the web app.

## Tests

```bash
pnpm --filter @softilo/recruitment-domain --filter @softilo/recruitment-api test
```
