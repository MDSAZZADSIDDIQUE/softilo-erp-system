# Softilo for Pharmaceutical & Medical Wholesale

The Softilo core (ledger, VAT, purchasing, sales, landed cost) plus Good Distribution Practice batch control for UK pharmaceutical and medical-device wholesalers. The plan, UK rules and roadmap are in [docs/plan.md](docs/plan.md).

## What works today

- **Goods in with batches:** batch number and expiry are recorded per receipt line. Month-only expiries count as the last day of that month. Stock arrives in quarantine.
- **Responsible Person decisions:** a named RP can release, reject, re-quarantine or recall a batch. Each decision is recorded with who made it, when and why.
- **FEFO dispatch:** only released, in-date batches are sold, earliest expiry first, respecting each customer's minimum remaining shelf life. The dispatch also raises the core sales invoice, posting cost of sales and VAT.
- **Customer licence check:** POM and P medicines are supplied only to customers with a verified, in-date entitlement (WDA(H), GPhC premises, GMC, dispensing doctor or NHS trust). Schedule 2 and 3 controlled drugs need a CD entitlement as well.
- **Recall trace:** for any batch, shows every receipt, every customer supplied and what is still on hand. One action recalls all receipts of that batch.
- **Integrity:** batch quantities always agree with the core stock ledger.

## Layout

```
domain/   @softilo/pharma-domain  pure rules: expiry, batch status, FEFO, customer eligibility (+ tests)
api/      @softilo/pharma-api     core API + pharma module; migrations/pharma_*.sql; e2e test; seed
web/      @softilo/pharma-web     Next.js: core screens re-exported + GDP screens (port 3010)
```

## Running it

From the repository root, after `pnpm install` and building the core packages:

```bash
pnpm turbo run build --filter=./packages/* --filter=@softilo/pharma-domain
```

```bash
pnpm --filter @softilo/pharma-api seed
```

```bash
pnpm --filter @softilo/pharma-api dev
```

```bash
pnpm --filter @softilo/pharma-web dev
```

Then open http://localhost:3010. The API listens on port 4010 and uses its own embedded database in `.data/pglite-pharma`. The demo sign-in details are at the top of [api/src/seed.ts](api/src/seed.ts).

## Tests

```bash
pnpm --filter @softilo/pharma-domain --filter @softilo/pharma-api test
```
