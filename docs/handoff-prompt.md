# Handoff prompt for a new Claude session

Paste everything inside the box below as the first message to a new Claude session working in a local clone of this repository.

````text
You're working in my local clone of Softilo ERP (github.com/MDSAZZADSIDDIQUE/softilo-erp-system): accounts, stock and landed cost in one system for UK importers and wholesalers. It's a pnpm + Turbo monorepo:
- apps/api: Fastify API (modules in src/modules; outside services run in demo mode until live credentials are set, see README.md "Outside services")
- apps/web: Next.js app
- packages/domain: pure TypeScript rules (money, VAT, posting rules, landed cost, costing)
- packages/db: Postgres SQL migrations with row-level security and triggers; it runs on embedded PGlite when DATABASE_URL isn't set

Start by reading README.md and docs/architecture-and-mvp-plan.md. The plan's roadmap (§2) has no done/not-done marks, so compare it with README.md "What works today" and the code. Then run `pnpm install`, `pnpm typecheck` and `pnpm test` to confirm everything passes before you change anything. Work from the latest `main`. Ignore the old `claude/vertical-*` branches; they were the starting points of separate product repositories.

Follow the "Rules the system enforces" section of README.md. In particular:
- Money is never a float. Every journal balances. Ledger, stock and audit records are append-only, so corrections are new entries.
- Every posting goes through rules in packages/domain, in the same transaction as its stock movements.
- Each new table gets forced row-level security, created in a new numbered migration. Never edit an existing migration.
- Outside services stay behind adapters with a demo mode. Don't fake a live connection.
- Anything not checked against GOV.UK, legislation or a standard's specification is marked [unverified] in the plan. Never present such a rule as confirmed.
- Every feature gets domain unit tests and coverage in an API e2e test that checks the books and stock balance. Update the demo seed so the demo shows the feature, and update README.md and the plan when something is done.

Remaining work, in the order I'd like it done:

Housekeeping:
1. Add done/not-done marks to the roadmap in docs/architecture-and-mvp-plan.md §2, based on the code.

Phase 1 gaps (finance):
2. Recurring journals and year-end close.
3. Customer statements.
4. Supplier payment runs with a Bacs Standard 18 file export.
5. OFX and CAMT.053 bank statement import (CSV exists).
6. VAT cash accounting in the 9-box return (the scheme is stored on the company; check whether the return honours it).
7. Period-end revaluation of foreign-currency balances, posting unrealised FX gains and losses (today it is only shown in analytics).
8. Cash flow statement, general ledger detail and VAT detail reports, and a journal export for the accountant.

Phase 1 gaps (operations):
9. Quotes → sales orders → pick, pack and dispatch → invoices, with back orders, price lists and customer-specific pricing.
10. Products: variants, barcodes and supplier SKUs (check what units of measure already do).
11. Bin locations, stock takes and optional batch/lot tracking per SKU.

Phase 1 gaps (onboarding):
12. File importers for exports from Xero, Sage 50/200, QuickBooks, Unleashed and Cin7, each with a preview and an opening trial balance reconciliation before anything posts.
13. Accountant portal: one login across several client companies, with review access, adjusting journals and period locking.

Later phases, ask me before starting: Phase 2 (channels, carrier labels, warehouse scanning app), Phase 3 (multi-entity and consolidation, fixed assets, accruals and prepayments, budgets, iXBRL accounts, Peppol e-invoicing, Direct Debit) and Phase 4 (payroll).

Out of scope until I have credentials: live HMRC, TrueLayer bank feed, Companies House, Postmark email and FX connections, and the Gemini key.

Work one numbered item at a time. For each item: check the existing code first; if a rule is uncertain, ask me or mark it [unverified]; implement it with tests; run `pnpm typecheck` and `pnpm test`; update the docs; then commit with a clear message. Tell me briefly what you did before moving to the next item, and stop to ask if something needs a decision from me.
````
