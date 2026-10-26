# Softilo for Pharmaceutical & Medical Wholesale — Edition Plan

**Status:** Draft v0.1, 26 Oct 2026. First vertical slice built in this folder (see §6).
**Builds on:** the Softilo shared core (`packages/domain`, `packages/db`, `apps/api`, `apps/web`) described in [docs/architecture-and-mvp-plan.md](../../../docs/architecture-and-mvp-plan.md).

> **Regulatory caveat.** This plan summarises UK rules as we understand them for product design. It is not legal or regulatory advice. Items marked **[verify]** were not confirmed against a primary source (legislation.gov.uk, MHRA or Home Office guidance) while writing, and must be checked with a Responsible Person or regulatory adviser before the feature that depends on them ships. Rules here change often (the Windsor Framework and device transition dates both moved in 2024–26).

---

## 1. Target customers

UK businesses that **buy, hold and resell** medicines or medical devices to other businesses, typically 10–250 staff:

| Segment | Examples | What they hold |
|---|---|---|
| **Full-line and short-line pharmaceutical wholesalers** | Regional wholesalers supplying community pharmacies, dispensing doctors, care homes | WDA(H); often a Home Office controlled-drug licence |
| **Specialist / "specials" and unlicensed-medicine importers** | Importers of unlicensed medicines for named patients, parallel importers | WDA(H) with import activities; notifications to MHRA for unlicensed imports **[verify scope per product]** |
| **Hospital and clinic suppliers** | Distributors to NHS trusts, private hospitals, aesthetic clinics, dental and vet practices | WDA(H); often device distribution as well |
| **Medical-device distributors** | Consumables, diagnostics (IVDs), surgical instruments, mobility aids | No WDA needed for devices alone, but device-distributor obligations under the UK MDR 2002 and the post-market surveillance rules |
| **Pharmacy-owned wholesale arms** | Pharmacy groups with an inter-branch wholesale licence | WDA(H) |

They have outgrown Xero/Sage plus spreadsheets, and the mid-market pharma ERPs (or a generic ERP with a pharma bolt-on) are too expensive to implement.

## 2. Pain points

1. **Batch and expiry live outside the books.** Stock is valued in the accounts by SKU while batch numbers and expiry dates are in a spreadsheet or a separate WMS. Picking is "oldest on the shelf" by eye, and short-dated stock is found too late to sell.
2. **Quarantine and release are paper-based.** Goods-in sits in a quarantine cage; the Responsible Person (RP) signs a paper release. Nothing stops a picker from selling a batch that was never released, and the audit trail is a binder.
3. **Recalls are slow.** A drug alert arrives (MHRA Class 1–4 recall) and the team has to reconstruct who received the affected batch from invoices and delivery notes. GDP expects this to be fast and complete.
4. **Customer licence checks are manual.** Staff check a pharmacy's GPhC registration or a wholesaler's WDA(H) once at account opening and rarely again. Lapsed licences go unnoticed.
5. **Temperature excursions** on cold-chain lines (2–8 °C) are recorded on data loggers but not linked to the batches that were in the fridge.
6. **Controlled drugs** need a running-balance register per drug, form and strength, kept separately (often in a bound book), and reconciled against stock.
7. **Two regimes in one company**: medicines (MHRA licensing, GDP) and devices (UKCA/CE marking, UDI) need different checks, but the same sales order may contain both.

## 3. UK rules that shape the product

### 3.1 Wholesale dealing in medicines — WDA(H)
- Wholesale dealing in human medicines needs a **Wholesale Dealer's Authorisation, WDA(H)**, granted by the MHRA under the **Human Medicines Regulations 2012** (Part 3). The licence lists the sites and the activities authorised.
- The licence holder must comply with **Good Distribution Practice (GDP)** — the EU GDP guidelines (2013/C 343/01) as retained/adopted in the UK — and is inspected by the MHRA GDP inspectorate.
- **Product implication:** each tenant records its own WDA(H) number and authorised sites; warehouses carry a "licensed site" flag. Reports must be inspection-ready: who released what, when, and every movement of a batch.

### 3.2 Responsible Person (RP)
- Every WDA(H) names at least one **Responsible Person**, who is accountable for GDP compliance, including **release of returned stock to saleable stock**, supplier and customer qualification, recall coordination and handling of falsified/suspected products. MHRA Guidance Note 6 (GN6) and the MHRA Inspectorate blog describe the role.
- In practice, release of **received** stock into saleable stock is usually done under a QMS procedure authorised by the RP. Whether every goods-in release must personally be signed by the RP, or by trained staff under an RP-approved procedure, depends on the company's QMS **[verify per customer's QMS; GDP 6.3 wording for returns is explicit, goods-in less so]**.
- **Product implication:** the system keeps a register of named RPs (and RPi for import, later). Release, rejection and return-to-stock decisions require a user designated as RP (or an RP-delegated quality user — configurable later). Every decision records who, when, and why, in the append-only audit chain.

### 3.3 Batch and expiry control, FEFO
- GDP requires stock rotation so that products with the **earliest expiry are distributed first (FEFO)**, with documented exceptions, and that expired or short-dated stock is segregated and not supplied.
- Customers commonly specify a **minimum remaining shelf life** (e.g. 3 or 6 months) on delivery.
- **Product implication:** every receipt of a batch-tracked product captures batch number and expiry. Allocation is FEFO across released, in-date batches, honouring a per-customer minimum shelf life. Expiry dates printed as month/year are treated as the last day of that month.

### 3.4 Stock status: quarantine, released, rejected, recalled
- GDP requires physical or equivalent electronic segregation of **quarantined, rejected, recalled, returned and falsified/suspected** products from saleable stock, and that such stock cannot be supplied.
- **Product implication:** batch status is a state machine:

```
 received ──▶ quarantine ──(RP release)──▶ released ──▶ (FEFO-sellable while in date)
                  │                           │
                  ├──(RP reject)──▶ rejected  ├──(recall)──▶ recalled
                  └──(recall)──▶ recalled     └──(RP quarantine)──▶ quarantine
```
Only `released` batches that are in date (after the customer's minimum shelf life) can be allocated. Rejected and recalled stock stays on the books until destroyed or returned to supplier (a later phase posts write-offs through the core stock-adjustment rules).

### 3.5 Temperature-controlled storage
- GDP requires storage within the labelled conditions, temperature mapping of storage areas, continuous monitoring with alarms, and records retained; excursions must be investigated and affected stock quarantined pending an RP decision.
- **Product implication (Phase 2):** storage zones (ambient 15–25 °C, cold chain 2–8 °C, frozen) with a product-to-zone rule; temperature log import (CSV from data loggers) with excursion detection; an excursion automatically quarantines batches held in that zone during the excursion, for RP decision.

### 3.6 Recalls
- MHRA issues **National Patient Safety Alerts / drug alerts** (recall classes 1–4) and the Defective Medicines Report Centre handles defects. Wholesalers must be able to trace and notify every customer supplied with an affected batch promptly and record reconciliation of returned quantities. GDP expects recall procedures to be tested (mock recalls).
- **Product implication:** recall trace by batch — supplier, receipt, every customer and invoice, quantity supplied, quantity still in stock — in one screen and export. Recalling a batch blocks allocation immediately. Later: customer notification letters, returns reconciliation, and mock-recall timing reports.

### 3.7 Controlled drugs
- Possessing and supplying controlled drugs (CDs) is governed by the **Misuse of Drugs Act 1971** and the **Misuse of Drugs Regulations 2001**, which place drugs in Schedules 1–5. Wholesale dealing in most CDs needs a **Home Office controlled-drug licence** in addition to the WDA(H) **[verify which schedules require a licence for a wholesaler]**.
- **CD registers**: Schedule 2 drugs (and Schedule 1) need a register entry for each receipt and supply, kept per drug/form/strength with a running balance; records must be kept for at least **two years** from the last entry **[verify; secondary sources only]**. Entries are made on the day or within 24 hours in some settings **[verify for wholesalers]**.
- Schedule 2 and 3 orders from practitioners/pharmacies generally need a **requisition** (mandatory FP10CDF form or equivalent) **[verify exemptions when the purchaser is another wholesaler]**.
- **Product implication (Phase 2):** CD schedule on the product; an append-only CD register generated from batch movements with running balance; supply to a customer of a Schedule 2/3 drug requires a recorded requisition reference; register-vs-stock reconciliation.

### 3.8 Customer qualification ("bona fides")
- Wholesalers must verify that customers are **entitled to receive medicines** before supplying them — e.g. a wholesaler customer must hold a WDA(H); a pharmacy must be on the GPhC register of premises; a doctor must be registered with the GMC. The MHRA Inspectorate blog on qualification of customers states that a wholesaler customer must hold a WDA(H) before placing orders.
- **Product implication (this slice):** customer licences/registrations are recorded with type, number, expiry and verification date; the system refuses to supply a prescription-only (POM) or pharmacy (P) medicine unless the customer holds a verified, in-date entitlement of an accepted type. General Sales List (GSL) medicines and devices do not require one. Live lookups against the MHRA wholesale register and the GPhC register are Phase 2 (no public APIs are known to us **[verify]**; likely scheduled register downloads).

### 3.9 Falsified medicines safety features — GB vs Northern Ireland
- **Great Britain:** since 1 January 2021 the EU Falsified Medicines Directive (FMD) "safety features" (unique identifier 2D barcode and verification against the EU hub) no longer apply in GB. Packs may still carry them, but GB wholesalers have no legal obligation to verify or decommission **[verify current MHRA position; the UK has consulted on a future national scheme]**.
- **Northern Ireland:** under the **Windsor Framework**, from **1 January 2025** medicines are licensed UK-wide by the MHRA, EU FMD safety features are **disapplied** for medicines supplied in NI, and packs must carry a **"UK Only"** label to stop onward movement into the EU. Packs released before 31 December 2024 may stay in supply until expiry without the label. Anti-tamper devices are expected to remain **[verify exact wording against MHRA guidance]**.
- **Product implication:** no FMD verification integration is needed for UK supply. Products get a flag "UK Only labelled" and a customer flag "Northern Ireland delivery"; supplying an NI customer from a batch released after 31 Dec 2024 without the "UK Only" flag raises a warning (Phase 2). If a tenant exports to the EU, FMD verification would be an add-on, not in scope.

### 3.10 Medical devices — UKCA and CE
- Devices placed on the GB market need **UKCA** marking under the **UK Medical Devices Regulations 2002** (as amended), or a **CE** mark accepted under transitional arrangements. Current dates as we understand them: devices compliant with the EU MDD/AIMDD accepted in GB until **30 June 2028**; devices compliant with EU MDR or IVDR, and IVDD devices, until **30 June 2030** — or earlier if the device's certificate expires. In 2026 the MHRA consulted on extending the MDD date to 31 Dec 2028 and recognising EU MDR/IVDR CE marks indefinitely; **the outcome was not confirmed at the time of writing [verify]**.
- **Northern Ireland** follows EU rules for devices (CE, or CE + UKNI) under the Windsor Framework.
- Distributors have obligations to check marking, labelling and instructions, keep traceability, and cooperate with field safety corrective actions; the **post-market surveillance** amendments in force from June 2025 increased these **[verify distributor-specific duties]**.
- **Product implication:** device products carry conformity mark (UKCA / CE / CE+UKNI), certificate expiry, UDI-DI and class; the system warns when a CE certificate or transition date has passed (Phase 2). Lot/serial tracking reuses the batch model.

---

## 4. Module design on top of the shared core

The edition is **additive**: it never changes how the core posts to the ledger. Batch tracking is a quantity sub-ledger alongside the core's weighted-average stock, written in the same transaction as the core stock movement.

```
verticals/pharma-medical/
  domain/   @softilo/pharma-domain  pure rules: expiry, batch status machine, FEFO allocation, supply eligibility
  api/      @softilo/pharma-api     Fastify server = core buildServer + pharma module; pharma_* migrations
  web/      @softilo/pharma-web     Next.js app = core screens (re-exported) + pharma screens, Softilo brand
  docs/plan.md
```

| Area | Core it reuses | Pharma addition |
|---|---|---|
| Product master | `products` | `pharma_products`: kind (medicine/device), legal category (POM/P/GSL), CD schedule, storage zone, batch-tracked, marketing authorisation number, device mark |
| Goods in | `receiveGoods` (PO → GRN → stock + GRNI journal) | Batch number, expiry, manufacture date captured per receipt line; batch created in **quarantine** |
| Batch control | `stock_movements` (append-only) | `pharma_batches` (current status), `pharma_batch_movements` (append-only quantities), `pharma_batch_events` (append-only status history with RP sign-off) |
| Quality | `audit_log` hash chain | Responsible Person register; release / reject / recall / re-quarantine decisions |
| Customers | `contacts` | `pharma_customer_licences` (type, number, valid dates, verified on/by/source) and min shelf-life per customer |
| Sales | `createSalesDocument` (invoice + COGS at WAC + VAT) | Licence check, FEFO allocation over released in-date batches, batch lines on the dispatch |
| Recall | — | Trace by batch: receipt, supplier, every customer supply, on-hand |
| Integrity | `/api/reports/integrity` | Batch quantity per product/warehouse must equal core stock quantity |

**Guard rails over the core:** in the pharma server, core routes that would move batch-tracked stock without batch detail (`POST /api/purchase-orders/:id/receive`, `POST /api/sales-invoices`) are refused for batch-tracked products and point the user to the pharma routes. Credit notes with returns to stock and manual stock adjustments for batch-tracked products are also refused until the returns workflow (Phase 2) exists.

**Accounting:** unchanged. Receipts post Stock / GRNI, sales post Debtors / Sales / VAT and COGS at weighted-average cost via the core posting rules. Rejected and recalled stock keeps its value until written off (Phase 2: write-off posting via the core adjustment rule, Dr Stock write-off / Cr Stock).

## 5. Phased roadmap

### Phase P1 — GDP core (this slice + next 8–10 weeks)
- ✅ Batch/expiry capture on receipt; batches start in quarantine.
- ✅ RP register; release / reject / recall / re-quarantine with reasons; append-only history.
- ✅ FEFO allocation of released, in-date stock with customer minimum shelf life.
- ✅ Customer licence register and supply-eligibility check (POM/P need a verified, in-date entitlement).
- ✅ Recall trace by batch; batch-vs-stock integrity check.
- Next: customer returns workflow (returns go to quarantine, RP decides; GDP 6.3 conditions such as time since supply and cold-chain evidence), stock adjustments and write-off of rejected/expired batches, delivery note/pick list printing with batch and expiry, expiry dashboard (short-dated in 30/60/90 days), supplier qualification (supplier WDA/MIA on file before receipt).

### Phase P2 — Cold chain, CDs and devices (~3 months)
- Storage zones, temperature-log import, excursion detection and automatic quarantine.
- Controlled-drug register with running balances, requisition capture, register-vs-stock reconciliation; Home Office licence on the tenant and customers.
- Device fields: UKCA/CE mark, certificate expiry, UDI-DI, class; warnings at transition dates; serial tracking.
- Northern Ireland: "UK Only" pack flag and NI delivery checks.
- Recall workflow: customer notification letters/emails, returned-quantity reconciliation, mock-recall timer report.
- Scheduled checks of customer registrations (MHRA wholesaler register, GPhC premises register) with expiry reminders.

### Phase P3 — Scale and inspection readiness (~3 months)
- Warehouse PWA: scan GS1 DataMatrix / GS1-128 to capture GTIN, batch and expiry at goods-in and pick.
- Deviation, CAPA and change-control log; self-inspection checklist; training records for staff with GDP roles.
- Self-serve inspection pack: licence, RP, SOP index, batch genealogy and recall drills exported as one PDF.
- Parallel import / specials: per-product MA/PL numbers, unlicensed import notifications.
- Multi-site licences per warehouse, inter-site transfers keeping batch status.

## 6. What the first slice contains

- **Domain** (`domain/src`): `expiry.ts` (month/year expiry normalisation, shelf life), `batch-status.ts` (state machine, RP rules), `fefo.ts` (FEFO allocation, decimal quantities), `eligibility.ts` (customer licence check). Unit and property-based tests.
- **Migrations** (`api/migrations/pharma_001_gdp_core.sql`): `pharma_products`, `pharma_responsible_persons`, `pharma_customer_profiles` (minimum shelf life), `pharma_customer_licences`, `pharma_batches`, `pharma_batch_movements`, `pharma_batch_events`, `pharma_dispatches` (with a snapshot of the licences relied on). RLS on all. Movements, events and dispatches are append-only. Database triggers also enforce the key rules: on-hand quantity is maintained from movements and can't go negative, status only changes through a recorded event, quality decisions need an active RP, dispatches come only from released in-date batches, and batch identity is fixed.
- **API** (`api/src/modules/pharma.ts`): `/api/pharma/...` for product classification, Responsible Persons, customer licences and shelf-life profiles, goods in with batches, batch status decisions, recall and trace, FEFO allocation preview, dispatch (licence check, then FEFO, then the core sales invoice in one transaction), integrity and dashboard. Core stock routes are refused for batch-tracked products. End-to-end test in `api/src/e2e.test.ts`; demo data in `api/src/seed.ts`.
- **Web** (`web/`): GDP overview, batches list and detail (RP decisions, history), goods in with batches, dispatch with FEFO and licence preview, recalls and trace, customer licences, product classification and RP register. Every core screen is served unchanged through one-line re-exports, with a "Quality (GDP)" menu group added to the core navigation.

## 7. Sources consulted

- MHRA Inspectorate blog — qualification of customers: https://mhrainspectorate.blog.gov.uk/2016/06/03/qualification-of-customers-what-wholesalers-need-to-know/
- MHRA Inspectorate blog — the RP named on the WDA: https://mhrainspectorate.blog.gov.uk/2018/07/13/the-responsible-person-named-on-the-wda-part-2-effective-appointment-and-training/
- MHRA Guidance Note 6 (Brexit changes, GDP): https://assets.publishing.service.gov.uk/media/67a203d5b74b3d9dfe36c9e7/GN_6_Brexit_changes-GDP.pdf
- Windsor Framework and medicines (NI Business Info): https://nibusinessinfo.co.uk/content/windsor-framework-supply-medicines-northern-ireland
- Community Pharmacy England on the Windsor Agreement: https://cpe.org.uk/our-news/windsor-agreement-on-the-supply-of-medicines-into-northern-ireland
- Device transition dates and 2026 consultation: https://www.lw.com/en/insights/uk-mhra-launches-consultation-on-indefinite-recognition-of-ce-marked-medical-devices , https://hlc.com/en/publications/uk-mhra-consults-on-indefinite-recognition-of-ce-marked-medical-devices
- CD requisitions (NHSBSA): https://www.nhsbsa.nhs.uk/sites/default/files/2017-03/Mandatory_Requisition_Forms_-_Additional_Guidance.pdf
