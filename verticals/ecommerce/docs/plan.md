# Softilo for E-commerce Brands — Plan

**Edition:** E-commerce Brands (`verticals/ecommerce/`)
**Builds on:** the Softilo core in `packages/domain`, `packages/db`, `apps/api` and `apps/web` (see the root README and `docs/architecture-and-mvp-plan.md`).
**Status:** Draft v0.1, 26 Oct 2026. The first vertical slice (Shopify order import, payout reconciliation, returns) is built on this branch.

Regulatory notes are marked:
- **[checked]**: confirmed against a primary source (legislation.gov.uk or GOV.UK/HMRC) or several consistent secondary sources while writing this plan.
- **[unverified]**: from memory or one secondary source. It must be confirmed with HMRC guidance or the customer's accountant before we rely on it in code or marketing.

---

## 1. Who it is for

UK brands, typically £1m–£30m turnover and 5–80 staff, that sell their own products direct to consumers and through marketplaces:

| Segment | Typical set-up | Why they outgrow their current tools |
|---|---|---|
| **DTC-first brands** (beauty, apparel, homeware, pet, supplements) | Shopify or WooCommerce store, Shopify Payments/Stripe/PayPal, 3PL or own small warehouse | Xero plus a connector (A2X, Link My Books) plus an inventory app (Cin7, Linnworks, Unleashed). Three systems, so stock value and margin per order never agree |
| **Marketplace-heavy sellers** | Amazon UK (FBA and own fulfilment), eBay, TikTok Shop, sometimes OnBuy/ManoMano | Payouts net of dozens of fee types; reconciling settlements to bank and VAT by hand each month |
| **Importing brands** | Manufacture in China, Turkey, Portugal or India; ship by sea to a UK 3PL | Landed cost (freight, duty, postponed VAT) handled in spreadsheets, so gross margin per SKU is guesswork. Softilo core already solves this |
| **Brands selling into the EU and Northern Ireland** | Ship parcels from GB to EU consumers, or hold stock in NI | IOSS/OSS registrations and returns, NI rules under the Windsor Framework |

Buyer: founder or finance lead, often with an outsourced bookkeeper/accountant. Users: ops/customer service (returns), finance (payouts, VAT), warehouse (stock).

## 2. Pain points we solve

1. **Payouts don't match sales.** A Shopify Payments or Amazon payout is net of fees, refunds, reserves and chargebacks. Bookkeepers post the net figure, so sales, fees and VAT are all wrong. → *Payout reconciliation that splits every payout into gross sales, refunds, fees (with their VAT), reserves and adjustments, and posts one balanced clearing journal.*
2. **Order-level margin is invisible.** Revenue sits in one system and stock cost in another. → *Each channel order becomes a sales invoice that issues stock at weighted-average landed cost in the same transaction, so margin per order, SKU and channel comes straight from the ledger.*
3. **Returns are a black hole.** Refunds go out from the channel, but nobody restocks the item or writes off the damaged one, so stock and COGS drift. → *A returns flow that raises a credit note, refunds, and either restocks at original cost or writes the item off, and tracks the 14-day refund deadline.*
4. **VAT across channels is confusing.** Different VAT treatment for UK sales, marketplace-collected VAT, EU sales via OSS/IOSS, reverse-charged platform fees. → *VAT treatment decided per order and per fee line by rules in the domain package, feeding the core 9-box return (and later OSS/IOSS returns).*
5. **Too many tools.** → *One system for channels, stock, landed cost and the books, with no Xero/A2X/Cin7 needed.*

## 3. UK rules that apply

### 3.1 VAT on UK sales by a UK-established brand
- The brand is the supplier and accounts for VAT on its own B2C sales, including sales through marketplaces. The marketplace "deemed supplier" rule does **not** currently apply to UK-established sellers whose goods are in the UK at the point of sale. **[checked: VATREG37210]**
- VAT is due on the consideration the customer pays, including delivery charged to them. Discounts reduce the taxable amount. Vouchers need care: single-purpose vouchers are taxed when issued, multi-purpose vouchers when redeemed. **[unverified: voucher detail, VAT Notice 700/7]**
- **Watch item:** HMRC and HM Treasury consulted (June to August 2026) on extending marketplace liability to UK-established sellers whose goods are in the UK. If enacted, the marketplace would collect the VAT and the brand's supply to the marketplace would change treatment. **[unverified: secondary source only; outcome not known]** The design copes with this already: VAT treatment is a per-order field (`seller` or `marketplace`), not a per-channel assumption.

### 3.2 Overseas sellers and online marketplaces (since 1 January 2021)
- For goods **outside the UK at the point of sale**, in consignments of **£135 or less** (whole consignment, not per item; excise goods excluded), the seller (or the marketplace if one facilitates the sale) charges UK VAT at the point of sale instead of import VAT at the border. **[checked: VATREG37210; GOV.UK OMP guidance]**
- When a marketplace facilitates such a sale, the marketplace is the **deemed supplier** to the consumer. The overseas seller is treated as making a zero-rated supply to the marketplace. **[checked: VATREG37210]**
- For goods **already in the UK** sold by an **overseas** seller through a marketplace, the marketplace is the deemed supplier regardless of value. **[checked: VATREG37210]**
- HMRC announced a review of the £135 marketplace rules in April 2025 (shell UK companies, misuse of UK VAT numbers). **[unverified: outcome not found]**
- Above £135, normal import rules apply: import VAT (postponed VAT accounting via the core PVA feature) and customs duty.
- **Customs duty relief for low-value imports (£135 or less) is being removed**, announced at Autumn Budget 2025, by March 2029 at the latest, with sellers or marketplaces liable for the duty. **[unverified: secondary sources; no final legislation seen]** This affects brands that ship direct from overseas factories to UK consumers. Our landed-cost engine will need a duty line per consignment.

**What Softilo does:** each order records its VAT treatment: `seller` (we post output VAT), `marketplace` (the marketplace accounts for VAT; we post the sale outside the scope of our return, or zero-rated to the marketplace for overseas sellers), or `export`. Phase 2 adds rules that pick the treatment from seller establishment, where the goods are and consignment value.

### 3.3 Selling into the EU and Northern Ireland
- **GB → EU consumers:** goods are exports from the UK (zero-rated with evidence of export). In the EU they are imports. For consignments up to €150 the brand can register for **IOSS** (through an EU intermediary for non-EU sellers) and charge EU VAT at checkout; otherwise the customer pays import VAT and fees on delivery. **[unverified: confirm current IOSS intermediary rules]**
- **EU temporary customs duty:** the EU plans a flat €3 duty per item type on low-value parcels from 1 July 2026, ahead of removing its €150 duty exemption. **[unverified: secondary source]**
- **NI → EU consumers (Windsor Framework):** NI goods sales to EU consumers are intra-EU distance sales. Above the EU-wide **€10,000** threshold (about £8,818) the seller charges the destination country's VAT, either by registering in each country or through the **OSS Union scheme** via HMRC (XI VAT number). GB-only businesses cannot use HMRC's OSS for this; they would register in an EU state. **[checked: several consistent sources, mostly 2021; confirm current GOV.UK page]**
- **GB → NI** B2C goods movements are UK domestic supplies for VAT (standard UK VAT), with customs processes (UK Internal Market Scheme, "not at risk" goods) for B2B. **[unverified]**
- Boxes 2, 8 and 9 of the VAT return relate to NI/EU goods movements. The core does not fill them yet. This edition must, for NI-established customers.

### 3.4 Consumer returns (Consumer Contracts Regulations 2013)
- For distance sales, the consumer may cancel within **14 days after the goods are delivered**. If the trader did not give the required cancellation information, this extends by up to 12 months. **[checked: legislation.gov.uk explanatory note; regulations 29–31]**
- The trader must refund **within 14 days** of receiving the goods back, or of the consumer supplying evidence of having sent them back, whichever is earlier (or of being told of the cancellation if no goods were supplied or the trader offered to collect). **[checked: regulation 34]**
- The refund covers the price **and the original standard delivery charge** (not the extra cost of premium delivery). **[checked]**
- The trader may deduct for **diminished value** caused by handling beyond what is needed to establish the nature, characteristics and functioning of the goods. **[checked]**
- The consumer pays return postage unless the trader agreed to pay or did not tell them they must. **[checked: regulation 35]**
- Faulty goods also carry Consumer Rights Act 2015 remedies (30-day short-term right to reject, then repair/replace/price reduction). **[unverified: detail]**
- **What Softilo does:** each return records the received date and computes a **refund-due-by date** (received + 14 days). It flags overdue refunds and records any diminished-value deduction separately from the refund, so customer service can justify it.

### 3.5 Platform reporting rules (marketplaces reporting sellers to HMRC)
- Since **1 January 2024**, digital platforms (Amazon, eBay, Etsy, Vinted, TikTok Shop, etc.) collect seller data and report sellers' income to HMRC each year under the OECD Model Reporting Rules. The first reports were due by **31 January 2025**. **[checked: consistent secondary sources, ICAEW/ATT]**
- Sellers of goods are excluded only if they make **fewer than 30 sales and receive no more than €2,000** (about £1,700) in the year; every brand on this product will be reported. **[unverified: exact threshold wording differs between sources; check HMRC guidance]**
- **What Softilo does:** a "platform reporting reconciliation" report that sums gross consideration, fees, commissions and taxes withheld **per platform per calendar year (and quarter)**, from the same order and payout data that posts the ledger, so the brand can match what HMRC will receive from Amazon/eBay against its own return. Planned for Phase 2.

### 3.6 Other rules to keep in view
- **MTD for VAT** (core): every channel's VAT flows into the single 9-box return the core already builds.
- **Producer responsibility for packaging (EPR)**: large producers report packaging data. We would need packaging weights per SKU. **[unverified: thresholds and reporting dates]**
- **WEEE / batteries** for electronics brands, **GPSR** (EU General Product Safety Regulation) for sales into the EU/NI: product-level data, not accounting. Later.
- **DMCC Act 2024**: drip pricing, fake reviews and subscription contract rules. Mostly storefront issues, but subscription refunds will touch returns. **[unverified: commencement dates]**

## 4. Module design on top of the shared core

```
verticals/ecommerce/
  docs/plan.md               this document
  domain/  (@softilo-ecommerce/domain)   pure TypeScript, no I/O
    channels.ts              ChannelAdapter interface; ChannelOrder / ChannelPayout types
    adapters/shopify.ts      Shopify Admin order JSON + Shopify Payments payout JSON → channel types
    orders.ts                channel order → invoice lines (net/VAT split, discounts, shipping), VAT treatment
    payouts.ts               payout split (sales/refunds/fees/VAT/reserves) + clearing journal posting rule
    returns.ts               return planning (pro-rata credit, deduction, restock vs write-off) + posting rule, CCR refund deadline
  api/     (@softilo-ecommerce/api)      Fastify module registered into the core server
    migrations/ecom_001_*.sql   channel, order, payout, return tables; RLS on all; append-only payout lines
    src/module.ts            routes under /api/ecommerce/*
    src/main.ts              runs core + vertical migrations, starts the core server with this module
    fixtures/                Shopify order and payout JSON used by tests and the demo
  web/     (@softilo-ecommerce/web)      Next.js app: the core screens plus the e-commerce screens
```

### 4.1 How it uses the core

| Need | Core piece reused | E-commerce addition |
|---|---|---|
| Order → revenue, VAT, COGS | `sales_invoices`, `sales_invoice_lines`, `stockOut` (weighted-average landed cost), `postSalesInvoice` | `postChannelSale` takes the VAT the channel actually charged (checked within 1p of the computed VAT per line) so the invoice total always equals what the shopper paid |
| Channel owes us the money | Trade debtors control account, one customer contact per channel | Payout settles the orders (`amount_paid`) and credit notes it contains |
| Payout | `postJournal`, VAT entries, core VAT codes (`RC20` for reverse-charged Shopify fees, `S20` for Amazon fees, `EX` for exempt payment fees) | `postPayoutClearing`: Dr Bank, Dr Fees, Dr/Cr VAT, Cr/Dr Debtors, Dr/Cr Reserves; refuses a payout whose lines don't add up to the bank amount |
| Returns | Credit notes (`kind = 'credit'`), `stockIn` (`return` movements) | Restock at the original issue cost; write-off reclassifies the cost from COGS to "Returns written off"; CCR refund deadline |
| Integrity | Balanced-entry trigger, append-only ledger, stock vs. ledger report | Payout lines are append-only; an order can only be settled once |

### 4.2 Accounts added per tenant (lazily, on first use)
| Code | Name | Use |
|---|---|---|
| 1160 | Marketplace reserves held | Amounts a channel holds back from a payout |
| 5300 | Returns written off | Cost of returned goods that cannot be resold |
| 6100 | Marketplace and payment fees | Channel commissions, payment processing, FBA fees |

### 4.3 Channel adapter interface
```ts
interface ChannelAdapter {
  kind: "shopify" | "woocommerce" | "amazon" | "ebay" | "tiktok";
  parseOrders(payload: unknown): ChannelOrder[];      // file or webhook body → normalised orders
  parsePayout(payload: unknown): ChannelPayout;       // settlement file or API body → normalised payout
}
```
Adapters are pure functions over the channel's own format, so they can be tested from fixture files with no credentials. Live connections (OAuth, webhooks, polling via the outbox/pg-boss worker) wrap the same adapter later. Idempotency: orders are unique per `(channel, external id)` and payouts per `(channel, external id)`, so re-importing a file is safe.

### 4.4 VAT treatment per order
`seller`: standard UK VAT from the channel's tax lines (S20/R5/Z0 by rate). `marketplace`: the marketplace is deemed supplier; we post the sale outside the scope of our UK VAT (code OS) with no output VAT. `export`: zero-rated (Z0), needs evidence of export. Phase 2 adds `oss` and `ioss` with destination-country rates and their own returns.

## 5. Roadmap

### Phase E1: first vertical slice (built on this branch)
- Channel adapter interface; Shopify order import from JSON (orders.json from the Admin API format).
- Orders become sales invoices against the channel's customer, issuing stock at weighted-average cost. Unknown SKUs and non-GBP orders are reported, not imported.
- Shopify Payments payout reconciliation: split into charges, refunds, fees (reverse-charged), reserves and adjustments. A balanced clearing journal settles the orders and credit notes in the payout.
- Returns: credit note with refund, restock at original cost or write-off, refund-due-by date.
- Screens: channels, orders, order import, payouts (with split), returns.

### Phase E2: channels and marketplaces (~3 months)
- Amazon UK settlement reports (flat file V2) and FBA inventory as a separate warehouse; eBay Managed Payments; TikTok Shop; WooCommerce (REST JSON).
- Live connections: Shopify OAuth app and webhooks, Amazon SP-API, eBay; all through the outbox worker with retries.
- Multi-currency orders and payouts (EUR/USD stores) using core FX.
- Platform reporting reconciliation report per platform per year.
- Bank reconciliation: auto-match payout bank lines to the payout journal.
- Gift cards and vouchers (single- and multi-purpose) and store credit as a liability.

### Phase E3: cross-border VAT (~2–3 months)
- Rules engine picking VAT treatment per order (establishment, goods location, consignment value, destination).
- IOSS and OSS returns with destination-country VAT rates; NI boxes 2, 8 and 9 on the UK return.
- Low-value import duty once the UK removes the £135 relief (duty per consignment through landed cost).

### Phase E4: operations (~3 months)
- Bundles/kits sold as one SKU, issuing component stock.
- 3PL stock files (Huboo, Peak, Zendbox and others) as stock-count adjustments; FBA reconciliations (lost/damaged reimbursements).
- Carrier labels (Royal Mail Click & Drop, Evri, DPD) behind adapters; returns labels.
- Contribution margin per order: product cost, fees, shipping and packaging, ad spend imported per channel.

## 6. Risks
| Risk | Mitigation |
|---|---|
| Channel formats change | Adapters are small and fixture-tested; keep raw payloads on each order for re-processing |
| VAT treatment edge cases (marketplace liability changes in 2026–29) | VAT treatment is data on each order, set by a dated rules module; accountant review screen |
| Volume (thousands of orders a day) | Summarised daily invoices per channel as an option (one invoice per channel per day) while keeping order detail in `ecom_orders` |
| Payout rounding differences | The payout must reconcile to the penny or it is refused; differences are posted explicitly as adjustments with a reason |
