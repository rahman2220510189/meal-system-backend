// Creates a demo mess with sample data so you can try the site.
// Login: demo@mealsystem.app / demo1234
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db";
import { users, messes, memberships, months, mealEntries, bazars, deposits, fixedCosts, bazarDuties } from "../src/db/schema";
import { hashPassword, makeJoinCode } from "../src/lib/auth";
import { createMonth } from "../src/services/months";
import { currentYearMonthDhaka, todayDhaka, monthStart, addDays } from "../src/lib/dates";
import { and } from "drizzle-orm";

const people = [
  { name: "রাকিব হাসান", email: "demo@mealsystem.app", admin: true },
  { name: "তানভীর আহমেদ", email: "tanvir@mealsystem.app" },
  { name: "সাকিব রহমান", email: "sakib@mealsystem.app" },
  { name: "নাঈম ইসলাম", email: "naim@mealsystem.app" },
  { name: "ফাহিম চৌধুরী", email: "fahim@mealsystem.app" },
  { name: "আরিফ হোসেন", email: "arif@mealsystem.app" },
];

async function main() {
  const [exists] = await db.select().from(users).where(eq(users.email, people[0].email));
  if (exists) {
    console.log("Demo data already exists. Login: demo@mealsystem.app / demo1234");
    return pool.end();
  }
  const pw = await hashPassword("demo1234");
  const [mess] = await db.insert(messes).values({ name: "শান্তিনগর ব্যাচেলর মেস", code: makeJoinCode() }).returning();
  const mids: string[] = [];
  for (const p of people) {
    const [u] = await db.insert(users).values({ name: p.name, email: p.email, passwordHash: pw }).returning();
    const [m] = await db
      .insert(memberships)
      .values({ messId: mess.id, userId: u.id, role: p.admin ? "ADMIN" : "MEMBER", status: "APPROVED", approvedAt: new Date() })
      .returning();
    mids.push(m.id);
  }
  const { year, month } = currentYearMonthDhaka();
  const m = await db.transaction((tx) =>
    createMonth(tx, mess.id, { year, month, mealsPerDay: 2, fixedMealEnabled: false, fixedMealMin: 0 }, new Map()),
  );
  const start = monthStart(year, month);
  const today = todayDhaka();
  // A few meals off and some guests
  let seed = 7;
  const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  for (const mid of mids) {
    for (let d = start; d <= today; d = addDays(d, 1)) {
      const r = rand();
      if (r < 0.15) {
        await db.update(mealEntries).set({ lunch: false }).where(and(eq(mealEntries.membershipId, mid), eq(mealEntries.date, d)));
      } else if (r > 0.92) {
        await db.update(mealEntries).set({ guestDinner: 1 }).where(and(eq(mealEntries.membershipId, mid), eq(mealEntries.date, d)));
      }
    }
  }
  const adminUser = (await db.select().from(users).where(eq(users.email, people[0].email)))[0];
  const items = ["চাল ২৫ কেজি, ডাল, তেল", "মুরগি ৩ কেজি, পেঁয়াজ, আলু", "রুই মাছ, সবজি, ডিম ৩০টা", "গরুর মাংস ২ কেজি, মসলা"];
  let i = 0;
  for (let d = start; d <= today; d = addDays(d, 2)) {
    await db.insert(bazars).values({
      monthId: m.id,
      membershipId: mids[i % mids.length],
      date: d,
      amount: String(900 + Math.round(rand() * 1400)),
      items: items[i % items.length],
      status: "APPROVED",
      createdById: adminUser.id,
      reviewedById: adminUser.id,
      reviewedAt: new Date(),
    });
    await db.insert(bazarDuties).values({ monthId: m.id, membershipId: mids[i % mids.length], date: d }).onConflictDoNothing();
    i++;
  }
  await db.insert(bazars).values({ monthId: m.id, membershipId: mids[2], date: today, amount: "760", items: "সবজি, লবণ, চিনি", status: "PENDING", createdById: adminUser.id });
  for (const [k, mid] of mids.entries()) {
    await db.insert(deposits).values({ monthId: m.id, membershipId: mid, date: start, amount: String(2000 + k * 250), status: "APPROVED", createdById: adminUser.id, reviewedById: adminUser.id });
  }
  await db.insert(deposits).values({ monthId: m.id, membershipId: mids[4], date: today, amount: "1000", note: "বিকাশে পাঠালাম", status: "PENDING", createdById: adminUser.id });
  await db.insert(fixedCosts).values([
    { monthId: m.id, title: "বুয়ার বেতন", amount: "3000", date: start, createdById: adminUser.id },
    { monthId: m.id, title: "গ্যাস বিল", amount: "1080", date: start, createdById: adminUser.id },
  ]);
  for (let d = addDays(today, 1), k = 0; k < 6 && d.slice(0, 7) === today.slice(0, 7); d = addDays(d, 2), k++) {
    await db.insert(bazarDuties).values({ monthId: m.id, membershipId: mids[(i + k) % mids.length], date: d }).onConflictDoNothing();
  }
  // A pending join request
  const [u] = await db.insert(users).values({ name: "মেহেদী হাসান", email: "mehedi@mealsystem.app", passwordHash: pw }).returning();
  await db.insert(memberships).values({ messId: mess.id, userId: u.id });
  void months;
  console.log(`✔ Demo mess created. Login: demo@mealsystem.app / demo1234  (join code ${mess.code})`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
