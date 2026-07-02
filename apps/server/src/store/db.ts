import { join, dirname } from "path";
import { fileURLToPath } from "url";

let db: any;

if (process.env.DATABASE_URL) {
  // Production: PostgreSQL
  const pg = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("./schema.pg.js");
  const client = pg(process.env.DATABASE_URL);
  db = drizzle(client, { schema });
} else {
  // Development: SQLite
  const { drizzle } = await import("drizzle-orm/bun-sqlite");
  const schema = await import("./schema.js");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const SERVER_ROOT = join(__dirname, "../..");
  const DB_PATH =
    process.env.DB_FILE_NAME || join(SERVER_ROOT, "redpoint-ai.db");
  db = drizzle(DB_PATH, { schema });
}

export { db };
export type DB = typeof db;
