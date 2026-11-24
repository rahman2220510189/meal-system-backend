// Applies all pending migrations from the /drizzle folder.
// Uses DIRECT_URL (non-pooled) when available, as recommended for Neon.
import "dotenv/config";
import path from "path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

async function main() {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error("✖ DATABASE_URL / DIRECT_URL is not set in backend/.env");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 20_000 });
  const db = drizzle(pool);
  const migrationsFolder = path.join(__dirname, "..", "..", "drizzle");
  console.log("→ Applying database migrations…");
  await migrate(db, { migrationsFolder });
  await pool.end();
  console.log("✔ Database is up to date");
}

main().catch((err) => {
  console.error("✖ Migration failed:", err.message || err);
  process.exit(1);
});
