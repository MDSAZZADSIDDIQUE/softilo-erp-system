# Softilo for Law Firms — Plan

**Edition:** Law Firms (`verticals/law-firms/`)
**Builds on:** the Softilo shared core (`packages/domain`, `packages/db`, `apps/api`, `apps/web`) at commit `b781fcb`.
**Status:** Draft v0.1, 26 Oct 2026. The first vertical slice is built (see §7).

Regulatory statements are checked against the SRA's published Accounts Rules unless marked **[unverified]**. Anything marked that way must be confirmed with the regulator's own text, or by a solicitors' accountant, before the product relies on it.

---

## 1. Target customers

**Primary:** small and mid-sized law firms in **England & Wales** regulated by the Solicitors Regulation Authority (SRA): 2 to 80 fee earners, one to five offices, usually a high-street or regional practice.

| Segment | Typical work | What drives their accounts |
|---|---|---|
| High-street general practice (2–15 fee earners) | Conveyancing, wills and probate, family, small litigation | Heavy client-account traffic: completion monies, estate funds, money on account |
| Conveyancing-led firms | Residential sales and purchases | Large volumes of short-lived client money, SDLT payments, high cyber-fraud exposure |
| Private client / probate | Estates and trusts | Long-held balances, interest on client money, residual balances |
| Regional commercial firms (20–80 fee earners) | Corporate, commercial property, employment, dispute resolution | Time recording, WIP, fee targets, partner profitability, disbursements |
| Legal-aid practices | Crime, family, housing | Legal Aid Agency (LAA) billing and payments. **Later phase** (see §6) |

**Out of scope at first:** barristers' chambers (different regulator and no client account), Alternative Business Structures with complex group structures, and in-house legal teams.

**Who buys:** the managing partner. **Who decides:** the cashier or practice manager and the **COFA** (Compliance Officer for Finance and Administration). **Who must be won over:** the firm's reporting accountant, who signs the annual accountant's report.

### 1.1 Scotland and Northern Ireland

These firms have different regulators and rules. Softilo's client-money engine (separate client ledgers, no overdrawn ledgers, reconciliations) applies to all three jurisdictions, but the parameters and reports differ. The first release targets England & Wales only.

| | England & Wales | Scotland | Northern Ireland |
|---|---|---|---|
| Regulator | SRA | Law Society of Scotland | Law Society of Northern Ireland |
| Client-money rules | SRA Accounts Rules 2019 | Practice Rules 2011, Rule B6 (accounts, accounts certificates, Guarantee Fund), amended from 4 Jan 2023 | Solicitors' Accounts Regulations 2014 |
| Reconciliation frequency | At least every five weeks (rule 8.3) | Client account balancing at least monthly under B6.7 **[unverified: confirm frequency and wording]** | **[unverified]**: confirm in the 2014 Regulations |
| Compliance reporting | Annual accountant's report, obtained within six months of the period end (rule 12.1) | Accounts certificates submitted to the Society, usually twice a year **[unverified: confirm frequency]** | Annual accountant's report to the Law Society of NI **[unverified]** |
| VAT | UK VAT; same disbursement rules | UK VAT; same disbursement rules | UK VAT; NI also has goods rules under the Windsor Framework, rarely relevant to legal services |

**Design consequence:** the jurisdiction is a tenant setting. The reconciliation interval, report templates and terminology ("fee note" in Scotland versus "bill" in England, "outlays" versus "disbursements") come from a jurisdiction profile, never from hard-coded rules.

---

## 2. Pain points

1. **Client-money compliance is manual and scary.** Cashiers reconcile in spreadsheets. A breach (overdrawn client ledger, late reconciliation, a missing sign-off) is a regulatory matter for the COFA, not just a bookkeeping error.
2. **Two ledgers per matter, kept in different places.** Practice-management systems hold matters and time, while the accounts sit in Xero or Sage with no per-matter client ledger. Cashiers re-key every receipt, payment and transfer.
3. **Three-way reconciliation takes days.** Bank statement, client cash book and the sum of client ledgers must agree. With separate systems they never agree on the first attempt.
4. **Billing leaks money.** Time is recorded late or not at all. Fee notes are typed in Word. Transfers from client to office for billed costs are forgotten, which leaves "office money in client account" (itself a breach).
5. **VAT mistakes on disbursements.** Firms often treat recharged costs (couriers, electronic searches, copying) as VAT-free disbursements when HMRC treats them as part of the firm's own supply.
6. **Residual balances and interest.** Small balances sit on dormant matters for years. Interest owed to clients is calculated by hand, if at all.
7. **Cost of the incumbents.** Legal practice-management systems are expensive, old and slow to change. Small firms often run a legal cashiering product beside a generic accounting package.

---

## 3. Rules that apply

### 3.1 SRA Accounts Rules 2019 (England & Wales)

Checked against the SRA's published rules ([sra.org.uk](https://www.sra.org.uk/solicitors/standards-regulations/accounts-rules/)), 26 Oct 2026.

| Rule | Requirement | How Softilo enforces it |
|---|---|---|
| 2.1, 2.3 | Client money is kept separate from the firm's money and paid **promptly** into a client account (exceptions include some LAA payments and written alternative arrangements). | Client bank and office bank are separate ledger accounts. A client receipt can only post to the client bank account and must name a matter. |
| 2.5 | Client money is **returned promptly** once there is no longer a proper reason to hold it. | **Phase 2:** a residual and dormant balance report (balances with no movement for N days, or on closed matters), with a prompt on matter closure. |
| 3.3 | A client account must not be used to provide **banking facilities**. Payments in and out must relate to the regulated services. | Can't be fully automated. Every payment out needs a matter, payee and reason. **Phase 2:** flags for round-sum receipts with no related transaction, and payments to third parties not linked to the matter. |
| 4.3 | Fees may be taken from client money only once a **bill or written notification of costs** has been given, and only for the sum stated. | A client-to-office transfer must cite a fee note and cannot exceed what is outstanding on it, or the matter's client balance. |
| 5.1, 5.3 | Withdraw client money only for its purpose or on instruction, and only if **sufficient funds are held for that client**. | **No client ledger may go below zero.** The API refuses the payment and a database trigger rejects it as a backstop. |
| 5.2 | Withdrawals are appropriately authorised and supervised. | **Phase 2:** two-person approval for client payments above a firm-set limit, with roles for cashier, fee earner and partner. |
| 6.1 | Breaches are corrected promptly, and any shortfall is replaced immediately. | The reconciliation report lists differences. **Phase 2:** a breach register with corrective entries. |
| 7.1 | Account for a **fair sum of interest** on client money (no fixed rate; the firm's written policy applies). | **Phase 2:** an interest policy per firm (rate source, de minimis, method) and an interest calculation run that posts office → client. |
| 8.1 | Accurate, contemporaneous, chronological records: client ledgers, a list of client balances, and a client cash book. | The append-only matter ledger and the shared general ledger, written in the same transaction. |
| 8.2, 8.3 | Obtain statements and reconcile all client accounts **at least every five weeks**. Reconciliations are **signed off by the COFA or a manager**. Differences are investigated promptly. | Three-way reconciliation report (bank statement vs. client cash book vs. sum of client matter ledgers), saved with preparer and sign-off. The next due date is the last reconciliation plus 35 days. |
| 12.1 | Obtain an **accountant's report** within **six months** of the end of each accounting period. Deliver it to the SRA only if it is qualified. | **Phase 3:** an accountant's pack (reconciliations, ledgers, exception reports) and read-only reporting-accountant access via the core accountant portal. |
| 12.2 | No report is needed if all client money is from the LAA, or the client-account balance is no more than an **average of £10,000** and a **maximum of £250,000**. | **Phase 3:** an exemption check from the ledger history. |

**Pending change:** the SRA consulted in 2024 and again to 20 Feb 2026 on its accountants' report regime and on stronger compliance-officer checks. A June 2026 trade-press report says it has submitted changes to the Legal Services Board, including filing every accountant's report (clean or not) plus an annual declaration, possibly in force in early 2027. **[unverified: LSB approval and commencement date not confirmed]** The design keeps the reporting interval and filing requirements configurable.

### 3.2 VAT: disbursements versus recharges

- A **disbursement** is a cost paid to a third party as the client's agent. It is passed on at the exact amount, outside the scope of VAT (Softilo code `OS`), and itemised separately on the bill. HMRC VAT Notice 700 section 25 sets out the conditions. Commentary counts between six and eight of them, so **[unverified: confirm the exact current list on GOV.UK]**. In outline: the firm acted as the client's agent, the client received and used the service and was responsible for paying it, the client authorised the payment, the client knew the supplier, the cost is separately itemised, and the exact amount is recovered.
- A **recharge** is a cost the firm incurred as principal in making its own supply (couriers, copying, travel, and electronic searches since *Brabners LLP v HMRC* [2017] UKFTT 666 (TC)). It is part of the firm's fee and is standard-rated (`S20`) on the bill.
- HMRC withdrew its postal-search concession from 1 Dec 2020 (reported in trade press; **[unverified on GOV.UK]**).
- **Design:** every cost type carries a default treatment (disbursement or recharge). A disbursement paid from **client** money never appears on the firm's VAT return. A disbursement paid from **office** money is an amount the client owes the firm (Dr disbursements recoverable) and is billed at `OS`. A recharge is billed as fee income with VAT.
- **Tax point:** solicitors usually invoice at the end of a matter. The tax point for services is generally the earlier of the invoice or payment. Money received on account into **client** account is not a payment to the firm until it is transferred to office against a bill. **[unverified: confirm against HMRC guidance on money held in client account]**

### 3.3 Other rules that shape the design (later phases)

- **Anti-money laundering:** client due diligence before money is accepted under the Money Laundering Regulations 2017. **Phase 2:** CDD status on each client, with a block on client receipts until it is complete (configurable).
- **SRA Transparency Rules:** price publishing for some services. This is out of scope for accounting.
- **Legal Aid Agency:** civil and crime billing, controlled-work claims and LAA payments into office account. **Phase 4.**

---

## 4. Module design on the shared core

### 4.1 Principles

- **One ledger.** Law-firm postings use the core double-entry ledger (`journal_entries` / `journal_lines`), the balanced-entry trigger, the lock date and the audit log. There is no separate cashiering database.
- **The matter ledger is a sub-ledger,** like debtors and creditors. Each matter has two running balances: **client** (money held for the client) and **office** (money the client owes the firm). Every matter-ledger row is written in the **same transaction** as the journal that moves the GL, so the two cannot drift. The reconciliation report also checks this.
- **Pure rules in `@softilo-law/domain`:** time valuation, VAT on fee notes, client-money guards and reconciliation arithmetic, all with no I/O and with tests.
- **Vertical tables are prefixed `law_`,** all with tenant RLS, and live in `verticals/law-firms/api/migrations/`. They are applied after the core migrations.

### 4.2 Chart of accounts additions

Added to a tenant the first time a law-firms route is used. This is idempotent.

| Code | Name | Type | Role | Notes |
|---|---|---|---|---|
| 1250 | Client bank account | asset | `client_bank` | Control account. It is **not** a core bank account, so core receipts and payments can never post to it. |
| 2300 | Client money held | liability | `client_control` | Control account. Equals the sum of client matter ledgers. |
| 4010 | Professional fees | income | `fees` | Profit costs from fee notes. |
| 1105 | Disbursements recoverable | asset | `disbursements` | Office-paid disbursements awaiting billing (Phase 2). |

The office side uses core accounts: 1200 office bank, 1100 debtors, 2200 VAT output.

### 4.3 Postings

| Event | Journal (GL) | Matter ledger |
|---|---|---|
| Client receipt (money on account, completion funds) | Dr 1250 Client bank / Cr 2300 Client money held | client +amount |
| Client payment out (SDLT, seller's solicitor, court fee) | Dr 2300 / Cr 1250 | client −amount (refused if it would go below zero) |
| Fee note (profit costs + VAT) | Dr 1100 Debtors / Cr 4010 Fees / Cr 2200 VAT output | office +gross |
| Transfer client → office to settle a fee note | Dr 2300 / Cr 1250 **and** Dr 1200 Office bank / Cr 1100 Debtors (one balanced entry) | client −amount, office −amount |
| Office receipt against a fee note (Phase 2) | Dr 1200 / Cr 1100 | office −amount |
| Disbursement paid from office (Phase 2) | Dr 1105 / Cr 1200 (+ input VAT when it's a recharge) | office +amount |
| Interest on client money (Phase 2) | Dr interest payable (expense) / Cr 1200 office, then Dr 1250 / Cr 2300 (office → client) | client +interest |

### 4.4 Modules

1. **Clients and matters:** clients are core contacts (`kind = customer`) plus law details (individual or organisation, CDD status). Matters carry a number, client, description, responsible fee earner, status, and default hourly rate.
2. **Client and office ledgers per matter:** an append-only `law_ledger_entries` table. Balances are summed from the rows, and a trigger stops a client balance going negative.
3. **Time recording:** fee earners have rates. Time is held in minutes and valued in **6-minute units** (the usual UK convention), rounded up to the next unit, × hourly rate ÷ 10, to the penny. WIP is unbilled time.
4. **Fee notes (bills):** bill selected unbilled time on a matter, add VAT at 20% (S20; the firm can choose another code), and post to the GL. The time entries are stamped with the fee note. Phase 2 adds disbursement and recharge lines, abatements and write-offs.
5. **Disbursements:** client-paid or office-paid, with treatment (disbursement or recharge) by cost type. Phase 2.
6. **Transfers client → office:** settle a fee note from money held for that matter. Limited to the smaller of the fee note's outstanding amount and the matter's client balance.
7. **Three-way reconciliation:** see §5.
8. **Interest on client money:** Phase 2.

---

## 5. Three-way reconciliation

Three figures, at a statement date:

1. **Bank:** the client bank statement balance, adjusted for timing differences. Add lodgements not yet cleared, subtract payments not yet presented. **Adjusted bank = statement + outstanding lodgements − unpresented payments.**
2. **Client cash book:** the GL balance of 1250 Client bank account up to the date.
3. **Client ledgers:** the sum of every matter's client balance up to the date. This must also equal the GL balance of 2300 Client money held.

It reconciles when all three agree to the penny **and** no matter's client ledger is overdrawn. The report lists each difference, any overdrawn ledgers and the matter balances. A saved reconciliation records the preparer and then, separately, the sign-off (COFA or manager, per rule 8.3). Sign-off happens once and is permanent. The next reconciliation is due 35 days after the last statement date (the five-week rule).

---

## 6. Phased roadmap

### Phase 1: Client money core (this slice, then hardening, ~3 months)
- ✅ Clients and matters; client bank kept apart from office; law accounts added to the chart.
- ✅ Receipts into client account per matter; payments out refused if they would overdraw the matter's client ledger (API and DB trigger).
- ✅ Fee earners, time entries in 6-minute units, fee notes with VAT, client → office transfers against a fee note.
- ✅ Three-way reconciliation report, saved, with COFA or manager sign-off and a five-weekly due date.
- Next: client bank statement import using the core CSV parser, matched to client cash-book lines so outstanding items come from data instead of typed-in figures; office receipts against fee notes; credit notes and fee note reversals; matter closure checks; jurisdiction profile setting.

### Phase 2: Full cashiering (~3 months)
- Disbursements (client-paid and office-paid) with disbursement or recharge VAT treatment and cost types.
- Payment approval workflow (rule 5.2) with limits, two-person approval, and confirmation of the payee's bank details (anti-fraud).
- Interest on client money: policy, calculation and posting (rule 7.1).
- Residual and dormant balance reports and prompts (rule 2.5); breach register (rule 6.1).
- Banking-facility flags (rule 3.3); CDD status gating receipts.
- Inter-matter transfers (client to client) with an audit reason.
- WIP and aged debtors by fee earner, recovery rates and matter profitability.

### Phase 3: Compliance reporting and practice management (~3 months)
- Accountant's report pack and exemption check (rule 12); reporting-accountant access through the core accountant portal.
- Track the SRA's pending changes to the accountant's report regime (§3.1).
- Matter budgets and estimates, with warnings at 75% and 100% (SRA transparency and costs information).
- Fee note templates and an e-billing format (LEDES) for commercial clients.
- Jurisdiction profiles for **Scotland** (Rule B6, accounts certificates, "fee notes" and "outlays") and **Northern Ireland** (2014 Regulations), after the open questions in §1.1 are confirmed.

### Phase 4: Legal aid (~3–4 months, optional)
- LAA civil and crime claims, controlled-work monthly submissions, payment matching into office account, and LAA-specific exemptions from client-account rules.

---

## 7. What the first slice contains

| Layer | Location | Contents |
|---|---|---|
| Domain | `verticals/law-firms/domain` | Time units and value, fee-note VAT, client-money guards, posting rules (receipt, payment, fee note, transfer) built on core `finalise`, three-way reconciliation, with unit and property-based tests |
| Database | `verticals/law-firms/api/migrations/law_001_core.sql` | `law_clients`, `law_fee_earners`, `law_matters`, `law_time_entries`, `law_fee_notes`, `law_ledger_entries` (append-only, no overdrawn client ledger), `law_reconciliations` (sign-off once). RLS on all tables |
| API | `verticals/law-firms/api` | Core `buildServer` + a law module (`/api/law/*`). End-to-end test of the whole cycle, including refusals and RLS |
| Web | `verticals/law-firms/web` | Next.js app reusing the core UI kit and brand tokens: matters list and detail (both ledgers, time, fee notes, actions), clients, fee earners, and three-way reconciliation with sign-off |

## 8. Open questions

- Should a firm be able to run several client bank accounts (for example, a separate designated deposit account per estate)? The data model allows it later (an account code on each ledger row). The slice uses one.
- Is it worth the risk of blocking a client receipt when CDD isn't complete? Some firms must accept completion monies regardless.
- Exact Scottish and NI reconciliation frequencies and report formats (§1.1).
