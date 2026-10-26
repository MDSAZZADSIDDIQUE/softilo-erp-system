# Softilo for Light Manufacturing

The Softilo core (ledger, VAT, stock, purchasing, sales, banking) plus production costing for UK makers and assemblers. The product plan, UK rules and roadmap are in [docs/plan.md](docs/plan.md).

```
domain/   @softilo/mfg-domain  Pure rules: BOM requirements, cycle checks, cost roll-up, WIP postings, completion costing, MRP
api/      @softilo/mfg-api     mfg_*.sql migrations (RLS), /api/mfg/* routes, the edition server (core + manufacturing), demo seed
web/      @softilo/mfg-web     The edition web app: every core screen (re-exported from apps/web) plus a Manufacturing section
```

## Running it

```bash
pnpm install
```

```bash
pnpm turbo run build --filter=@softilo/mfg-api^...
```

```bash
pnpm --filter @softilo/mfg-api seed
```

Then start `mfg-api` (port 4030) and `mfg-web` (port 3030) from `.claude/launch.json`, or run `pnpm --filter @softilo/mfg-api dev` and `pnpm --filter @softilo/mfg-web dev`. The demo sign-in is at the top of [api/src/seed.ts](api/src/seed.ts). The edition keeps its embedded database in `.data/pglite-mfg`, separate from the core demo.

If core adds or removes a screen, regenerate the re-exports with `pnpm --filter @softilo/mfg-web link-core`.

## How value flows

| Step | Journal |
|---|---|
| Issue components | Dr Work in progress (1002), Cr Stock (1001), at weighted-average cost |
| Book time | Dr WIP, Cr Labour absorbed (5400) and Overheads absorbed (5410), at work-centre standard rates |
| Complete good units | Dr Stock, Cr WIP. The share of WIP is WIP × units ÷ units still to make |
| Scrap units | Dr Production scrap (5300), Cr WIP |
| Close with WIP left and nothing made | Dr Production variances (5310), Cr WIP |

`GET /api/mfg/integrity` checks that the WIP account equals the sum of works-order transactions and that no closed order holds WIP. The core integrity report still checks stock against the ledger.
