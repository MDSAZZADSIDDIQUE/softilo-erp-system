# Softilo Construction & Trades — Edition Plan

**Status:** Draft v0.1, 26 Oct 2026. The first vertical slice is built in `verticals/construction/` (see §7).
**Builds on:** the Softilo core in `packages/domain`, `packages/db`, `apps/api` and `apps/web` (general ledger, VAT including the domestic reverse charge, purchase and sales ledgers, banking). The edition adds construction-specific modules alongside the core. It never forks the core.

Items marked **[unverified]** have not been checked against primary sources (legislation or HMRC guidance). They must be confirmed before the feature is relied on in production.

---

## 1. Target customers

| Segment | Size | Typical set-up today | What they need from us |
|---|---|---|---|
| **Main contractors** (small builders, fit-out, M&E, civils) | 10–150 staff, £2m–£40m turnover | Sage 50 or Xero, plus spreadsheets for valuations and CIS, sometimes a standalone CIS tool | Job costing, CIS deductions and returns, applications for payment, retention tracking, payment notices |
| **Subcontractors** (groundworks, brickwork, roofing, dryliners, electricians) | 5–60 staff | Xero or QuickBooks; CIS suffered tracked by hand | Applications to main contractors, CIS suffered offset against PAYE, retentions owed to them, reverse-charge invoicing |
| **Trades businesses** (plumbing and heating, electrical, maintenance) | 3–40 staff | Job-management apps (Tradify, ServiceM8, simPRO) plus Xero | Jobs and quotes, materials and labour costing, mix of domestic (end-user) and trade (reverse-charge) work |

Many businesses are both contractor and subcontractor: a groundworks firm is a sub to the main contractor and a contractor to its own labour-only gangs. The design treats both roles as first class.

## 2. Pain points

1. **CIS is done on the side.** Deductions are worked out in spreadsheets. The labour/materials split is guessed. The CIS300 is keyed into HMRC's portal by hand, and statements are typed up in Word. Errors mean penalties and angry subcontractors.
2. **Verification is forgotten.** Subcontractors are paid at the wrong rate because nobody verified them, or the verification wasn't kept.
3. **The reverse charge confuses everyone.** Since March 2021, deciding whether an invoice is reverse charge depends on the customer's CIS and VAT status and on end-user notices. Many firms get it wrong in both directions.
4. **Valuations live in Excel.** Cumulative applications, retention, previous certificates and variations are tracked outside the books, so the ledger and the commercial position drift apart.
5. **Retentions are lost.** Retention money (typically 3–5%) is never chased at practical completion or at the end of the defects period. The industry loses significant sums every year.
6. **Construction Act deadlines are missed.** Payment and pay-less notices are not served in time, so the notified sum becomes payable whatever the work is worth.
7. **No live job profitability.** Cost to date against budget and value is only known at month end, if then.

## 3. UK rules that apply

### 3.1 Construction Industry Scheme (CIS)

- **Registration and verification.** Contractors must verify each new subcontractor with HMRC before paying them. HMRC needs: for sole traders, the UTR and National Insurance number; for companies, the company name, UTR and registration number; for partnerships, the nominated partner, trading name and partnership UTR. Details must match what the subcontractor registered with, and temporary NI numbers cannot be verified. A subcontractor does not need re-verifying if they were included on one of your CIS returns in the current or previous two tax years. *(GOV.UK, "What you must do as a CIS contractor", checked 26 Oct 2026.)*
- **Deduction rates.** 0% for gross payment status, 20% for registered subcontractors, and 30% when HMRC cannot match the subcontractor. *(GOV.UK.)* At the 30% rate, HMRC returns a verification number that must appear on the return and statement. **[unverified: exact format of the verification number and its suffix letter]**
- **What the deduction is taken from.** Start from the gross invoice and exclude VAT and the amounts the subcontractor paid for materials, consumable stores, fuel (except for travelling), plant hire, and manufacturing or prefabricating materials. *(GOV.UK.)* HMRC's manual adds that where the subcontractor will not disclose materials costs, the contractor may make a reasonable estimate (CISR15060). In Softilo, labour is the only category liable to deduction; materials, plant and other direct costs are excluded.
- **Rounding.** GOV.UK and CISR15060 do not state a rounding rule. Softilo rounds the deduction **down** to the penny so a subcontractor is never over-deducted. **[unverified: confirm HMRC's expected rounding]**
- **Tax months and deadlines.** Tax months run from the 6th to the 5th. The monthly return (CIS300) must reach HMRC by the 19th following the end of the tax month. Deductions must be paid by the 22nd (the 19th if paying by post), and payment and deduction statements must reach subcontractors within 14 days of the end of the tax month. *(GOV.UK.)*
- **Nil returns.** If no subcontractors were paid, file a nil return or make an inactivity request (valid up to 6 months). *(GOV.UK.)* Secondary sources say that changes from 6 April 2026 reinstated mandatory nil returns with the penalty regime. **[unverified: exact nil-return deadline and penalties under the 2026 amendment regulations; sources conflict]**
- **2026 changes.** Secondary sources report that, from April 2026, HMRC can remove gross payment status immediately where a business knew or should have known of fraud, with a 5-year bar on reapplying, and that payments to local authorities and certain public bodies are exempt. **[unverified]**
- **Return contents.** Each subcontractor row has name, UTR, verification number (where the unmatched rate applied), total payments (excluding VAT), cost of materials and amount deducted. The contractor also declares that the subcontractors are not employees and that everyone requiring verification has been verified. **[unverified: whether HMRC's electronic CIS300 takes pounds and pence or whole pounds]**
- **Negative figures.** Commercial software must enter 0 in place of a negative figure. *(GOV.UK.)*
- **CIS suffered.** A limited-company subcontractor offsets CIS deducted from it against its own PAYE/NIC liability through the EPS (Employer Payment Summary), with HMRC refunding any excess at year end. Sole traders and partners claim it through Self Assessment. **[unverified: confirm EPS mechanics in detail before building Phase 2]**

### 3.2 VAT domestic reverse charge for construction services

- Applies to most construction services within CIS supplied between UK VAT-registered businesses, where the payment is reported under CIS, the supply is standard or reduced rated, and the customer has not confirmed in writing that they are an **end user** or **intermediary supplier**. *(GOV.UK VAT reverse charge technical guide, checked 26 Oct 2026.)*
- **End users** are businesses that are VAT and CIS registered but do not make onward supplies of those construction services (for example a developer's own office fit-out). **Intermediary suppliers** are connected parties, such as landlord and tenant, that pass the services on without material alteration. The supplier should not treat a customer as an end user without a written statement.
- **Zero-rated work** is outside the reverse charge. Standard-rated items within a zero-rated supply are also outside it.
- **5% disregard.** If reverse-charge elements are 5% or less of the whole supply value, they can be disregarded. This must be agreed by both parties at the start of the contract, on overall contract value, and not invoice by invoice. It does not apply where a single supply is predominantly zero rated.
- **Invoices** must say that the reverse charge applies and that the customer must account for the VAT (for example "VAT Act 1994 Section 55A applies"). They must state the VAT amount (or rate) but not include it in the amount charged.
- **VAT return.** The supplier enters only the net value (box 6). The customer adds the VAT to its output tax (box 1) and reclaims it as input tax (box 4), subject to normal rules. The core `RC20` code already does this.
- **Reduced rate (5%).** The reverse charge also applies to reduced-rate services. The core has no `RC5` code yet, so Softilo refuses the combination for now (see §6).
- **Excluded services** supplied on their own include professional services (architects, surveyors), the manufacture or delivery of materials, installing security systems, seating, blinds and shutters, and artistic works. A per-line "construction services" flag is planned (§6).
- **Not VAT registered.** Bills from subcontractors who are not VAT registered default to `OS` (no VAT). **[unverified: whether such purchases belong in box 7; HMRC says box 7 covers all purchases excluding VAT. Revisit with an accountant]**

### 3.3 Construction Act: payment, notices and retentions

- The Housing Grants, Construction and Regeneration Act 1996, as amended by the Local Democracy, Economic Development and Construction Act 2009 (effective 1 Oct 2011 in England and Wales), requires interim payments for longer contracts, a due date and a final date for payment, payment notices, and pay-less notices. It also outlaws pay-when-paid clauses except on insolvency.
- **Scheme for Construction Contracts defaults** (when the contract is silent or non-compliant): payment becomes due on the later of 7 days after the end of the relevant period or the date of the claim; the final date for payment is 17 days after the due date. *(Designing Buildings and other secondary sources.)* The payer's payment notice is due within 5 days of the due date. The pay-less notice deadline is given as 7 days before the final date in most sources, but a 2026 TCC case summary says 5 days. **[unverified: confirm the Scheme's pay-less period against legislation.gov.uk]** Softilo stores all four periods per project, with the Scheme values as defaults, so contract terms (for example JCT: due on the valuation date, final date 14 days later) can be entered.
- **A late-invoice clause** that moves the final date for payment is non-compliant (Deerns UK v VDC LHR11, TCC 2026, as reported). The final date must run from the due date. Softilo always calculates it that way.
- **Default payment notice.** If the payer serves no payment notice, the payee's application stands as the notified sum. Softilo's application is that document.
- **Retentions.** These are contractual, not statutory. The usual JCT pattern is 3–5% retention, half released at practical completion and the rest at the end of the rectification (defects) period, typically 12 months. VAT on retention is accounted for when the retention is invoiced or paid, which is its tax point. **[unverified: confirm the HMRC tax-point treatment of retentions in VAT Notice 708]**

## 4. Module design on top of the shared core

```
verticals/construction/
  domain/   @softilo/construction-domain   Pure rules: CIS, tax months, CIS300, reverse charge, valuations,
                                           payment timetable, job-cost summary. Reuses @softilo/domain posting rules.
  api/      @softilo/construction-api      Fastify routes registered on the core server; cons_* migrations;
                                           HMRC CIS gateway (stub); seed; end-to-end test.
  web/      @softilo/construction-web      Next.js app with its own navigation, reusing the core styles and components.
  docs/     this plan
```

**Principles**

- **The core ledger stays the system of record.** A job bill *is* a core `supplier_bills` row, and an application *is* a core `sales_invoices` row. Payments, aged creditors and debtors, bank reconciliation and the VAT return therefore work unchanged. The edition adds a `cons_*` extension row that carries the construction meaning.
- **Every posting goes through domain rules.** `postJobBill` runs the core `postSupplierBill`, then moves the deduction from creditors to CIS liability, and re-runs `finalise` so the journal must balance. `postApplication` does the same on top of `postSalesInvoice` for retention.
- **Construction accounts** are added to a tenant's chart idempotently on the first construction write: 1105 Retentions receivable (control), 1106 CIS deductions suffered, 2211 CIS deductions payable, and job cost accounts 5300–5330. Roles are prefixed `cons_`.
- **Integrity checks.** Each sub-ledger is reconciled to its control account: retentions (sum of retention movements equals account 1105) and CIS (sum of deductions equals account 2211, until HMRC payments are recorded).
- **HMRC behind an adapter.** `CisGateway` exposes `verify` and `submitReturn`. Only `StubCisGateway` exists, and it answers deterministically from the UTR's last digit. The live adapter (HMRC Transaction Engine / CIS online) goes in later without touching routes.

**Modules**

| Module | Phase | Description |
|---|---|---|
| Projects / jobs | 1 ✅ | Code, customer, contract sum, retention rate, VAT context (rate, customer CIS status, end-user notice, 5% disregard), payment periods |
| Budgets & job costing | 1 ✅ | Budget by category (labour, materials, plant, other). Append-only cost ledger written in the same transaction as the journal. Budget vs actual, margin to date |
| Variations | 1 ✅ (basic) | Numbered variations, approve or reject; approved variations raise contract value |
| CIS subcontractors | 1 ✅ | UTR, business type, NINO or company number; verification history kept as evidence |
| Job bills with CIS | 1 ✅ | Labour/materials/plant split, deduction on labour only, reverse charge defaulted, balanced journal to CIS liability |
| CIS300 & statements | 1 ✅ | Built from payments, not bills. Part payments are reported pro rata in the month paid. Nil detection. Submission via adapter, stored with receipt |
| Applications for payment | 1 ✅ | Cumulative valuation, retention, previous applications, reverse-charge decision, Scheme timetable, printable tax invoice |
| Retention release | 1 ✅ (via stages) | Practical completion halves retention and the final account releases the rest. Phase 2 adds dated release reminders |
| Payment & pay-less notices (as payer) | 2 | Generate notices for subcontractor applications; deadline alerts |
| Subcontractor applications & retention held on subs | 2 | Mirror of customer applications, with retention payable (2106) |
| HMRC CIS payment & CIS liability clearing | 2 | Record payments to HMRC against 2211; reconcile to returns |
| CIS suffered (we are the sub) | 2 | Deduction on customer receipts to 1106; EPS offset report; statements received |
| Live HMRC CIS adapter | 2 | Verification and CIS300 over HMRC's online service; needs HMRC credentials and recognition |
| Quotes, estimates & tenders | 3 | Bill of quantities import, quote → project budget |
| Timesheets & labour costing | 3 | Own-labour cost to jobs from payroll (core Phase 4) |
| Plant & small tools | 3 | Internal plant hire charged to jobs |
| Trades job management | 3 | Short jobs, mobile job sheets, materials from van stock (core inventory) |
| Cost-value reconciliation (CVR) | 3 | Monthly CVR with accruals and forecast final account |

## 5. Phased roadmap

**Phase 1: contractor core (this slice, then hardening). About 3 months.**
Projects, budgets, job costing, variations, CIS subcontractors with stub verification, job bills with CIS, CIS300 preview and stub submission, statements, and applications with retention and the reverse charge. The remaining hardening: edit and close projects, credit notes on job bills (negative CIS shown as 0 on returns), statement PDFs and emailing, settings UI, and the core sales/purchase screens reachable from the edition's navigation.

**Phase 2: compliance complete. About 3–4 months.**
Live HMRC CIS adapter (verification and CIS300) after HMRC recognition; HMRC payment recording; CIS suffered and the EPS offset report; payment and pay-less notices both ways; subcontractor applications and retention payable; retention release reminders at PC and end of defects; `RC5` in the core VAT table; a per-line construction-services flag for the reverse charge.

**Phase 3: commercial management. About 4–6 months.**
Quotes and tenders, CVR and forecasting, timesheets and labour costing (with core payroll), plant, and trades job management with a mobile PWA.

## 6. Known gaps and open questions

- **Reduced-rate reverse charge (`RC5`)** needs a core VAT code. Until then the edition refuses it rather than mis-posting.
- **Supplier credit notes on CIS bills** are not built. The CIS300 must show 0 for negative figures.
- **Non-VAT-registered subcontractors** default to `OS`. Box 7 treatment needs confirming with an accountant (§3.2).
- **Job bills are GBP only.** Foreign-currency subcontractors are out of scope.
- **The CIS deduction is computed at bill time** and reported at payment time. If a subcontractor's status changes between bill and payment, the bill keeps the old rate. Phase 2 should recalculate at payment.
- **Unverified items** are marked through §3. Each needs a primary-source check before go-live.

## 7. What the first slice contains

- `domain/src/cis.ts`: rates, deduction on labour (rounded down), `postJobBill`, and `cisPaymentShare` (cumulative pro rata).
- `domain/src/cis-return.ts`: `buildCis300` produces statements and return totals from payments.
- `domain/src/dates.ts`: CIS tax months and deadlines.
- `domain/src/reverse-charge.ts`: `constructionSalesVat` (conditions, end user, zero rate, 5% disregard) and `purchaseVatDefault`.
- `domain/src/applications.ts`: `valueApplication`, staged retention, `postApplication`, and `paymentTimetable` (Scheme defaults).
- `domain/src/job-costing.ts`: budget vs actual and margins.
- `api/migrations/cons_001_construction.sql`: 10 tenant tables, all with forced RLS. Cost entries, verifications, job bills, applications and returns are append-only.
- `api/src/module.ts`: routes under `/api/construction/*`.
- `api/src/hmrc/cis-gateway.ts`: the adapter interface and the stub.
- `api/src/e2e.test.ts`: the full flow over HTTP with books checked at each step. `api/src/seed.ts` loads demo data.
- `web/`: dashboard, projects (list, new, detail with budget/applications/variations/bills), subcontractors with verification, job bill entry with live CIS preview, CIS returns with printable statements, and applications with a printable reverse-charge-aware invoice.

Run the edition locally:

```bash
pnpm --filter @softilo/construction-api seed
```

```bash
pnpm --filter @softilo/construction-api dev
```

```bash
pnpm --filter @softilo/construction-web dev
```

Then open http://localhost:3010 and sign in with the demo login from `api/src/seed.ts`.
