import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, type Database } from "@softilo/db";

export { registerRecruitment, recAccountsFor } from "./recruitment.js";

export const RECRUITMENT_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Core schema first, then the recruitment tables. */
export async function migrateRecruitment(db: Database): Promise<string[]> {
  return [...await migrate(db), ...await migrate(db, RECRUITMENT_MIGRATIONS)];
}
