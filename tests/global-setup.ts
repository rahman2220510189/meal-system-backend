import path from "path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

// Fresh schema for every test run
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL || "postgresql://postgres@localhost:5432/meal_test";
  const pool = new Pool({ connectionString: url, max: 1 });
  await pool.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await migrate(drizzle(pool), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  await pool.end();
}
