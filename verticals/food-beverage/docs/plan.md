# Softilo Food & Beverage — Edition Plan

**Edition:** Food & Beverage Wholesale and Production
**Status:** Draft v0.1, 26 Oct 2026. The first vertical slice (batches, use-by dates, FEFO, expiry report, recall trace) is built in this folder.
**Builds on:** the shared Softilo core (`packages/domain`, `packages/db`, `apps/api`, `apps/web`). Read `docs/architecture-and-mvp-plan.md` at the repo root first.

> **About the regulatory notes.** Items marked **✅ checked** were confirmed against GOV.UK, FSA or legislation.gov.uk pages (or close reproductions of them) on 26 Oct 2026. Items marked **⚠ unverified** come from working knowledge and must be confirmed with the source named before any rule is built on them. Rates change every year: the product stores them as dated rule tables, never as constants in code.

---

## 1. Who it is for

| Segment | Typical size | What they do |
|---|---|---|
| **Food & drink wholesalers** | 10–150 staff, £3m–£60m turnover | Buy from UK and EU producers, sell to independent retailers, cafés, restaurants, schools and care homes. Ambient, chilled and frozen ranges. |
| **Specialist importers** | 5–80 staff | Import from the EU, Asia and the Americas (deli, world foods, wine and spirits), clear customs, supply wholesalers and retail. Landed cost and port health are big issues. |
| **Small producers** | 5–100 staff | Bakeries, sauce and ready-meal kitchens, charcuterie, cheese makers, coffee roasters. Turn ingredients into finished batches. |
| **Breweries, cideries, distilleries** | 3–80 staff | Make and package alcohol, hold stock in duty suspension, file the monthly Alcohol Duty return, sell to the trade, online and from a taproom. |

They usually run Xero or Sage plus a stock spreadsheet, a separate traceability spreadsheet and, for drinks, a duty spreadsheet. Some have outgrown an inventory add-on (Unleashed, Cin7, Brightpearl) that does not handle dates, catch weight or duty properly.

## 2. Their pain points

1. **Traceability lives in spreadsheets.** When a supplier or the FSA calls about a batch, it takes hours to find which customers received it. Environmental health officers and retail customers' auditors (BRCGS, SALSA) expect a mock recall to be done within hours.
2. **Short-dated and expired stock.** Pickers take the nearest pallet rather than the oldest date, so stock goes out of date on the shelf. Write-offs of 2–5% of chilled stock are common, and nobody sees them coming.
3. **Selling past use-by is a criminal offence.** The system must stop it, not just warn.
4. **Allergen data scattered across supplier spec sheets.** Customers (caterers, schools, PPDS sellers) ask for full ingredient and allergen data per product and per change.
5. **Catch weight.** Cheese, meat and fish are ordered by the case or piece but invoiced by actual weight. Generic systems force one unit, so invoices are re-keyed.
6. **Alcohol duty.** Monthly duty returns are worked out by hand from production and dispatch records. Bonded stock, duty-paid stock, Small Producer Relief and draught relief are tracked in spreadsheets.
7. **Packaging taxes and schemes.** Plastic Packaging Tax for importers of filled packaging, packaging EPR reporting, and from October 2027 the deposit return scheme for drinks containers.
8. **Margins are thin.** Landed cost (freight, port health, duty) must hit stock value, and price lists change often.

## 3. UK rules that apply

### 3.1 Traceability, withdrawals and recalls
- **General Food Law, Regulation (EC) 178/2002 (assimilated law in GB), Articles 18 and 19.** ✅ checked (FSA guidance *Food traceability, withdrawals and recalls*). Food businesses must be able to identify their suppliers and the business customers they supply ("one step back, one step forward"), must not place unsafe food on the market, and must withdraw or recall unsafe food and inform the competent authority. Retailers selling to the final consumer need not record those consumers, but all requirements apply when they supply other businesses.
- **A whole batch is presumed unsafe** unless shown otherwise. ✅ checked (FSA guidance). Smaller, well-defined batches limit the size of a recall, so batch definition is a design priority.
- **Internal traceability** (linking inputs to outputs) is not expressly required by General Food Law but is best practice and expected by BRCGS/SALSA. ✅ checked (secondary: Sidley note on the FSA guidance). Softilo should link ingredient batches to production batches anyway.
- **Food of animal origin, Commission Implementing Regulation (EU) 931/2011.** ⚠ unverified (confirm current GB text on legislation.gov.uk). Requires recording, per consignment: description, volume or quantity, supplier and consignee details, lot/batch reference and dispatch date. This is the record set the recall trace must output.
- **Food (Lot Marking) Regulations 1996.** ⚠ unverified. Lot marking is required, except where the date mark shows at least day and month. The system will always hold a batch code; where none is printed, it can use the date mark.
- **FSA/FSS guidance on food incidents:** report to the FSA (England, Wales, NI) or Food Standards Scotland. ⚠ unverified for the current reporting route; check the FSA "report a food incident" page before building notifications.

### 3.2 Date marks and FEFO
- **Use-by** (safety) versus **best-before** (quality). Food past its use-by must not be sold; food past best-before may be sold if it is still safe. ⚠ unverified for the exact offence wording (Food Information Regulations 2014 / retained Reg. 1169/2011 Art. 24). Softilo treats use-by as a hard block on despatch and best-before as a warning.
- **FEFO** (first expiry, first out) is not a statutory rule but is the accepted way to meet the above and to cut waste. Implemented in the slice.
- **Customer minimum life on receipt** (e.g. supermarkets and caterers require at least N days of remaining shelf life) is a commercial rule held per customer.

### 3.3 Allergens and Natasha's Law
- **14 regulated allergens** (Annex II of retained Reg. 1169/2011): cereals containing gluten, crustaceans, eggs, fish, peanuts, soybeans, milk, nuts, celery, mustard, sesame, sulphur dioxide/sulphites (>10 mg/kg or /L), lupin, molluscs. ⚠ unverified for the exact list wording; check the FSA allergen guidance.
- **Natasha's Law** (in force 1 Oct 2021, England, Wales and NI): food **prepacked for direct sale (PPDS)** must carry the name of the food and a full ingredients list with allergens emphasised. ✅ checked (FSA PPDS guidance). Scotland has equivalent rules. ⚠ unverified.
- **Softilo's role:** wholesalers supply PPDS sellers (sandwich shops, cafés, butchers), so we hold full ingredient lists and allergen flags per product and per spec version, print them on delivery notes, and produce PPDS label data for producers.

### 3.4 Weights and catch weight
- Weights and Measures (Packaged Goods) Regulations 2006: average quantity system and the ℮ mark for packers and importers. ⚠ unverified for current GB amendments.
- Catch weight is commercial: order in cases or pieces, invoice by the actual weight captured at picking. Price per kg, VAT on the invoiced weight.

### 3.5 VAT on food and drink
- Most food is **zero-rated**, but confectionery, crisps and savoury snacks, alcoholic drinks, soft drinks, bottled water and hot takeaway food are **standard-rated**. ⚠ unverified for borderline items; HMRC VAT Notice 701/14 is the reference. The core already supports per-product VAT codes (`S20`, `Z0`, …); the edition adds a guided classification for food categories.

### 3.6 Alcohol duty (drinks producers and importers)
- **Duty by strength (ABV) since 1 Aug 2023**, under the Finance (No. 2) Act 2023. ✅ checked (legislation.gov.uk, GOV.UK).
- **Rates uprated by RPI (3.66%) from 1 Feb 2026**, including draught rates and SPR discounts. ✅ checked (GOV.UK "Alcohol Duty uprating" policy paper). Exact rate values are loaded into a dated rate table and must be checked against GOV.UK when entered.
- **Small Producer Relief (SPR):** products below 8.5% ABV, not made under licence, from premises producing under 4,500 hl of pure alcohol a year. The SPR discount is **the rate in force when the product was made**, not when it passes the duty point. ✅ checked (GOV.UK SPR guidance). So every production batch must record its production date and SPR band.
- **Draught relief:** products below 8.5% ABV in containers of at least 20 litres designed to connect to a pressurised gas or pump system. ✅ checked (Finance (No. 2) Act 2023 s.51; GOV.UK). Gravity systems reportedly qualify. ⚠ unverified (secondary source only).
- **Duty suspension:** approved producers and warehousekeepers can hold alcohol in duty suspension; duty becomes due at the duty point (leaving the premises or warehouse into duty-paid circulation). Owners of goods in a bonded warehouse need approval (WOWGR). ⚠ unverified for the current approval names after the 2023 reform.
- **Monthly Alcohol Duty return**, filed online, due (with payment) by the 15th of the following month. ⚠ unverified for the current deadline and whether an API is available for software filing.
- **Duty-suspended movements** between approved premises use EMCS. ⚠ unverified for current GB arrangements.
- **AWRS** (Alcohol Wholesaler Registration Scheme): businesses selling alcohol to other businesses need approval, and trade buyers must check their wholesaler's AWRS reference. ⚠ unverified for current guidance; store the URN on suppliers and customers either way.

### 3.7 Soft Drinks Industry Levy
- Lower rate (5g to under 8g sugar per 100ml) **£2.08 per 10 litres**, higher rate (8g or more) **£2.78 per 10 litres**, from 1 Apr 2026. ✅ checked (GOV.UK).
- From **1 Jan 2028** the threshold drops to 4.5g per 100ml and prepacked milk-based drinks with added sugar come into scope. ✅ checked (GOV.UK policy paper). Relevant to drinks producers and importers.

### 3.8 Packaging
- **Plastic Packaging Tax:** applies to finished plastic packaging components with less than 30% recycled plastic, manufactured in or imported into the UK (including packaging around imported food). Register at 10 tonnes in 12 months (or expected in the next 30 days). Rate **£228.82 per tonne from 1 Apr 2026** (£223.69 from 1 Apr 2025). ✅ checked (GOV.UK and secondary sources). Relevant to importers and producers who package.
- **Packaging extended producer responsibility (pEPR):** data reporting and fees for larger producers. ⚠ unverified for current thresholds and fee timetable.
- **Deposit return scheme (England and NI):** goes live **October 2027** for single-use PET, aluminium and steel drinks containers from 150ml to 3 litres (glass excluded). ✅ checked (multiple trade press sources reporting the government announcement). Deposit amount ⚠ unverified. Scotland and Wales ⚠ unverified.

### 3.9 Food business registration and approvals
- Food businesses register with their local authority at least 28 days before trading; establishments handling products of animal origin may need FSA/local-authority **approval** and carry an identification mark. ⚠ unverified for current thresholds. Softilo stores the registration/approval number per site and prints approval marks on delivery notes.

### 3.10 Imports
- Imports of food and drink from the EU and elsewhere follow the Border Target Operating Model (pre-notification via IPAFFS, risk-based checks, common user charge). ⚠ unverified: the UK–EU SPS agreement negotiated from 2025 may change this; check the current GOV.UK position before building any import checks. The core landed-cost engine already handles port health and duty as cost lines.

## 4. Module design on top of the core

The edition reuses the core unchanged for ledger, VAT, purchasing, landed cost, sales and banking. Food-specific data lives in **side tables keyed to core documents**, written in the **same transaction** as the core document, so the books and the batch records cannot drift apart.

```
core: products ─ stock_movements ─ stock_balances (value, weighted average)
                     │
F&B:  fnb_product_settings (batch tracked, shelf life, date type, min life, allergens, catch weight, ABV)
      fnb_batches (product, batch code, use-by / best-before, supplier, receipt)
      fnb_batch_movements (append-only: batch, warehouse, ± quantity, source document)  → fnb_batch_balances (projection)
      fnb_recalls (later) ─ fnb_recall_notices
```

**Key design choices**

| Decision | Why |
|---|---|
| Batches track **quantity**; value stays at weighted average per product and warehouse in the core | One valuation method, so the stock ledger still equals the stock account. Per-batch costing is a later option (§6). |
| Batch movements are **append-only** with a projection table, exactly like core stock movements | Same audit model accountants and auditors already trust. |
| A trigger-free integrity check: Σ batch balances = core stock balance for every batch-tracked product | Shown on the expiry report and in the end-to-end test. |
| **FEFO is a pure function** in `verticals/food-beverage/domain` | Easy to test exhaustively; the API only loads batches and applies the result. |
| Use-by is a **hard block**: expired use-by batches are never allocated; best-before is allowed with a flag | Matches the legal distinction (§3.2). |
| Customers can require a **minimum remaining life**; FEFO skips batches too short for that customer | Common supermarket and caterer requirement. |
| Manual batch choice on an invoice overrides FEFO but still respects the use-by block | Real warehouses sometimes need it (customer asked for a specific batch). |
| Recall trace reads batch movements joined to core invoices and receipts | One step back (supplier, receipt) and one step forward (customers, invoices, quantities, dates). |

**API** (`/api/fnb/*`, registered into the core server through `buildServer`'s extra modules)

| Route | Purpose |
|---|---|
| `GET/PUT /api/fnb/products/:id/settings` | Batch tracking, shelf life, date type, minimum life, allergens |
| `POST /api/fnb/purchase-orders/:id/receive` | Core goods receipt plus batch code and date per line |
| `POST /api/fnb/sales-invoices` | Core invoice with FEFO (or chosen) batch allocation per line |
| `POST /api/fnb/credit-notes` | Core credit note; restocked food goes back into a named batch the customer received |
| `GET/PUT /api/fnb/customers/...` | Minimum remaining shelf life per customer |
| `POST /api/fnb/allocation-preview` | What FEFO would pick, without posting |
| `POST /api/fnb/batches/:id/write-off` | Dispose of expired or damaged batch stock (posts a core stock adjustment) |
| `GET /api/fnb/batches`, `GET /api/fnb/batches/:id` | Batch list and detail with movements |
| `GET /api/fnb/reports/expiry` | Stock by batch with days to expiry and status |
| `GET /api/fnb/recall-trace?batchId=` | Supplier, receipt and every customer who received the batch |

**Web** (`verticals/food-beverage/web`, a Next.js app that reuses the core screens unchanged and adds a "Food safety" section): batches, batch detail with recall trace and write-off, expiry report, recall search, food settings (batch tracking, date type, shelf life, storage, allergens, customer minimum life), batch-aware receiving, and a batch-aware invoice and credit-note screen with a live FEFO preview.

## 5. Phased roadmap

### Phase F1: traceability core (this slice, then 6–8 weeks)
- ✅ Batch/lot tracking per product, use-by or best-before dates, batch-aware receipts.
- ✅ FEFO allocation on invoices, use-by hard block, minimum remaining life per customer.
- ✅ Expiry report (expired, expiring soon, OK) and batch write-off.
- ✅ Recall trace: supplier and receipt back, customers and quantities forward, printable (CSV export next).
- ✅ Credit-note returns into a named batch (only batches the customer was supplied from).
- Next: batch transfers between warehouses; batch-aware stock takes and positive adjustments.
- Mock recall workflow: open a recall, generate customer notices, record responses, close with a report for BRCGS/SALSA auditors.

### Phase F2: product data and labels (6 weeks)
- Ingredients, 14 allergens, "may contain" statements, nutrition per 100g, spec versions with effective dates and supplier spec sheet uploads.
- Allergen and ingredient data on delivery notes and invoices; PPDS label data export for producers.
- VAT classification helper for food categories.

### Phase F3: catch weight and wholesale ops (8 weeks)
- Dual units (cases and kg), weight captured at picking, invoice by actual weight.
- Sales orders, picking lists in FEFO order with batch scan, delivery routes and drops.
- Temperature records on receipt (chilled/frozen checks) and rejection workflow.
- Customer price lists, promotions and short-dated stock price reductions.

### Phase F4: production (8–10 weeks)
- Recipes/bills of materials, production batches consuming ingredient batches (internal traceability input → output), yields and waste.
- Production batch costing (ingredients + packaging + labour/overhead rate).
- Shelf life set from production date.

### Phase F5: drinks duty (10–12 weeks)
- ABV per product, duty-suspended versus duty-paid stock states, duty point events.
- Dated duty rate tables (Schedule 7/8/9 of F(No.2)A 2023 as uprated), SPR band per production batch at production date, draught relief per container.
- Monthly Alcohol Duty return worksheet with drill-down to dispatches, posting duty to the ledger.
- AWRS URN capture and checks; SDIL worksheet for soft drinks.

### Phase F6: packaging and environmental (4–6 weeks)
- Packaging specs per product (plastic weight and recycled content), PPT quarterly return worksheet, pEPR data report, DRS deposit lines on invoices (before Oct 2027).

## 6. Open questions
- **Per-batch costing:** do design partners need margin by batch (e.g. importers paying different prices per lot)? If so, add batch-level value as an optional costing method alongside weighted average.
- **Core routes vs batches:** the slice refuses core stock routes for batch-tracked products with a Fastify hook in the vertical. A proper extension point in the core (e.g. per-line stock hooks) would let editions add batch data to the core routes instead. Pharma has the same need, so agree it across editions.
- **Duty filing:** confirm whether HMRC offers an API for the Alcohol Duty return, or whether we produce a worksheet for manual entry.

## 7. Known limitations of the first slice
- Batch-aware receipts, invoices, credit notes and write-offs use the `/api/fnb/*` routes. The F&B server refuses the core routes (`/api/purchase-orders/:id/receive`, `/api/sales-invoices`, `/api/credit-notes` with restock, `/api/stock/adjustments`) for batch-tracked products and names the batch-aware route instead, so stock can't move without a batch. The expiry report also checks that batches add up to stock for every tracked product.
- No batch transfers between warehouses, batch-aware stock takes, or positive batch adjustments yet.
- Valuation stays at weighted average per product and warehouse; the expiry report values batches at that average.
- Dates are calendar dates (UK local), with no time-of-day shelf life.
- The allocation preview on the invoice screen shows each line on its own; the posted invoice nets earlier lines off correctly.
