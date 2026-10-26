# Softilo ERP — Architecture & MVP Plan

**Target:** UK wholesalers and importers, 10–250 staff, outgrowing Xero / QuickBooks / Sage 50.
**Stack:** TypeScript end to end, PostgreSQL, hosted in the UK.
**Status:** Draft v0.3, 26 Oct 2026. The first build of the Phase 1 core is in this repo (see README). Every core system (accounting, VAT, inventory, orders) is built in-house; there are no dependencies on Xero, Sage, Unleashed or Cin7.

---

## 1. Positioning

Softilo sits in the gap that opens when a business outgrows bookkeeping software but isn't ready for a mid-market ERP. Below it are bookkeeping tools (Xero, QuickBooks, Sage 50). Above it are mid-market ERPs (NetSuite, Business Central, SAP B1), which typically mean a £30k–£100k implementation, a 6–9 month rollout and multi-year contracts.

**Wedge:** importers and wholesalers, where generic tools fail on UK-specific problems:

| Pain today | Softilo answer |
|---|---|
| Freight, duty and broker fees spread across SKUs by hand in spreadsheets | **Landed cost engine** that allocates by value, weight, volume or quantity and revalues stock automatically |
| Post-Brexit import VAT handled outside the books | **Postponed VAT Accounting (PVA)**: ingest the monthly CDS statement and post to VAT return boxes 1, 4 and 7 |
| Suppliers invoicing in USD/EUR/CNY | Multi-currency purchasing with realised and unrealised FX |
| Stock and orders live in a separate tool from the accounts | **One system:** operations and accounting share the same database and ledger, so stock value, cost of sales and VAT are always consistent |

**Rule for the first product:** *own the whole stack.* Softilo is the customer's books from day one: its own general ledger, debtors and creditors, bank reconciliation and MTD VAT filing. We never depend on another accounting or inventory product. Customers moving from Xero, Sage, Unleashed or Cin7 come across by importing **files they export** from those systems. We don't use those vendors' APIs and don't need a partnership with them.

**What this costs:** a longer MVP (about 9 months instead of 6), and we have to win over the customer's accountant, who is used to Xero or Sage. The accountant portal (§8) and accountant-friendly reports (trial balance, audit trail, journal export) therefore move into the MVP.

---

## 2. Phased roadmap

### Phase 1 — Finance + operations core (MVP, ~9 months)
Goal: a 20-person importer runs **all** of its operations and bookkeeping in Softilo and files VAT from it, with no other accounting software.

**Finance**
- **General ledger:** UK chart of accounts template (FRS 102 layout), manual journals, recurring journals, accounting periods with locking, year-end close.
- **Sales ledger (debtors):** customer invoices and credit notes, receipts, matching payments to invoices, aged debtors, statements, payment reminders.
- **Purchase ledger (creditors):** supplier bills, payments, aged creditors, payment runs, Bacs payment file export (Bacs Standard 18).
- **Bank:** import statements (CSV, OFX, CAMT.053), reconciliation with matching rules. Open Banking feeds are added via an FCA-authorised account-information provider. We can't hold that authorisation ourselves at launch, so this is a regulated connection, not a dependency on another accounting product.
- **VAT:** UK VAT codes (standard, reduced, zero, exempt, outside scope, reverse charge, PVA), the 9-box return, cash and standard accounting, **MTD VAT submission to HMRC** with fraud-prevention headers, and HMRC software recognition.
- **Multi-currency:** foreign-currency invoices and bills, realised and unrealised FX gains and losses, period-end revaluation.
- **Financial reports:** trial balance, P&L, balance sheet, cash flow, VAT detail, general ledger detail, and journal export for the accountant.

**Operations**
- **Organisation setup:** create the company via Companies House lookup, add users and roles, require MFA.
- **Products:** SKUs, variants, units of measure, commodity codes (HS/CN), weight and volume, barcodes, supplier SKUs.
- **Contacts:** customers and suppliers, with Companies House and VAT number validation (HMRC check-a-VAT-number API).
- **Purchasing:** purchase orders in any currency, goods-received notes (partial receipts), supplier bills, three-way match (PO / GRN / bill).
- **Landed cost:** shipments/containers grouping POs; cost lines for freight, duty, insurance, brokerage and port fees; allocation methods; revaluation after the fact.
- **Inventory:** multiple warehouses and bin locations, immutable stock movements, weighted-average costing (FIFO later), stock takes, batch/lot tracking (optional per SKU).
- **Sales:** quotes → sales orders → pick/pack/dispatch → invoices, credit notes, price lists, customer-specific pricing.
- **Automatic posting:** every receipt, landed cost, dispatch, invoice and payment posts its own balanced journal to the general ledger. Nothing is re-keyed.
- **Operational reporting:** stock valuation (reconciled to the stock account in the ledger), margin by SKU/customer, open POs, back orders, landed cost per unit.

**Onboarding & accountants**
- **Migration from exported files:** importers for the files customers can export from Xero, Sage 50/200, QuickBooks, Unleashed and Cin7. These cover the chart of accounts, opening trial balance, contacts, open invoices and bills, products and opening stock. They read files only and never connect to those systems' APIs.
- **Accountant portal:** one login for an accounting firm across all its clients, with review/audit access, adjusting journals and period locking.

### Phase 2 — Fulfilment & channels (~3–4 months)
- Shopify, WooCommerce and Amazon UK order sync; marketplace payout reconciliation.
- Carrier labels: Royal Mail Click & Drop, DPD, Evri, DHL UK.
- Barcode-scanning PWA for warehouse picking and receiving.
- Demand forecasting and reorder points from supplier lead times.
- OCR capture of supplier invoices.

### Phase 3 — Group finance & year-end (~6 months)
- Multiple entities, intercompany transactions, consolidation.
- Fixed asset register and depreciation, prepayments and accruals schedules, budgets vs. actuals.
- Statutory accounts in iXBRL, so accountants can file with Companies House and HMRC (CT600) from our data.
- E-invoicing that can be switched to Peppol, ahead of the announced April 2029 UK B2B e-invoicing mandate.
- Direct Debit collection.

### Phase 4 — Payroll (in-house, ~6–9 months, optional)
- PAYE/NI calculation, RTI submissions (FPS/EPS), statutory pay (SSP, SMP, SPP, ShPP), student loans, P60/P45, and workplace pension auto-enrolment with pension-provider file exports.
- This is the most heavily regulated module. Tax tables and rules change every April, so it needs HMRC RTI recognition and a dedicated rules-maintenance owner. Only start it once Phases 1–2 have paying customers.

### Deliberately out of scope (for now)
- **Integrations with Xero, Sage, Unleashed or Cin7.** We replace them; we don't sync with them. File-based migration is the only touch point.
- **Full MRP/manufacturing.** Kits and simple assemblies only, until there is demand.
- **CIS / construction.** A possible second vertical later.

---

## 3. System architecture

```
                    ┌──────────────────────────────┐
  Browser / PWA ───▶│  apps/web  (Next.js, React)  │
                    └──────────────┬───────────────┘
                                   │ HTTPS (typed client from OpenAPI)
                    ┌──────────────▼───────────────┐
  Public API  ─────▶│  apps/api  (Fastify + zod)   │──▶ Companies House, HMRC VAT check
  Webhooks          │  modules: org, catalogue,    │
                    │  inventory, purchasing,      │
                    │  sales, landed-cost, ledger, │
                    │  banking, vat                │
                    └───────┬──────────────┬───────┘
                            │ SQL (RLS)    │ outbox rows
                    ┌───────▼──────┐  ┌────▼───────────────┐
                    │ PostgreSQL 16│◀─│ apps/worker        │──▶ HMRC MTD, Open Banking,
                    │ (UK region)  │  │ pg-boss jobs       │    carriers, marketplaces
                    └──────────────┘  └────────────────────┘
```

One deployable **modular monolith** (API plus worker) from a single codebase. Module boundaries are enforced by lint rules, so a module can be split out later if needed. Microservices are not worth it at this stage.

### 3.1 Technology choices

| Concern | Choice | Why |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | Shared types between web, api and worker |
| Front end | Next.js (App Router), React, TanStack Table/Query, shadcn/ui | Data-dense screens; mature ecosystem |
| API | Fastify + zod, one module per area | Small and fast; zod validates every request. (Built without NestJS: decorators added build friction for little gain at this size.) |
| SQL | Hand-written SQL migrations + parameterised queries | Full control of RLS policies, constraints and triggers; no ORM layer between the ledger and Postgres |
| Database | PostgreSQL 16 (PGlite, an in-process Postgres, for local development and tests) | Transactions, RLS, `numeric`, deferred constraint triggers. The same SQL runs in both |
| Jobs / events | pg-boss + transactional outbox | No Kafka or Redis to run; exactly-once handoff from DB commit |
| Auth | better-auth (email + TOTP/passkey MFA); WorkOS for SSO later | MFA status is needed for HMRC fraud-prevention headers |
| Files | S3 (eu-west-2), presigned uploads | Attachments, CDS statements, labels |
| Hosting | AWS eu-west-2 (London): ECS Fargate, RDS Postgres, KMS | UK data residency |
| Observability | OpenTelemetry → Grafana Cloud (EU) or Datadog EU; Sentry | Tracing across API, worker and integrations |
| Testing | Vitest + fast-check, PGlite for database and end-to-end API tests; Playwright for UI later | Ledger logic is tested against real Postgres semantics, with no Docker needed |
| CI/CD | GitHub Actions, IaC with Terraform or AWS CDK | |

### 3.2 Repository layout

```
apps/
  web/            Next.js app
  api/            Fastify HTTP API
  worker/         pg-boss consumers (integrations, outbox relay, reports)
packages/
  domain/         Pure TS domain logic: money, VAT, landed-cost allocation, costing
  db/             SQL migrations, RLS policies, integrity triggers, Postgres/PGlite drivers
  contracts/      zod schemas + generated OpenAPI client
  integrations/   hmrc/, companies-house/, open-banking/, carriers/  (adapters behind interfaces)
  importers/      File parsers for migrating from Xero / Sage / QuickBooks / Unleashed / Cin7 exports
  ui/             Shared React components
infra/            Terraform / CDK
docs/
```

`packages/domain` has **no I/O**. Double-entry posting rules, allocation, costing, VAT and rounding are pure functions with exhaustive unit and property-based tests (fast-check).

---

## 4. Core design decisions

### 4.1 Multi-tenancy
- Shared schema, a `tenant_id` column on every table, and **Postgres Row-Level Security** on every tenant table.
- The API connects as a non-owner role and runs `SET LOCAL app.tenant_id = …` per transaction. Policies check `tenant_id = current_setting('app.tenant_id')::uuid`.
- A CI test fails the build if any table lacks an RLS policy.
- Per-tenant data keys via AWS KMS for attachments and sensitive fields (e.g. bank details). Per-tenant schemas are kept as an upgrade path for enterprise customers, not the default.

### 4.2 Money, quantities and rounding
- Money is stored as `numeric(19,4)` plus an ISO currency code. In TypeScript it is a `Money` value object backed by `decimal.js`. **Floats are never used.**
- Unit costs use `numeric(20,6)`, because landed cost per unit often goes below 1p. Quantities use `numeric(18,4)`.
- FX rates use `numeric(18,8)`, stored per document with their source (HMRC monthly rate or bank rate). HMRC monthly exchange rates are available for customs values.
- VAT is calculated per line and rounded half-up to 1p. An invoice-level rounding mode is configurable, as HMRC allows either if applied consistently.

### 4.3 Immutable general ledger and stock ledger
- `journal_entries` / `journal_lines` and `stock_movements` are **append-only**: `INSERT` only. `UPDATE` and `DELETE` are revoked from the app role, and a trigger blocks them.
- Every journal entry must balance (Σdebit = Σcredit per entry, in base currency and in transaction currency). This is enforced by a deferred constraint trigger, so an unbalanced entry can never be committed.
- Each stock movement records SKU, location, batch, quantity (±), unit cost, source document, user and timestamp.
- **One posting engine:** every business document (GRN, bill, landed cost, dispatch, invoice, payment, bank line) is turned into journal lines by posting rules in `packages/domain`, in the **same database transaction** as its stock movements. Stock in the ledger and stock in the warehouse cannot drift apart. A nightly job also checks that they agree.
- Control accounts (debtors, creditors, stock, GRNI, VAT, landed-cost clearing) accept postings only from their sub-ledgers, never from manual journals.
- Corrections post compensating entries or movements. Landed-cost revaluations post **value-only** movements (zero quantity, non-zero value).
- Account balances, on-hand stock and average cost are **projections**, updated in the same transaction and rebuildable from the entries.
- Accounting periods can be locked. Back-dated postings into a locked period are refused or redirected into the current period.

### 4.4 Audit trail
- Every command is logged in an `audit_log` row: actor, tenant, IP, user agent, before/after JSON, and a correlation ID. The table is append-only.
- Rows are hash-chained per tenant (each row stores the hash of the previous row), so tampering can be detected. That is useful evidence in an HMRC enquiry.

### 4.5 Documents and state machines
- Purchase orders, GRNs, bills, sales orders and invoices are explicit state machines: draft → approved → part-received / received → closed / cancelled.
- Posted documents are never edited, only reversed or credited. This matches how accountants expect a system to behave.
- Numbering sequences are per tenant and per document type, with no gaps (a locked counter row, not a Postgres sequence).

### 4.6 Integrations
- Every external system sits behind an adapter interface in `packages/integrations`. Calls go through the outbox → pg-boss, are **idempotent** (keyed by internal document ID plus version) and retry with backoff.
- **HMRC (MVP):** check-a-VAT-number, plus MTD VAT (obligations, submit return, liabilities, payments) using OAuth2 per VAT registration. Fraud-prevention headers (`Gov-Client-*`, `Gov-Vendor-*`) are collected by a small browser module and stored per session. They are checked against HMRC's Test Fraud Prevention Headers API in CI. Submitted returns are kept permanently with their HMRC receipt.
- **Open Banking:** account-information access via an FCA-authorised provider, with transactions landing in the same `bank_transactions` table as file imports. Statement import (CSV/OFX/CAMT) works without it.
- **Companies House:** company search and profile lookup during onboarding and contact creation.
- **No accounting or inventory vendor APIs.** Migration is file-based (`packages/importers`). Each importer produces a preview and a reconciliation (opening trial balance must match the export) before anything is posted.

---

## 5. Landed cost engine (the wedge feature)

**Inputs:** a shipment containing receipt lines (SKU, qty, FOB value in supplier currency, weight, volume, commodity code) plus cost lines (type, amount, currency, VAT treatment, allocation method).

**Allocation methods:** by value, weight, volume, quantity, or manual. Duty can be calculated **per commodity code** (rate × customs value) instead of being spread.

**Algorithm (pure function in `packages/domain`):**
1. Convert everything to GBP at the rate configured for each cost line.
2. For each cost line, compute each receipt line's share by the chosen basis.
3. Allocate using the **largest-remainder method**, so pence add up exactly to the cost-line total.
4. Unit landed cost = (FOB + Σ allocated costs) / qty, kept at 6 decimal places.

**Timing:** costs often arrive weeks after the goods. Estimated costs can be booked at receipt (accrued) and trued up when the actual bills arrive. The difference is split between remaining stock (revaluation) and units already sold (COGS adjustment), using the stock movements to work out how much was sold.

**Outputs:** a value-only stock movement per SKU, a journal moving each cost line from the landed-cost clearing account into stock (or COGS), and a landed-cost report per shipment and per unit.

### Postponed VAT Accounting
- Import VAT under PVA does not go through the supplier bill. The user uploads the monthly **PVA statement** (downloaded from the CDS service). The system matches entries to shipments by MRN/entry number, then:
  - records import VAT as both output (box 1) and input (box 4) VAT, with the net value in box 7;
  - flags unmatched entries and shipments that have no statement entry.
- The postings go straight into the VAT ledger and are included in the next MTD return.

---

## 6. Core data model (Phase 1, abridged)

```
tenant ─┬─ user_membership(role)
        ├─ warehouse ─ location(bin)
        ├─ product ─ product_variant(sku, uom, hs_code, weight, volume)
        ├─ contact(type: customer|supplier, company_number, vat_number, currency)
        ├─ purchase_order ─ po_line
        ├─ goods_receipt ─ grn_line ──┐
        ├─ supplier_bill ─ bill_line  │
        ├─ shipment ─ shipment_cost ──┴─ landed_cost_allocation
        ├─ stock_movement (append-only)  → stock_balance (projection)
        ├─ sales_order ─ so_line ─ dispatch ─ dispatch_line
        ├─ sales_invoice ─ invoice_line ; credit_note
        ├─ pva_statement ─ pva_entry
        ├─ account(chart of accounts, type, control_for) ─ account_balance (projection)
        ├─ accounting_period(status: open|locked|closed)
        ├─ journal_entry ─ journal_line (append-only, balanced)
        ├─ tax_code ─ vat_return(period, boxes 1–9, hmrc_receipt)
        ├─ bank_account ─ bank_transaction ─ reconciliation_match
        ├─ payment ─ payment_allocation(invoice|bill|credit_note)
        ├─ fx_rate ; fx_revaluation_run
        ├─ hmrc_connection ; fraud_header_snapshot
        ├─ import_job(source, file, preview, status)
        ├─ outbox_event
        └─ audit_log (append-only, hash-chained)
```

---

## 7. Security & compliance plan

| Item | When |
|---|---|
| UK hosting (eu-west-2), backups in the UK, point-in-time recovery | From day one |
| MFA required for admins, optional for others; full session logging | MVP |
| UK GDPR: Data Processing Agreement, records of processing, list of sub-processors, data export and deletion per tenant | MVP |
| Cyber Essentials | Before first paying customer |
| Cyber Essentials Plus | Within 12 months |
| HMRC MTD VAT software recognition | MVP (required before launch) |
| HMRC RTI recognition | Phase 4 (payroll) |
| ISO 27001 (if moving upmarket) | Year 2–3 |

---

## 8. Commercial model (for the product's design)

- **No per-user pricing.** Price by module tier plus order or transaction volume, with unlimited users. Feature flags and usage metering are built into the platform module from the start.
- **Accountant/advisor portal.** Free access for accountants across all their clients, read and audit only, with recurring revenue share. This needs **cross-tenant access for one user** in the auth design from day one.
- **Self-serve sandbox.** Import a prospect's data into a trial tenant automatically.

---

## 9. Key risks

| Risk | Mitigation |
|---|---|
| Building accounting in-house delays launch | Strict MVP scope; build the posting engine and VAT before the screens; design partners go live on finance + stock first |
| Accountants loyal to Xero/Sage resist the switch | Free accountant portal, familiar reports and exports, revenue share; recruit 2–3 friendly accounting firms as design partners |
| A ledger bug destroys trust | Balanced-entry constraint in the database; property-based tests; nightly sub-ledger vs. control account and stock vs. ledger checks with alerts |
| Landed-cost accuracy erodes trust | Property-based tests on allocation; reconciliation report (stock valuation vs. stock account in the ledger) |
| HMRC recognition takes longer than planned | Start sandbox testing early in the build; fraud-header validation in CI |
| Scope creep into "everything ERP" | Phase gates tied to design-partner feedback; out-of-scope list in §2 |
| Performance of stock projections at volume | Projection tables + indexes; partition `stock_movements` by tenant hash if needed |
| Regulatory change (PVA, e-invoicing 2029) | Compliance rules isolated in `packages/domain/uk` with dated rule versions |

---

## 10. Next steps

1. **Recruit 3–5 design partners** (UK importers/wholesalers) plus 1–2 accounting firms, to validate Phase 1 scope, landed-cost workflows and the accountant experience.
2. **Scaffold the monorepo:** pnpm/Turborepo, Next.js, NestJS, Drizzle, Postgres with RLS, auth with MFA, CI with Testcontainers.
3. **Build `packages/domain` first:** Money, FX, VAT codes and the 9-box return, the double-entry posting engine, landed-cost allocation and weighted-average costing, all with tests.
4. **Build the ledger in the database:** append-only journal tables, balance constraint, periods, chart of accounts template, trial balance.
5. **Build the vertical slice:** PO → GRN → shipment with landed cost → supplier bill → sales invoice → payment → bank reconciliation → VAT return, checking the trial balance at each step.
6. Register with the HMRC Developer Hub and get the MTD VAT sandbox working with fraud-prevention headers.
7. Build the file importers (Xero and Sage exports first) and the onboarding wizard.
