# Softilo for E-commerce Brands

The Softilo core (ledger, VAT, stock, landed cost) plus sales channels, payout reconciliation and returns for UK brands
selling on Shopify and marketplaces. The plan, UK rules and roadmap are in [docs/plan.md](docs/plan.md).

## What works today

| Area | Features |
|---|---|
| **Channels** | Channel adapter interface; Shopify adapter for Admin API order JSON and Shopify Payments payouts (from files, no live credentials) |
| **Orders** | Paid orders become sales invoices to the channel's customer account, using the VAT the channel charged (checked to within 1p), and issue stock at weighted-average cost. Unknown SKUs, unpaid, non-GBP and out-of-stock orders are reported, not imported. Re-importing a file is safe |
| **Payouts** | Split into sales, refunds, fees (with VAT: UK VAT, reverse charge or exempt), reserves and adjustments; refused unless it reconciles to the penny; posts one balanced clearing journal and settles the invoices and credit notes it pays |
| **Returns** | Credit note and refund; each item restocked at the cost it left at or written off; refund of delivery; diminished-value deduction; refund-due-by date (14 days, Consumer Contracts Regulations 2013) |
| **Screens** | Channels (import orders, preview and post payouts), channel orders with margin after returns, order detail with return form, payouts with split and journal, returns with overdue refunds; plus every core screen |

## Layout

```
docs/plan.md      Plan: customers, UK rules (checked / unverified), module design, roadmap
domain/           @softilo-ecommerce/domain: pure rules and adapters, unit and property-based tests
api/              @softilo-ecommerce/api: Fastify module, ecom_*.sql migrations (RLS), end-to-end test, seed
web/              @softilo-ecommerce/web: Next.js app = core screens (linked by scripts/link-core.mjs) + e-commerce screens
fixtures/shopify/ Sample Shopify orders and payout used by tests, the seed and for trying the import screens
```

## Running it

From the repository root, after `pnpm install`:

```bash
pnpm turbo run build --filter=./packages/* --filter=@softilo/api --filter=@softilo-ecommerce/domain
```

```bash
pnpm --filter @softilo-ecommerce/api seed
```

Then start the `ecommerce-api` (port 4140) and `ecommerce-web` (port 3140) configurations from `.claude/launch.json`, or run the API on its own (port 4000 unless `API_PORT` is set):

```bash
pnpm --filter @softilo-ecommerce/api dev
```

The demo sign-in is at the top of [api/src/seed.ts](api/src/seed.ts). The embedded dev database is `.data/pglite-ecommerce`.

## Tests

```bash
pnpm turbo run test typecheck
```
