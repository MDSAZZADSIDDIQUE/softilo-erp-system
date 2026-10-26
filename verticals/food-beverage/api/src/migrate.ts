import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, type Database } from "@softilo/db";

const FNB_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Core migrations first, then the food & beverage ones (all named fnb_*.sql). */
export async function migrateFoodBeverage(db: Database): Promise<string[]> {
  return [...await migrate(db), ...await migrate(db, FNB_MIGRATIONS)];
}
