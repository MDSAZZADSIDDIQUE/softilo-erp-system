import { createDatabase } from "./client.js";
import { migrate } from "./migrate.js";

const db = await createDatabase({ url: process.env.DATABASE_URL || undefined, dataDir: process.env.PGLITE_DIR });
const ran = await migrate(db);
console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Database is up to date");
await db.close();
