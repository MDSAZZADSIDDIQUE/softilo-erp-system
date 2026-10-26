# Softilo Food & Beverage edition

Softilo for UK food and drink wholesalers, importers and small producers. It is the shared Softilo core (ledger, VAT, purchasing, landed cost, sales, banking) plus batch traceability. The plan, UK rules and roadmap are in [docs/plan.md](docs/plan.md).

```
domain/      @softilo/fnb-domain  FEFO allocation, use-by/best-before rules, recall trace summary (pure TS, tested)
api/         @softilo/fnb-api     /api/fnb/* routes registered into the core server, fnb_*.sql migrations, end-to-end test, demo seed
web/         @softilo/fnb-web     Next.js app: every core screen plus Food safety (batches, expiry, recall, food settings)
```

## Running it

From the repository root, after `pnpm install`:

```bash
pnpm --filter "./packages/*" build
```

```bash
pnpm --filter @softilo/fnb-api seed
```

```bash
pnpm --filter @softilo/fnb-api dev
```

```bash
pnpm --filter @softilo/fnb-web dev
```

Then open http://localhost:3010. The API runs on port 4010 with its own embedded database in `.data/pglite-fnb`. The demo sign-in is at the top of [api/src/seed.ts](api/src/seed.ts).

## Tests

`pnpm test` and `pnpm typecheck` at the root include this edition. `api/src/e2e.test.ts` runs receiving, FEFO invoicing, the use-by block, returns, recall trace and write-off over HTTP, and checks after each step that the books balance and that batches add up to stock.
