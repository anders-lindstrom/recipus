import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env — see README.",
  );
}

// One pool per process. Next's dev server reloads modules on edit, so without
// the global cache each save would leak a pool until Postgres refuses
// connections.
const globalForDb = globalThis as unknown as {
  recipusSql?: ReturnType<typeof postgres>;
};

const sql = globalForDb.recipusSql ?? postgres(url, { max: 10 });
if (process.env.NODE_ENV !== "production") globalForDb.recipusSql = sql;

export const db = drizzle(sql, { schema });
export { schema };
