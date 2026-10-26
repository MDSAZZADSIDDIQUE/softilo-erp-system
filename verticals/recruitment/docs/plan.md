# Softilo Recruitment — Edition Plan

**For:** UK temporary and contract staffing agencies, and permanent-placement recruiters, with 5–150 internal staff.
**Built on:** the Softilo core (`packages/domain`, `packages/db`, `apps/api`, `apps/web`). Same ledger, VAT, sales ledger, banking and reports; the edition adds the staffing workflow on top.
**Status:** Draft v0.1, 26 Oct 2026. The first slice (Phase R1 below) is built in `verticals/recruitment/`.

> **Regulatory caveat.** The rules below were checked against secondary sources in October 2026 (law firm, trade-body and accountancy summaries), not the legislation itself. Items marked **[verify]** must be confirmed against legislation.gov.uk, GOV.UK or HMRC guidance before the feature that depends on them ships. Rates and thresholds change every April; they live in dated tables in `verticals/recruitment/domain`, never in screens.

---

## 1. Who it is for

| Segment | What they do | Size of the problem |
|---|---|---|
| **Temporary staffing agencies** (industrial, driving, warehouse, care, hospitality, education) | Supply workers by the hour/shift. Usually the employer for PAYE temps, or use umbrella companies. Weekly payroll and weekly client billing. | Volume: hundreds of timesheets a week, thin margins (often 10–20%), payroll on a fixed weekly cycle. |
| **Contract recruiters** (IT, engineering, finance, interim) | Place limited-company and umbrella contractors on day rates, often for 3–12 month assignments. | Off-payroll (IR35) status and the fee-payer chain; supplier invoices from contractors' companies or umbrellas; self-billing. |
| **Permanent-placement recruiters** | Charge a fee (typically 15–25% of first-year salary) on placement, with a rebate if the candidate leaves early. | Fee tracking, rebates/credit notes, consultant commission. Most agencies do some perm alongside temp/contract. |

**Who we are not targeting first:** large enterprise staffing groups (Bullhorn + Access/Sage 200 estates), MSPs/vendor-neutral managed services, and agencies needing a full ATS/CRM (candidate sourcing, job boards, CV parsing). Softilo integrates with an ATS later; it does not replace one in year one.

## 2. Pain points today

1. **Three or four systems glued with spreadsheets:** an ATS/CRM (Bullhorn, Vincere, Firefish), a timesheet portal, a payroll bureau or payroll package, and Xero/Sage. Hours are rekeyed between them every week.
2. **Margin is invisible until month end.** Pay, holiday accrual, employer NI, pension and the apprenticeship levy are known only after payroll; agencies don't see margin per placement, client or consultant in real time.
3. **Compliance lives in people's heads:** KIDs, AWR week-12 dates, IR35 status determinations, umbrella due diligence, opt-outs, right-to-work checks. Each one carries fines or tax liability.
4. **Funding and cash:** agencies pay workers weekly but clients pay in 30–60 days. Many rely on invoice finance and need clean, timely invoicing and aged-debt data.
5. **Umbrella risk since April 2026:** the agency is now jointly and severally liable for PAYE an umbrella company fails to pay, so umbrella choice and evidence matter financially, not just reputationally.

## 3. UK rules that apply

| Rule | What it requires | How Softilo handles it | Phase |
|---|---|---|---|
| **Conduct of Employment Agencies and Employment Businesses Regulations 2003** | Agreed terms with work-seekers before finding them work; terms with hirers; no fees to work-seekers (with narrow exceptions); pay workers even if the client doesn't pay; record-keeping (1 year). Limited-company contractors can **opt out** before introduction (not for some roles) **[verify exact exclusions]**. | Worker record holds engagement type and Conduct Regs opt-out (ltd only, enforced by a DB check). Terms-agreed date on clients. Worker pay accrues on approval, independent of client payment. | R1 (partial), R2 (document store, terms versioning) |
| **Key Information Document (KID)** | Since 6 April 2020, agencies must give work-seekers a KID (pay rate, deductions, who pays them, example pay calculation) before agreeing terms. | Placement creation is **blocked** for PAYE/umbrella workers without a KID issued on or before the start date. | R1 (date check); R2 (generate the KID with the example payslip) |
| **Agency Workers Regulations 2010 (SI 2010/93)** | After **12 qualifying weeks** in the same role with the same hirer, equal treatment on basic pay and conditions (pay, holiday, hours) with comparable direct recruits; day-one rights to shared facilities and vacancies. | AWR tracker per placement (see §5.6). The Swedish derogation was abolished from 6 April 2020, so there is no opt-out by "pay between assignments" contracts. | R1 (tracker); R3 (comparator pay rates, automatic rate uplift at week 13) |
| **AWR breaks** | A week counts if any work is done. Breaks **pause** the clock if: not more than **6 calendar weeks** for any reason; up to **28 weeks** for sickness/injury or jury service; annual leave; hirer shutdown; strike/lock-out. Pregnancy, childbirth and maternity (up to 26 weeks after birth) and maternity/paternity/adoption leave **count as if worked**. Longer breaks reset. **[verify boundary: "not more than 6 weeks" vs "6 weeks or more"]** | Implemented in `assessAwr` with tests for each rule. | R1 |
| **Off-payroll working (IR35), ITEPA 2003 Part 2 Ch. 10** | Since April 2021 (private sector), a **medium or large** end client must issue a **Status Determination Statement (SDS)**; if inside IR35, the **fee-payer** (usually the agency paying the PSC) deducts PAYE income tax and employee NIC from the deemed direct payment, and pays employer NIC (and levy). **Small** clients: the PSC decides. Small-company thresholds were raised for accounting periods from 6 April 2025 (turnover £15m, balance sheet £7.5m, 50 employees) **[verify effective tax year for off-payroll]**. Since April 2024 HMRC can set off tax already paid by the worker/PSC against fee-payer liabilities. | Workers record IR35 status; clients record size; placements for ltd contractors with medium/large clients are **blocked without an SDS date**. Inside-IR35 placements warn that fee-payer deductions are not built yet. | R1 (status + SDS gate); R4 (deemed-payment payroll) |
| **Umbrella companies — joint and several liability (Finance Act 2026)** | For payments to umbrella workers on or after **6 April 2026**, the agency (or the end client where there is no agency) is jointly and severally liable for PAYE/NIC the umbrella fails to pay. The umbrella stays the PAYE employer. Commentators report no "reasonable steps" defence **[verify]**. | Umbrella name on worker record (R1). R2: umbrella register with due-diligence evidence (accreditation, payslip sampling, RTI checks via worker consent), and a liability exposure report (umbrella invoices × estimated PAYE). | R1/R2 |
| **Umbrella regulation (Employment Rights Act 2025)** | Brings umbrella companies within the Employment Agencies Act 1973 regime; enforcement by the **Fair Work Agency** (launched April 2026). Commentators expect umbrella regulation to apply from **April 2027** **[verify; secondary legislation pending]**. | Track in the rules roadmap; R2 umbrella register is the foundation. | R2+ |
| **Holiday pay for irregular-hours and part-year workers** | For leave years from 1 April 2024, holiday entitlement accrues at 12.07% of hours worked, and **rolled-up holiday pay** at 12.07% of pay is lawful for these workers, shown separately on the payslip. | Placement `holiday_rate` (default 12.07% for PAYE, 0% for umbrella/ltd where the rate already includes it); accrued per approved timesheet into a holiday-pay accrual account. | R1 (accrual); R4 (payslip line, taken vs. rolled-up policy) |
| **Employment intermediaries reporting** | Agencies that place workers **without operating PAYE** on their pay (e.g. ltd contractors outside IR35, umbrella workers, self-employed) must file a quarterly report to HMRC (worker details, payments, reason PAYE not operated). Deadlines reported as the 5th of the month after each quarter (5 Aug, 5 Nov, 5 Feb, 5 May) with penalties up to £1,000 **[verify dates and penalty scale on GOV.UK]**. | Data model already holds what's needed (engagement, company, payments by worker). R2 builds the CSV in HMRC's template. | R2 |
| **PAYE / RTI for agency-employed temps** | FPS on or before each payday; EPS monthly; NI (employer **15%** above the **£5,000** secondary threshold from April 2025); employment allowance; apprenticeship levy (0.5% over £3m pay bill); student loans; statutory pay (SSP, SMP etc.); P45/P60/P11D. | **Out of scope for R1.** Worker pay is accrued as a cost (gross pay + holiday + an on-cost estimate %) to control accounts. | R4 (in-house PAYE engine, HMRC RTI recognition) |
| **Pension auto-enrolment** | Assess every pay period: eligible jobholders (age 22–State Pension age, earnings over **£10,000/year** trigger) are enrolled; minimum contributions 8% of qualifying earnings (employer ≥3%) between **£6,240 and £50,270** (2025/26 band) **[verify 2026/27 band]**; postponement up to 3 months is allowed and common for temps. | On-cost estimate % in R1. R4: assessment, postponement notices, provider files (NEST, The People's Pension, Smart). | R4 |
| **National Minimum/Living Wage** | NLW (21+) £12.21 from April 2025; £12.71 from April 2026 **[verify]**. Rolled-up holiday pay doesn't count towards NMW. | Dated table in the domain; PAYE pay rates below the NLW raise a warning on the placement. Age bands need date of birth (R2). | R1 (warning) |
| **VAT on supplies of staff** | Standard-rated (20%) on the full charge, including the worker's pay element. Reverse charge does not apply to staffing. | Client invoices default to S20; client VAT code is configurable (e.g. zero for exports of services). | R1 |
| **Right to work, GDPR** | Right-to-work checks before work starts (civil penalties per illegal worker); worker data is personal data; NI numbers and bank details are sensitive. | R1 stores no NI numbers or bank details. R2: right-to-work evidence with expiry alerts; field-level encryption (KMS) before bank details are stored. | R2 |

## 4. Module design on top of the shared core

```
core contacts (customer) ── rec_clients (off-payroll size, VAT code, terms date)
rec_consultants
rec_workers (engagement: paye | umbrella | ltd; umbrella / company; IR35 status; KID date; opt-out)
rec_placements ── rec_placement_rates (rate type, pay rate, charge rate)
   │             └─ rec_absences (AWR breaks)
   └─ rec_timesheets ── rec_timesheet_lines (date, rate type, hours)
                    └─ rec_timesheet_rates (frozen at approval)
         │ approve → core journal_entries (worker pay accrual)
         │ invoice → core sales_invoices + lines (VAT, debtors, payments, VAT return)
```

**Principles**

- **Reuse the core ledger, never fork it.** Client invoices *are* core sales invoices, so receipts, credit notes, aged debtors, bank reconciliation and the VAT return work unchanged. Worker pay posts through the core `postJournal` with a domain posting rule that is checked to balance.
- **Recruitment accounts are added per tenant on first use** (`INSERT … ON CONFLICT DO NOTHING`): 4010 Temporary staffing fees, 4020 Permanent placement fees, 5010 Temporary worker pay, 5015 Holiday pay, 5020 Employer on-costs, and control accounts 2120 Worker pay accrued and 2125 Holiday pay accrued (manual journals can't touch them).
- **Approved means frozen.** Database triggers stop any change to an approved timesheet's hours, rates or amounts; the only allowed change is approved → invoiced.
- **Every new table has tenant RLS** (enabled and forced), the same policy as the core.

### 4.1 Candidates and workers
R1 holds the *worker* (someone being placed): name, contact, engagement, umbrella/company, IR35 status, KID date, opt-out. R2 adds the candidate pipeline only as far as finance needs it (right to work, date of birth for NMW age bands, bank details encrypted, pension status). Full ATS features stay out; we import from Bullhorn/Vincere CSV exports.

### 4.2 Clients
A core customer contact plus recruitment terms: off-payroll size (small vs. medium/large), invoice VAT code, terms-of-business date, payment terms. R2: client contacts as timesheet approvers, PO numbers on invoices, invoice grouping (per worker / per week / per cost centre), self-billing agreements.

### 4.3 Placements and rate cards
Client × worker × role × dates, consultant, and a rate card of named rate types (standard, overtime, weekend, day…) each with pay and charge. Placement checks (`checkPlacement`): KID gate, SDS gate, IR35 status for ltd, duplicate rate types, negative spread warning, NLW warning. Holiday and on-cost rates default by engagement. R3: rate changes with effective dates, AWR comparator rates, mark-up % pricing, charge rate calculators.

### 4.4 Timesheets
Weekly, one per placement per week ending. Draft → submitted → approved (by a named client approver) or rejected (with reason, then corrected and resubmitted) → invoiced. Validation: dates within the week and placement, known rate types, positive hours with ≤2 dp, ≤24 hours per day. Pricing totals hours **per rate type** before multiplying, so invoice lines equal the approved charge to the penny. R2: client self-service approval portal (magic link), worker self-entry, expenses, bulk CSV import, clock-in integrations.

### 4.5 Client invoicing
From approved, uninvoiced timesheets per client: one core sales invoice with a line per timesheet and rate type (hours × charge rate), VAT per line, due date from client terms. R2: credit/re-bill corrections, consolidated weekly invoices, invoice-finance export, e-invoicing.

### 4.6 AWR tracker
`assessAwr` takes the clock start, every day worked (from timesheets across all placements with the same worker, hirer, role and AWR start), and absences; returns weeks completed, status (accruing / paused / reset / qualified), the qualifying date (first day of week 13) and a projected date if work continues. The dashboard flags placements qualifying within 4 weeks.

### 4.7 Worker pay (cost accrual in R1)
On approval: Dr 5010 pay, Dr 5015 holiday, Dr 5020 on-costs / Cr 2120 pay + on-costs, Cr 2125 holiday. An integrity check proves accrual accounts = approved timesheet costs. **R2** settles accruals from umbrella and ltd-company invoices (purchase ledger; self-billing with VAT). **R4** replaces the on-cost estimate with real payroll: net pay, PAYE/NI, pension and student loan to their liability accounts.

### 4.8 Margin reporting
Gross margin = charge − (pay + holiday + on-costs), from approved/invoiced timesheets, by placement, client or consultant, with margin % and margin per hour. R3: consultant commission rules, targets/league tables, perm vs. temp split, net margin after funding costs.

### 4.9 Permanent placements, fees and rebates
Domain functions exist (`permFee`, `permRebate` with a sliding scale). R2 adds perm placements: fee invoice to 4020 on start date, rebate as a credit note against it if the candidate leaves within the rebate period, guarantee/replacement option, split fees between consultants.

## 5. Phased roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **R1 — Temp billing core (built)** | Clients, consultants, workers (PAYE/umbrella/ltd + IR35), placements with rate cards and compliance gates, weekly timesheets with approval, client invoices with VAT via the core sales ledger, worker pay accrual journals, AWR tracker, margin by placement/client/consultant, web screens, end-to-end test. | A 10-desk agency can bill clients weekly and see margin daily, with books that balance. |
| **R2 — Supply chain and compliance (≈3 months)** | Umbrella register and due-diligence evidence; supplier invoices and **self-billing** for umbrella/ltd contractors (VAT, reverse of accruals); intermediaries quarterly report; KID generator; right-to-work evidence; perm placements and rebates; client approval portal; Bullhorn/Vincere CSV import. | Contract agencies run end-to-end; quarterly report produced from data. |
| **R3 — Pricing and performance (≈2 months)** | Effective-dated rates, AWR comparator rates with week-13 uplift, consultant commission, margin dashboards, invoice-finance exports, expenses. | AWR uplift applied automatically; commission statements produced. |
| **R4 — PAYE payroll for temps (≈6–9 months; regulated)** | Weekly payroll engine: PAYE, NI (incl. fee-payer deemed payments for inside-IR35), student loans, statutory pay, holiday pay (rolled-up and accrued), pension auto-enrolment with postponement, payslips, **RTI FPS/EPS** with HMRC recognition, P45/P60, BACS file. Clears the R1 accrual accounts. | HMRC RTI recognition; parallel run with a bureau for one quarter. |

## 6. Risks

| Risk | Mitigation |
|---|---|
| AWR edge cases (overlapping breaks, role changes) mis-stated | Tested domain function, absence reasons recorded, explicit "reset" when the role changes; legal review of `assessAwr` before marketing it as compliance-grade. |
| Payroll is heavily regulated and changes each April | Keep R1–R3 payroll-free (accrual only); R4 needs a dedicated rules owner, dated rule tables and HMRC recognition. |
| Umbrella liability exposure | R2 umbrella register and exposure report; this is a selling point, so ship it early. |
| Rule details reported by secondary sources only | **[verify]** items above are tracked; each must be checked against primary sources before its feature ships. |

## 7. Sources consulted (Oct 2026)

- Umbrella joint and several liability from 6 April 2026: Deloitte Taxscape, REC, FCSA, Lewis Silkin (Apr 2026), RSM.
- AWR qualifying period and breaks: Lewis Silkin, XpertHR, HRGO Temporary Workers Handbook.
- Intermediaries reporting: Lewis Silkin, Ross Martin, Goforma 2026/27 guide.
- Employment Rights Act 2025 and umbrella regulation / Fair Work Agency: Greenberg Traurig (Jan 2026), FCSA.
- Holiday pay (12.07% rolled-up from April 2024), KID (April 2020), Swedish derogation repeal, employer NI 15% / £5,000 threshold (April 2025), NLW: from prior knowledge, **[verify]** against GOV.UK.
