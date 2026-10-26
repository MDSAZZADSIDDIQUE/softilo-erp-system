# Softilo for Light Manufacturing — Edition Plan

**Status:** Draft v0.1, 26 Oct 2026. The first vertical slice is built (see §7).
**Builds on:** the Softilo shared core on `main` (ledger, VAT, inventory at weighted-average cost, purchasing, sales, banking). Read [the core plan](../../../docs/architecture-and-mvp-plan.md) first.

Facts marked **[unverified]** were not checked against a primary source (legislation, GOV.UK or the FRC text) while writing this. Check them before building any feature that depends on them.

---

## 1. Who it is for

UK makers and assemblers with **10–250 staff** and about **£2m–£40m turnover**. They make their own products in small and medium batches, usually make-to-stock with some make-to-order:

| Segment | Typical products | What they need most |
|---|---|---|
| Assemblers | Control panels, lighting, small electrical and electronic goods, furniture | Multi-level BOMs, kitting, serial numbers, UKCA/CE records |
| Light fabricators | Sheet metal, signage, joinery, plastics moulding | Routings and machine hours, scrap, overhead absorption |
| Process-light makers | Cosmetics, candles, cleaning products, coffee roasting (no full recipe/batch regulation) | Yield and wastage, batch/lot traceability, packaging data |
| Own-brand product companies that assemble in the UK | Bikes, outdoor kit, audio | Landed cost of imported parts (already in core) feeding product cost |

They usually run on Xero or Sage 50 plus spreadsheets, sometimes with a separate MRP add-on (Katana, MRPeasy, Unleashed). The accounts and the shop floor disagree every month.

## 2. Pain points

| Pain | What happens today | Softilo answer |
|---|---|---|
| Nobody knows what a product really costs | BOM cost in a spreadsheet, last updated two years ago; labour guessed | **Cost roll-up** through every BOM level from live average costs plus standard labour and overhead rates |
| Stock in the accounts is a month-end guess | Stock journal from a count, with WIP ignored or estimated | Every issue, labour booking and completion posts **its own balanced journal**: stock → WIP → finished goods |
| Shortages discovered on the shop floor | Works orders released without checking components | **MRP shortage report** against open works orders, stock and open purchase orders |
| Year-end stock valuation argued with the accountant | Overheads not absorbed, or absorbed at a rate nobody can explain | **Absorption at standard rates per work centre**, with the under/over-absorbed balance visible in the P&L (FRS 102, §3.5) |
| Packaging and plastic compliance done by hand | pEPR and Plastic Packaging Tax data compiled from purchase invoices once a year | Packaging specifications on products and BOMs, so tonnages come out of sales and production data (Phase 2) |
| R&D claims built after the event | Timesheets reconstructed from memory | Projects, timesheets and materials tagged to R&D as they happen (Phase 3) |
| UKCA/CE files on a shared drive | Declarations of conformity not linked to products or batches | Conformity records attached to products, BOM versions and batches (Phase 2) |

## 3. UK rules and reporting that apply

### 3.1 Packaging extended producer responsibility (pEPR)
- Applies to UK organisations that supply packaging. **Large producers**: turnover of £2m or more *and* more than 50 tonnes of packaging a year. **Small producers**: £1m or more *and* more than 25 tonnes. Small producers report data but pay no waste management fees. Sources: GOV.UK guidance via commentary; the thresholds are well established.
- **Large producers report every six months** (H1 by 1 October, H2 by 1 April). **Small producers report once a year by 1 April.** Data is split by packaging material, packaging type (household, non-household, public bin, reusable, etc.) and, for plastics, by flexible and rigid. Nation-of-sale data is due from the 2026 data year (reported in April 2027). **[unverified: exact data fields and dates. Check against the current Defra/PackUK reporting specification.]**
- Fees are **per tonne per material**, set by PackUK. Illustrative year-2 (2026/27) plastic base fee of about £455/t, against £423/t in year 1. **Modulated fees start in 2026/27, based on the Recyclability Assessment Methodology (RAM) rating:** green, amber or red. Red packaging carries a multiplier (reported as 1.2× in 2026/27, rising to 2.0× by 2028/29). **[unverified: the final 2026/27 fees and multipliers. The sources were secondary. Load fees as dated, tenant-editable tables; never hard-code them.]**
- *What Softilo needs:* packaging components on products and BOMs (material, weight in grams, packaging type, RAM rating, flexible/rigid, nation of sale). Tonnage reports run from sales despatches and from packaging consumed by works orders. A fee estimate uses a dated fee table. CSV export in the regulator's upload layout.

### 3.2 Plastic Packaging Tax (PPT)
- Charged on plastic packaging components **manufactured in or imported into the UK** that contain **less than 30% recycled plastic**. Rate per tonne: **£200 (Apr 2022), £210.82 (Apr 2023), £217.85 (Apr 2024), £223.69 (Apr 2025), £228.82 (from 1 Apr 2026)** (GOV.UK). **[unverified: the 2023 and 2024 rates were recalled from memory, not checked.]**
- Registration is required if a business has manufactured or imported **10 tonnes or more in the last 12 months**, or expects to in the next 30 days. Quarterly returns. Records of each component's weight and recycled content (with evidence) must be kept. **[unverified: return frequency, record-keeping period and current exemptions, such as medicines packaging and transit packaging for imports. Check the current HMRC notice.]**
- *What Softilo needs:* plastic components on BOMs (weight, recycled %, evidence document), quarterly tonnage from works-order consumption and imports (from core purchasing/landed cost), and a draft PPT return. Rates go in dated tables.

### 3.3 UKCA and CE marking records
- Great Britain recognises **CE marking indefinitely** for most product regulations administered by DBT, under the Product Safety and Metrology etc. (Amendment) Regulations 2024, in force 1 October 2024. Makers can use UKCA or CE in GB. Northern Ireland follows EU rules (CE, or CE + UKNI). Medical devices, construction products and some other regimes have separate timelines. **[unverified: whether a given customer's product falls under an included regulation.]**
- The manufacturer must keep a **technical file and a declaration of conformity**, available to market surveillance authorities. The retention period is commonly **10 years after the product is placed on the market**. **[unverified: check the product-specific regulation.]**
- *What Softilo needs:* conformity records (regime, mark, standards applied, declaration document, approved body, date) linked to products and BOM versions. Batch/serial traceability shows which declaration covered each unit shipped. Retention dates are calculated, and records are not deleted before them.

### 3.4 R&D tax relief cost tracking
- For accounting periods starting **on or after 1 April 2024**: the **merged scheme** (an above-the-line expenditure credit, 20%), or **enhanced R&D intensive support (ERIS)** for loss-making SMEs whose R&D is at least 30% of total expenditure. A company can claim only one relief on the same spending. **[unverified: the ERIS intensity threshold and rates. They were taken from adviser commentary, not HMRC guidance.]**
- Qualifying cost categories include staffing costs, externally provided workers, subcontracted R&D (with restrictions on overseas work), consumables (including materials consumed or transformed in prototypes), software, and data and cloud costs. **[unverified: the full list and any 2026 changes.]**
- First-time claimants (or companies with no claim in the last three years) must **notify HMRC within 6 months of the end of the accounting period**. Every claim needs an **Additional Information Form** before the CT600 claim. HMRC changed the form in 2026. **[unverified: what changed.]**
- *What Softilo needs:* projects with an "R&D" flag. Works orders, labour bookings and material issues can be tagged to a project, so prototype builds already carry consumables and staffing hours. The report gives qualifying cost by category and period, with the notification deadline on the dashboard. Softilo provides the data; the claim itself stays with the adviser.

### 3.5 Stock valuation under FRS 102 Section 13
- Inventories are carried at the **lower of cost and estimated selling price less costs to complete and sell**. Cost includes **costs of purchase** (landed cost, already in core) and **costs of conversion**: direct labour, plus a **systematic allocation of fixed and variable production overheads**.
- **Fixed production overheads are absorbed using normal capacity.** Unabsorbed overhead from low output or idle plant is expensed, not added to stock. **Abnormal waste**, storage (unless needed in production), administration and selling costs are excluded. **Standard costing is allowed if it approximates actual cost** and is reviewed regularly. **[unverified: the paragraph numbers (around 13.8–13.16) and any changes in the 2024 periodic-review amendments effective 1 January 2026. Check the FRC text.]**
- *How Softilo does it:*
  - Materials move into WIP at weighted-average actual cost.
  - Labour and overhead move into WIP at **standard rates per work centre** (labour £/h, overhead £/h). The overhead rate should be set from budgeted overhead ÷ normal-capacity hours.
  - Absorbed amounts are credited to *Labour absorbed into production* and *Overheads absorbed into production*. Actual wages and overheads are posted as usual, so the P&L shows the **under- or over-absorption**: actual cost plus the (credit) absorbed account. The accountant can see it and adjust at year end.
  - Finished goods take the actual accumulated WIP cost of the order.
  - Abnormal scrap is written off to *Production scrap*, not into finished goods.
  - Normal loss stays in the cost of good units.
  - Net realisable value (NRV) write-downs come in Phase 2 (§6).

### 3.6 Other rules touched (later phases)
- **VAT**: no manufacturing-specific rules beyond the core, apart from the reverse charge on some subcontracted construction-type services, which the core already has.
- **Health and safety / COSHH** records for process-light makers. These are out of scope, with a link-out only.
- **WEEE and batteries producer obligations** for electrical makers. These use the same data model as pEPR (weights by category). Phase 3. **[unverified]**

---

## 4. Module design on top of the shared core

```
core products ─┬─ mfg_boms (version, output qty, active) ─┬─ mfg_bom_lines (component, qty per batch, wastage %)
               │                                          └─ mfg_bom_operations (work centre, setup h, run h/unit)
               ├─ mfg_work_centres (labour £/h, overhead £/h)
               └─ mfg_works_orders (product, BOM snapshot, qty, status) ─┬─ mfg_works_order_components (required, issued)
                                                                         └─ mfg_works_order_transactions (append-only:
                                                                            issue | labour | overhead | complete | scrap | variance)
```

**Accounts added per tenant** (inserted when first used, so the core chart is unchanged):

| Code | Name | Type | Role |
|---|---|---|---|
| 1002 | Work in progress | asset, control | `wip` |
| 5300 | Production scrap | expense | `scrap` |
| 5310 | Production variances | expense | `production_variance` |
| 5400 | Labour absorbed into production | expense (credit balance) | `labour_absorbed` |
| 5410 | Overheads absorbed into production | expense (credit balance) | `overhead_absorbed` |

Finished goods and raw materials share the core **Stock (1001)** control account. That keeps the core stock-vs-ledger integrity check valid without changes, because every stock movement still lands in 1001. A separate WIP-vs-ledger check is added: the sum of works-order transactions equals the WIP account.

### 4.1 Multi-level bills of materials
- A BOM belongs to a product and makes an **output quantity** (batch size, e.g. 10 units). Lines hold component quantity per batch and **wastage %**. Operations hold the routing: work centre, setup hours per batch and run hours per unit.
- A component can itself have an active BOM, which makes it a sub-assembly, to any depth. Cycles are refused when a BOM is created.
- BOMs are versioned and never edited once used. A change is a new version; activating one makes the old version inactive. Works orders snapshot their requirements, so a later BOM change never rewrites history.

### 4.2 Routings and work centres
- Work centres carry a **standard labour rate and overhead rate per hour**. Phase 2 adds capacity (hours per day), calendars and machine versus labour hours.
- In the slice, a routing is the BOM's operation list. Phase 2 makes routings their own versioned object shared by several BOMs.

### 4.3 Works orders
- Status flow: `planned → released → completed`, or `cancelled` (only before anything has been posted).
- On creation, component requirements are calculated as `qty ÷ BOM output × line qty × (1 + wastage%)`, rounded **up** to 4 decimal places.
- Planned and released orders feed MRP. Only released orders accept postings.

### 4.4 Material and labour issue
- **Issue**: stock out at weighted-average cost (core costing engine). Posts **Dr WIP, Cr Stock**. Over-issue against the requirement is allowed but flagged; the excess shows up in the cost.
- **Labour/time booking**: hours at a work centre. Posts **Dr WIP, Cr Labour absorbed** (hours × labour rate) and **Dr WIP, Cr Overheads absorbed** (hours × overhead rate).

### 4.5 Finished-goods costing, WIP accounting and scrap
- **Completion** of *good* and *scrap* quantities takes a share of the order's WIP balance in proportion to quantity: `WIP × (good + scrap) ÷ max(remaining, good + scrap)`. That share is split between good and scrap units by quantity, using largest-remainder pence.
- Good units post **Dr Stock, Cr WIP** with a stock receipt at that value. Scrap units post **Dr Production scrap, Cr WIP** (abnormal loss, excluded from stock cost under FRS 102).
- The **final** completion (cumulative good + scrap reaching the order quantity), or an explicit close, clears the whole remaining WIP balance. A residual left with no units to take it (for example, material issued after the last unit was made) goes to **Production variances**. A closed order always has zero WIP.
- Every step is one balanced journal through the domain posting rules, with stock movements in the same transaction.

### 4.6 Cost roll-up
- Standard cost per unit for any product with a BOM:
  - **material** = Σ (component unit cost × qty × (1 + wastage)) ÷ output;
  - **labour / overhead** = Σ ((setup ÷ output) + run) × rate.
- Component unit cost is the rolled-up cost for sub-assemblies, and the current average cost (or last purchase price if there is no stock) for bought-in items.
- The roll-up is kept at 6 decimal places, broken down by material, labour and overhead, and by level. It is shown per BOM and compared with the actual cost of completed orders. Phase 2 adds frozen standard-cost versions and variance analysis.

### 4.7 MRP and purchase suggestions
- **Demand**: unissued component requirements on planned and released works orders.
- **Supply**: stock on hand (all warehouses), open purchase-order quantity (approved, not received) and remaining output on open works orders.
- Netting runs **level by level** (low-level codes): a short sub-assembly becomes a "make" suggestion, and its own components are exploded into demand at the next level. A short bought-in item becomes a "buy" suggestion. The output is a shortage report with actions.
- Phase 2: time-phased MRP with dates, supplier lead times and MOQs/pack sizes, sales-order and forecast demand, and one-click conversion of suggestions into draft POs and works orders.

### 4.8 Shop-floor screens
- Slice: a works-order screen with issue-all-remaining, time booking and complete/scrap buttons, with large tap targets on narrow screens.
- Phase 2: a kiosk-mode PWA by work centre (my jobs, start/stop timer, scan to issue, print travellers and labels), offline queueing, and operator sign-in by badge or PIN.

---

## 5. Roadmap

### Phase M1 — Costed production core (this slice, then hardening; ~3 months)
- ✅ Work centres, multi-level BOMs with routing operations, versioning, cycle checks
- ✅ Works orders: requirements snapshot, issue at average cost, labour/overhead absorption at standard rates, completion with scrap, final clear-down to variance
- ✅ Balanced journals Stock → WIP → Stock (FG), with a WIP-vs-ledger integrity check
- ✅ Cost roll-up (material/labour/overhead) through every level
- ✅ MRP shortage report (level-by-level netting against stock, open POs and open works orders)
- ✅ Web screens: BOMs, work centres, works orders, cost roll-up, shortages
- ☐ Part issues and returns of components to stock; un-completion (reversal) by compensating entries
- ☐ Works-order reports: WIP by order at a date, cost of completed orders vs roll-up
- ☐ Sub-contract operations (free-issue materials to a subcontractor, subcontract bill into WIP)

### Phase M2 — Planning and the shop floor (~4 months)
- Time-phased MRP with lead times, MOQs and forecast and sales-order demand; convert suggestions into POs and works orders
- Separate versioned routings; work-centre capacity and a simple finite-capacity schedule board
- Shop-floor PWA (kiosk, timers, barcode issue, travellers)
- Batch/lot and serial traceability through production (forward and backward trace)
- Frozen standard costs, cost revaluation runs and variance analysis (price, usage, efficiency)
- NRV review report and write-down journals (FRS 102)
- **Packaging data and pEPR reporting**; **Plastic Packaging Tax** quarterly return data
- **UKCA/CE conformity records** linked to products, BOM versions and batches

### Phase M3 — Compliance and insight (~3 months)
- R&D projects: tagging of works orders, labour and materials; qualifying-cost report by HMRC category; notification deadline reminders
- WEEE/batteries producer data where relevant
- Quality: inspection plans, non-conformance reports, quarantine stock
- OEE and labour-efficiency dashboards; margin by product including absorbed cost

---

## 6. Open questions for design partners
1. Do they cost batches at **actual** (this slice) or at **standard with variances**? The slice uses actual materials plus standard conversion rates. Many accountants will want a frozen standard in M2.
2. Is overhead absorbed per labour hour (this slice) or per machine hour? M2 needs both, per work centre.
3. Who books time: operators at a kiosk, or supervisors at the end of a shift?
4. For pEPR: do they hold packaging specifications today, or must Softilo capture them from scratch?

## 7. What the first slice contains
- `verticals/light-manufacturing/domain`: pure functions for requirements, BOM cycle detection, cost roll-up, completion cost split, MRP netting and the WIP posting rules, with unit and property-based tests.
- `verticals/light-manufacturing/api`: `mfg_001_*.sql` migrations with RLS on every table and append-only transactions; Fastify routes under `/api/mfg/*`; the edition server (`core + manufacturing`); and an end-to-end test that builds a two-level product, runs works orders and checks the books at every step.
- `verticals/light-manufacturing/web`: the edition web app. It reuses every core screen and adds a *Manufacturing* section in the Softilo brand.
