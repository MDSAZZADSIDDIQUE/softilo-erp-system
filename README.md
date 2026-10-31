# Softilo ERP

Accounts, stock and landed cost in one system, for UK importers and wholesalers.
Everything is built in-house: general ledger, VAT, inventory, purchasing, sales and banking. There are no dependencies on Xero, Sage, Unleashed or Cin7.

The product plan is in [docs/architecture-and-mvp-plan.md](docs/architecture-and-mvp-plan.md).

## What works today

| Area | Features |
|---|---|
| **Ledger** | UK chart of accounts, append-only double-entry journals, manual journals and reversals, lock date, control accounts, hash-chained audit trail |
| **Purchasing** | Purchase orders in any currency → approve → receive goods (part deliveries) → supplier bills matched to receipts, with price/FX variance |
| **Landed cost** | Group receipts into shipments, add freight/duty/fees, spread by value, weight, volume or quantity to the penny, revalue stock (or cost of sales for units already sold) |
| **Inventory** | Multiple warehouses, weighted-average costing, stock movements, adjustments, reorder levels |
| **Sales** | Invoices that issue stock at landed cost, credit notes with returns to stock, printable UK tax invoices |
| **Banking** | Customer receipts and supplier payments with realised FX, CSV statement import (UK bank formats), matching suggestions, code-to-account |
| **VAT** | UK VAT codes including domestic reverse charge, postponed import VAT (PVA) matched to shipments by MRN, 9-box return, finalise with settlement journal and period lock |
| **Reports** | Dashboard, P&L, balance sheet, trial balance, aged debtors and creditors, stock valuation, integrity checks (stock and GRNI vs. ledger) |

**Not built yet:** submitting returns to HMRC (MTD), Open Banking feeds, MFA, multi-entity, file importers from other systems, payroll. See the plan for phasing.

## Layout

```
apps/api        Fastify HTTP API (modules: auth, master data, purchasing, sales, banking, VAT, ledger/reports)
apps/web        Next.js app (Softilo brand: Ink, Paper and Signal orange; Roboto throughout)
packages/domain Pure TypeScript rules: money, VAT, posting rules, landed-cost allocation, costing
packages/db     Postgres schema (SQL migrations), RLS, integrity triggers, PGlite/pg drivers
```

## Running it

Needs Node 22+ and pnpm 10.

```bash
pnpm install
```

```bash
pnpm seed
```

```bash
pnpm dev
```

Then open http://localhost:3000 and choose **Open the demo**. The API runs on port 4000. Each Softilo product has its own ports, so they can run side by side.

Without `DATABASE_URL`, the API uses an embedded Postgres (PGlite) stored in `.data/`. It runs the same SQL, row-level security and triggers as production. To use a real Postgres server, set `DATABASE_URL` (see [.env.example](.env.example)). The API connects as the owning role and switches to the restricted `softilo_app` role for every tenant request.

## Demo company

`pnpm seed` creates Thames Valley Imports Ltd: a Reading housewares importer with six months of trading: USD purchase orders at every stage, five landed shipments, one still to cost, trade invoices, credit notes, part payments, a part-reconciled bank statement, postponed import VAT and a finalised VAT return. Everything goes through the real API, so the demo obeys the same rules as live data and the ledger checks reconcile.

- The login page offers the demo in development. Its details are in [apps/api/src/lib/demo.ts](apps/api/src/lib/demo.ts).
- `pnpm seed:reset` clears the embedded database and creates the demo again. Use it to tidy up after people have tried things.
- All companies, people and references in the demo are made up. Dates are fixed around autumn 2026 or set relative to the day you seed, so reseed a public demo now and then to keep it current.

## Going live

- Set `DATABASE_URL` and `NODE_ENV=production`. The API refuses to start on the embedded database in production unless `DEMO_MODE=1`.
- Serve it over HTTPS: session cookies are marked secure in production.
- Set `API_URL` when you run `pnpm build`, because the web app fixes where it proxies `/api` at build time.
- Never run the seed against live data. It creates a user whose password is public, and refuses to run in production without `DEMO_MODE=1`.
- For a public demo server, set `DEMO_MODE=1` on the API and hold nothing but demo data there.
- Sign-in attempts are limited per email and per address in memory, so put a shared limiter in front if you run more than one API process.

## Tests

```bash
pnpm test
```

- `packages/domain`: unit and property-based tests (every journal balances, landed-cost splits always add up to the penny, costing never strands value).
- `packages/db`: the database itself refuses unbalanced entries, cross-tenant access, edits to the ledger, postings into locked periods and manual journals on control accounts.
- `apps/api`: an end-to-end run through the whole importer cycle over HTTP. It covers USD purchase, receipt, bill with FX variance, freight and duty landed by weight and value, sale, credit note, payments with realised FX, bank import and reconciliation, PVA, and VAT return and lock. It checks the books balance at every step.

## Rules the system enforces

- Money is never a float: `decimal.js` in TypeScript, `numeric` in Postgres, strings over the wire.
- Every journal balances, enforced by a deferred constraint trigger at commit.
- Journals, stock movements and the audit log are append-only. Corrections are new entries.
- Each tenant sees only its own rows (Postgres row-level security), even if application code has a bug.
- Stock in the warehouse equals stock in the ledger, because both are written in the same transaction. The integrity report checks this.
