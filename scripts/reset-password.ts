// Resets any user's password from the command line — for the site owner.
// Uses DATABASE_URL from backend/.env, so it works against your Neon database.
//
//   npm run reset-password -- someone@email.com
//   npm run reset-password -- someone@email.com --password myNewPass123
//
// Without --password a temporary password is generated, and the user must choose
// a new one after logging in. Either way, all their old logins are signed out.
import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db";
import { users, memberships, messes } from "../src/db/schema";
import { hashPassword, makeTempPassword } from "../src/lib/auth";
import { explainDbError } from "../src/db/url";

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const b = (s: string) => `\x1b[1m${s}\x1b[0m`;

function usage(msg?: string): never {
  if (msg) console.error(r(`✖ ${msg}\n`));
  console.log(`Usage:
  npm run reset-password -- ${b("email@example.com")}
  npm run reset-password -- ${b("email@example.com")} --password ${b("newPassword")}`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const pi = args.indexOf("--password");
  let custom: string | null = null;
  if (pi !== -1) {
    custom = args[pi + 1] ?? null;
    if (!custom) usage("Write the new password after --password");
    if (custom.length < 6) usage("The password must be at least 6 characters");
    args.splice(pi, 2);
  }
  const email = (args[0] || "").trim().toLowerCase();
  if (!email || !email.includes("@")) usage("Give the account's email address");

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    console.error(r(`✖ No account with the email ${email}`));
    process.exitCode = 1;
    return;
  }

  const password = custom ?? makeTempPassword();
  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(password),
      mustChangePassword: custom ? false : true,
      tokenVersion: sql`${users.tokenVersion} + 1`,
    })
    .where(eq(users.id, user.id));

  const rows = await db
    .select({ name: messes.name, role: memberships.role, status: memberships.status })
    .from(memberships)
    .innerJoin(messes, eq(messes.id, memberships.messId))
    .where(eq(memberships.userId, user.id));
  const where = rows
    .filter((m) => m.status === "APPROVED")
    .map((m) => `${m.name} (${m.role === "ADMIN" ? "admin" : "member"})`)
    .join(", ");

  console.log(`
${g("✔ Password reset")}

  Name:      ${user.name}
  Email:     ${user.email}${where ? `\n  Messes:    ${where}` : ""}
  Password:  ${b(password)}

  ${custom ? "They can log in with this password now." : "Give them this temporary password. After logging in they must set a new one."}
  All their old logins have been signed out.
`);
}

main()
  .catch((err) => {
    console.error(r(`✖ Could not reset the password:\n  ${explainDbError(err)}`));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
