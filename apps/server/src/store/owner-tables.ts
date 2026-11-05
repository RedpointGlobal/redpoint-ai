/**
 * The 7.179 owner tables (thread_owners, api_key_owners), created EXPLICITLY on an
 * install that has the rest of the schema.
 *
 * The boot's general self-heal is drizzle-kit push, which adds missing tables. But
 * when the database also holds a table the schema doesn't know (a leftover from
 * another build), push asks — interactively — whether each new table is a rename of
 * it; with no terminal (a container, a service) that prompt fails, push still exits
 * 0, and the new tables are silently never created. So the owner tables, the one
 * upgrade every existing install takes, are created here with plain
 * CREATE TABLE IF NOT EXISTS, in the column shape schema.ts / schema.pg.ts declare.
 * Best effort: on a fresh database (no threads / api_keys yet) a failure is
 * ignored and the full push creates everything.
 */
import { sql } from "drizzle-orm";
import { db } from "./db.js";

const SQLITE = [
  "CREATE TABLE IF NOT EXISTS `thread_owners` (`thread_id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL, FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade)",
  "CREATE TABLE IF NOT EXISTS `api_key_owners` (`key_id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL, FOREIGN KEY (`key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade)",
];

const POSTGRES = [
  'CREATE TABLE IF NOT EXISTS "thread_owners" ("thread_id" uuid PRIMARY KEY NOT NULL REFERENCES "threads"("id") ON DELETE cascade, "user_id" text NOT NULL)',
  'CREATE TABLE IF NOT EXISTS "api_key_owners" ("key_id" uuid PRIMARY KEY NOT NULL REFERENCES "api_keys"("id") ON DELETE cascade, "user_id" text NOT NULL)',
];

export async function ensureOwnerTables(): Promise<void> {
  const postgres = !!process.env.DATABASE_URL;
  for (const ddl of postgres ? POSTGRES : SQLITE) {
    try {
      if (postgres) await db.execute(sql.raw(ddl));
      else db.run(sql.raw(ddl));
    } catch {
      // A fresh database (no threads / api_keys yet): the full push creates them.
    }
  }
}
