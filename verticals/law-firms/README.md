# Softilo for Law Firms

Client money and matter accounting for small and mid-sized law firms in England and Wales, on the shared Softilo ledger.
The plan, rules and roadmap are in [docs/plan.md](docs/plan.md).

## What works today

| Area | Features |
|---|---|
| **Practice** | Clients (core contacts with law details and due-diligence status), fee earners with hourly rates, matters with a client and an office ledger each |
| **Client money** | A client bank account kept apart from office. Receipts into client account per matter. Payments out are refused if they would overdraw that matter's client ledger on their date or any later date (in the API, and again by a database trigger) |
| **Billing** | Time in six-minute units, fee notes with VAT on the total, and client-to-office transfers against a fee note (never before the bill is dated, never more than is billed or held) |
| **Compliance** | Three-way reconciliation (bank statement vs. client cash book vs. sum of client ledgers, plus client money held), saved and signed off once by an owner or admin. Shows when the next one is due under the five-week rule |
| **Accounting** | Core VAT, reports, journals, chart of accounts, settings and audit screens, reused as they are |

## Layout

```
domain/   @softilo-law/domain  pure rules: time units, client-money guards, postings, reconciliation (+ tests)
api/      @softilo-law/api     law_*.sql migrations, /api/law/* routes on top of the core server, e2e test, seed
web/      @softilo-law/web     Next.js app reusing the core UI kit and brand tokens from apps/web
docs/     plan.md
```

## Running it

From the repository root, after `pnpm install` and building the core packages (`pnpm turbo run build --filter=./packages/* --filter=@softilo/api --filter=@softilo-law/domain`):

```bash
pnpm --filter @softilo-law/api seed
```

```bash
pnpm --filter @softilo-law/api dev
```

```bash
pnpm --filter @softilo-law/web dev
```

Then open http://localhost:3060 (the API runs on port 4060). The demo sign-in details are at the top of [api/src/seed.ts](api/src/seed.ts). Without `DATABASE_URL`, data lives in `.data/pglite-law`, kept apart from the core demo.
