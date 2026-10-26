import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgliteDatabase, type Database, type Sql } from "./client.js";
import { newId } from "./ids.js";
import { migrate } from "./migrate.js";

let db: Database;
const tenantA = newId();
const tenantB = newId();

async function seedTenant(id: string, name: string) {
  await db.system(async (tx) => {
    await tx.query("INSERT INTO tenants (id, name) VALUES ($1, $2)", [id, name]);
  });
  await db.tenant(id, async (tx) => {
    for (const [code, type, ctl] of [["1200", "asset", false], ["4000", "income", false], ["1100", "asset", true]] as const) {
      await tx.query("INSERT INTO accounts (tenant_id, code, name, type, is_control) VALUES ($1,$2,$2,$3,$4)", [id, code, type, ctl]);
    }
  });
}

async function postEntry(tx: Sql, tenant: string, lines: [string, string, string][], opts: { date?: string; source?: string } = {}) {
  const entry = newId();
  await tx.query(
    "INSERT INTO journal_entries (id, tenant_id, number, date, memo, source_type) VALUES ($1,$2,$3,$4,'t',$5)",
    [entry, tenant, `J-${entry.slice(0, 8)}`, opts.date ?? "2026-06-01", opts.source ?? "test"],
  );
  let n = 1;
  for (const [account, debit, credit] of lines) {
    await tx.query(
      "INSERT INTO journal_lines (id, tenant_id, entry_id, line_no, account_code, debit, credit) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [newId(), tenant, entry, n++, account, debit, credit],
    );
  }
  return entry;
}

beforeAll(async () => {
  db = await createPgliteDatabase();
  await migrate(db);
  await seedTenant(tenantA, "A Ltd");
  await seedTenant(tenantB, "B Ltd");
});

afterAll(async () => db.close());

describe("database integrity", () => {
  it("is idempotent to migrate twice", async () => {
    expect(await migrate(db)).toEqual([]);
  });

  it("accepts a balanced entry", async () => {
    await db.tenant(tenantA, (tx) => postEntry(tx, tenantA, [["1200", "100.00", "0"], ["4000", "0", "100.00"]]));
  });

  it("rejects an unbalanced entry at commit", async () => {
    await expect(db.tenant(tenantA, (tx) => postEntry(tx, tenantA, [["1200", "100.00", "0"], ["4000", "0", "99.99"]])))
      .rejects.toThrow(/does not balance/);
  });

  it("isolates tenants with row-level security", async () => {
    const seenByB = await db.tenant(tenantB, (tx) => tx.query("SELECT * FROM journal_lines"));
    expect(seenByB).toHaveLength(0);
    const seenByA = await db.tenant(tenantA, (tx) => tx.query("SELECT * FROM journal_lines"));
    expect(seenByA.length).toBeGreaterThan(0);
  });

  it("refuses to write rows for another tenant", async () => {
    await expect(db.tenant(tenantB, (tx) =>
      tx.query("INSERT INTO contacts (id, tenant_id, kind, name) VALUES ($1,$2,'customer','x')", [newId(), tenantA]),
    )).rejects.toThrow(/row-level security/);
  });

  it("makes the ledger append-only for the app role", async () => {
    await expect(db.tenant(tenantA, (tx) => tx.query("UPDATE journal_lines SET debit = 1"))).rejects.toThrow();
    await expect(db.tenant(tenantA, (tx) => tx.query("DELETE FROM journal_entries"))).rejects.toThrow();
  });

  it("makes the ledger append-only even for the owner", async () => {
    await expect(db.system((tx) => tx.query("DELETE FROM journal_lines"))).rejects.toThrow(/append-only/);
  });

  it("blocks postings on or before the lock date", async () => {
    await db.tenant(tenantA, (tx) => tx.query("UPDATE tenants SET lock_date = '2026-03-31'"));
    await expect(db.tenant(tenantA, (tx) =>
      postEntry(tx, tenantA, [["1200", "1.00", "0"], ["4000", "0", "1.00"]], { date: "2026-03-31" }),
    )).rejects.toThrow(/locked/);
  });

  it("blocks manual journals on control accounts", async () => {
    await expect(db.tenant(tenantA, (tx) =>
      postEntry(tx, tenantA, [["1100", "5.00", "0"], ["4000", "0", "5.00"]], { source: "manual" }),
    )).rejects.toThrow(/control account/);
  });

  it("hides password hashes from the app role", async () => {
    await expect(db.tenant(tenantA, (tx) => tx.query("SELECT password_hash FROM users"))).rejects.toThrow(/permission/);
  });

  it("returns money and dates as strings", async () => {
    const [row] = await db.tenant(tenantA, (tx) =>
      tx.query<{ debit: string; date: string }>("SELECT l.debit, e.date FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id LIMIT 1"));
    expect(typeof row!.debit).toBe("string");
    expect(row!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
