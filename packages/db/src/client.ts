import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

export type Row = Record<string, unknown>;

/** A connection or transaction that can run parameterised SQL. */
export interface Sql {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]>;
  /** Run a multi-statement script with no parameters. */
  exec(text: string): Promise<void>;
}

export interface Database extends Sql {
  /** Run `fn` in a transaction as the platform (owner) role. Used for sign-up, sign-in and migrations. */
  system<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  /** Run `fn` in a transaction as the restricted app role, scoped to one tenant by RLS. */
  tenant<T>(tenantId: string, fn: (tx: Sql) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const APP_ROLE = process.env.DATABASE_APP_ROLE ?? "softilo_app";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function enterTenant(tx: Sql, tenantId: string): Promise<void> {
  if (!UUID.test(tenantId)) throw new Error("Invalid tenant id");
  await tx.query(`SET LOCAL ROLE ${APP_ROLE}`);
  await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

/** Embedded Postgres (WASM) for development and tests. Same SQL, RLS and triggers as production. */
export async function createPgliteDatabase(dataDir?: string): Promise<Database> {
  // Keep numeric, bigint and date as strings, matching the pg driver configuration below.
  // PGlite only honours parsers passed per query, so every query gets them.
  const asText = (v: string) => v;
  const opts = { parsers: { 1700: asText, 20: asText, 1082: asText } };
  const db = new PGlite(dataDir);
  await db.waitReady;
  // PGlite is a single connection: serialise transactions so they never interleave.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };
  const wrap = (tx: { query: PGlite["query"]; exec: PGlite["exec"] }): Sql => ({
    async query<T extends Row>(text: string, params?: unknown[]) {
      return (await tx.query<T>(text, params, opts)).rows;
    },
    async exec(text: string) {
      await tx.exec(text);
    },
  });
  return {
    query: (text, params) => serial(async () => (await db.query<never>(text, params, opts)).rows),
    system: (fn) => serial(() => db.transaction((tx) => fn(wrap(tx)))),
    tenant: (tenantId, fn) => serial(() => db.transaction(async (tx) => {
      const sql = wrap(tx);
      await enterTenant(sql, tenantId);
      return fn(sql);
    })),
    exec: (sql) => serial(async () => { await db.exec(sql); }),
    close: () => db.close(),
  };
}

/** Production: a pooled connection to a real Postgres server. */
export function createPgDatabase(connectionString: string): Database {
  // Return numeric/bigint as strings so money never passes through a float.
  pg.types.setTypeParser(1700, (v) => v);
  pg.types.setTypeParser(20, (v) => v);
  pg.types.setTypeParser(1082, (v) => v); // date as YYYY-MM-DD
  const pool = new pg.Pool({ connectionString, max: 20 });
  const run = async <T>(enter: ((tx: Sql) => Promise<void>) | null, fn: (tx: Sql) => Promise<T>) => {
    const client = await pool.connect();
    const sql: Sql = {
      query: async (text, params) => (await client.query(text, params as unknown[])).rows,
      exec: async (text) => { await client.query(text); },
    };
    try {
      await client.query("BEGIN");
      if (enter) await enter(sql);
      const result = await fn(sql);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  };
  return {
    query: async (text, params) => (await pool.query(text, params as unknown[])).rows,
    system: (fn) => run(null, fn),
    tenant: (tenantId, fn) => run((tx) => enterTenant(tx, tenantId), fn),
    exec: async (sql) => { await pool.query(sql); },
    close: () => pool.end(),
  };
}

export async function createDatabase(opts: { url?: string; dataDir?: string } = {}): Promise<Database> {
  return opts.url ? createPgDatabase(opts.url) : createPgliteDatabase(opts.dataDir);
}
