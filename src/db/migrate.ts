// Applies all pending migrations from the /drizzle folder.
// Uses DIRECT_URL (non-pooled) when available, as recommended for Neon.
import "dotenv/config";
import path from "path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { cleanDbUrl, explainDbError } from "./url";

async function main() {
  const which = process.env.DIRECT_URL ? "DIRECT_URL" : "DATABASE_URL";
  const url = cleanDbUrl(process.env.DIRECT_URL || process.env.DATABASE_URL);
  if (!url) {
    console.error("✖ DATABASE_URL / DIRECT_URL is not set (backend/.env locally, or Environment on Render).");
    process.exit(1);
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    console.error(`✖ ${which} must start with postgresql:// — it currently starts with "${url.slice(0, 12)}…"`);
    process.exit(1);
  }
  let host = "?";
  try {
    host = new URL(url).hostname;
  } catch {
    console.error(`✖ ${which} is not a valid URL. Copy it again from Neon → Connect.`);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 30_000 });
  console.log(`→ Connecting to database (${which}, host ${host})…`);
  try {
    await pool.query("select 1");
  } catch (err) {
    console.error(`✖ Could not connect to the database:\n  ${explainDbError(err)}`);
    await pool.end().catch(() => {});
    process.exit(1);
  }

  console.log("→ Applying database migrations…");
  try {
    await migrate(drizzle(pool), { migrationsFolder: path.join(__dirname, "..", "..", "drizzle") });
  } catch (err) {
    console.error(`✖ Migration failed:\n  ${explainDbError(err)}`);
    await pool.end().catch(() => {});
    process.exit(1);
  }
  await pool.end();
  console.log("✔ Database is up to date");
}

main();
