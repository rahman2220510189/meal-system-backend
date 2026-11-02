import { and, eq, desc, gt, isNull, sql, inArray } from "drizzle-orm";
import { db, type Tx } from "../db";
import {
  months,
  monthMembers,
  mealEntries,
  memberships,
  users,
  bazars,
  deposits,
  fixedCosts,
  bazarDuties,
  messes,
} from "../db/schema";
import { conflict, notFound } from "../lib/errors";
import { clampDate, daysInMonth, monthEnd, monthStart, todayDhaka, dateRange, addDays } from "../lib/dates";
import { calculateMonth } from "../lib/calc";
import { toNum } from "../lib/money";

type Month = typeof months.$inferSelect;
type Mess = typeof messes.$inferSelect;
type Conn = Tx | typeof db;

export function monthRange(m: Pick<Month, "year" | "month">) {
  return { start: monthStart(m.year, m.month), end: monthEnd(m.year, m.month) };
}

export async function getMonthOr404(messId: string, monthId: string): Promise<Month> {
  const [m] = await db
    .select()
    .from(months)
    .where(and(eq(months.id, monthId), eq(months.messId, messId)))
    .limit(1);
  if (!m) throw notFound("MONTH_NOT_FOUND");
  return m;
}

export function assertOpen(m: Month) {
  if (m.status !== "OPEN") throw conflict("MONTH_CLOSED", "This month is closed");
}

export function assertDateInMonth(m: Month, date: string) {
  const { start, end } = monthRange(m);
  if (date < start || date > end) throw conflict("DATE_OUTSIDE_MONTH", "Date is outside this month");
}

export async function latestMonth(conn: Conn, messId: string): Promise<Month | undefined> {
  const [m] = await conn
    .select()
    .from(months)
    .where(eq(months.messId, messId))
    .orderBy(desc(months.year), desc(months.month))
    .limit(1);
  return m;
}

/** Adds (or re-activates) a member in a month and creates default-ON meal rows from `activeFrom`. */
export async function addMemberToMonth(tx: Conn, month: Month, membershipId: string, activeFrom: string, carryIn = 0) {
  const { start, end } = monthRange(month);
  const from = clampDate(activeFrom, start, end);
  const [existing] = await tx
    .select()
    .from(monthMembers)
    .where(and(eq(monthMembers.monthId, month.id), eq(monthMembers.membershipId, membershipId)))
    .limit(1);
  if (existing) {
    await tx.update(monthMembers).set({ activeTo: null }).where(eq(monthMembers.id, existing.id));
  } else {
    await tx.insert(monthMembers).values({ monthId: month.id, membershipId, activeFrom: from, carryIn: String(carryIn) });
  }
  const days = dateRange(from, end);
  if (days.length) {
    await tx
      .insert(mealEntries)
      .values(days.map((date) => ({ monthId: month.id, membershipId, date })))
      .onConflictDoNothing();
  }
}

/** Ends a member's participation in a month: no meals after `lastDay`. */
export async function endMemberInMonth(tx: Conn, month: Month, membershipId: string, lastDay: string) {
  const { start, end } = monthRange(month);
  const [mm] = await tx
    .select()
    .from(monthMembers)
    .where(and(eq(monthMembers.monthId, month.id), eq(monthMembers.membershipId, membershipId)))
    .limit(1);
  if (!mm) return;
  let to = clampDate(lastDay, start, end);
  if (to < mm.activeFrom) to = mm.activeFrom;
  await tx.update(monthMembers).set({ activeTo: to }).where(eq(monthMembers.id, mm.id));
  await tx
    .delete(mealEntries)
    .where(and(eq(mealEntries.monthId, month.id), eq(mealEntries.membershipId, membershipId), gt(mealEntries.date, to)));
}

export async function createMonth(
  tx: Tx,
  messId: string,
  p: { year: number; month: number; mealsPerDay: number; fixedMealEnabled: boolean; fixedMealMin: number },
  carry: Map<string, number>,
): Promise<Month> {
  const [m] = await tx.insert(months).values({ messId, ...p }).returning();
  const approved = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.messId, messId), eq(memberships.status, "APPROVED")));
  const { start } = monthRange(m);
  for (const a of approved) {
    await addMemberToMonth(tx, m, a.id, start, carry.get(a.id) || 0);
  }
  return m;
}

export async function openMonthOf(conn: Conn, messId: string): Promise<Month | undefined> {
  const [m] = await conn
    .select()
    .from(months)
    .where(and(eq(months.messId, messId), eq(months.status, "OPEN")))
    .orderBy(desc(months.year), desc(months.month))
    .limit(1);
  return m;
}

/**
 * Month calculation, plus today's cook count and bazar duty.
 * While a month is running, meals are counted only up to today (future days are
 * switched on by default but not eaten yet). A closed month, or `full`, counts every day.
 */
export async function buildSummary(mess: Mess, month: Month, opts: { full?: boolean } = {}) {
  const { start, end } = monthRange(month);
  const todayStr = todayDhaka();
  const full = opts.full || month.status === "CLOSED" || todayStr >= end;
  const upTo = full ? end : todayStr < start ? addDays(start, -1) : todayStr;

  const mm = await db
    .select({
      membershipId: monthMembers.membershipId,
      activeFrom: monthMembers.activeFrom,
      activeTo: monthMembers.activeTo,
      carryIn: monthMembers.carryIn,
      finalBalance: monthMembers.finalBalance,
      userId: users.id,
      name: users.name,
      role: memberships.role,
      status: memberships.status,
    })
    .from(monthMembers)
    .innerJoin(memberships, eq(memberships.id, monthMembers.membershipId))
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(monthMembers.monthId, month.id));

  const allMeals = await db
    .select({
      membershipId: mealEntries.membershipId,
      date: mealEntries.date,
      breakfast: mealEntries.breakfast,
      lunch: mealEntries.lunch,
      dinner: mealEntries.dinner,
      guestBreakfast: mealEntries.guestBreakfast,
      guestLunch: mealEntries.guestLunch,
      guestDinner: mealEntries.guestDinner,
    })
    .from(mealEntries)
    .where(eq(mealEntries.monthId, month.id));
  const meals = allMeals.filter((m) => m.date <= upTo);

  const [bz] = await db
    .select({
      approved: sql<string>`coalesce(sum(case when ${bazars.status} = 'APPROVED' then ${bazars.amount} else 0 end), 0)`,
      pending: sql<string>`coalesce(sum(case when ${bazars.status} = 'PENDING' then ${bazars.amount} else 0 end), 0)`,
      pendingCount: sql<number>`count(*) filter (where ${bazars.status} = 'PENDING')::int`,
      approvedCount: sql<number>`count(*) filter (where ${bazars.status} = 'APPROVED')::int`,
    })
    .from(bazars)
    .where(and(eq(bazars.monthId, month.id), isNull(bazars.deletedAt)));

  const dep = await db
    .select({
      membershipId: deposits.membershipId,
      total: sql<string>`coalesce(sum(${deposits.amount}), 0)`,
    })
    .from(deposits)
    .where(and(eq(deposits.monthId, month.id), eq(deposits.status, "APPROVED"), isNull(deposits.deletedAt)))
    .groupBy(deposits.membershipId);

  const [depPending] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(deposits)
    .where(and(eq(deposits.monthId, month.id), eq(deposits.status, "PENDING"), isNull(deposits.deletedAt)));

  const [fc] = await db
    .select({ total: sql<string>`coalesce(sum(${fixedCosts.amount}), 0)` })
    .from(fixedCosts)
    .where(and(eq(fixedCosts.monthId, month.id), isNull(fixedCosts.deletedAt)));

  const depositsByMember: Record<string, number> = {};
  for (const d of dep) depositsByMember[d.membershipId] = toNum(d.total);

  const result = calculateMonth({
    mealsPerDay: month.mealsPerDay,
    breakfastWeight: toNum(mess.breakfastWeight),
    fixedMealEnabled: month.fixedMealEnabled,
    fixedMealMin: month.fixedMealMin,
    daysInMonth: daysInMonth(month.year, month.month),
    monthEnd: upTo,
    members: mm.map((m) => ({
      membershipId: m.membershipId,
      userId: m.userId,
      name: m.name,
      activeFrom: m.activeFrom,
      activeTo: m.activeTo && m.activeTo < upTo ? m.activeTo : null,
      carryIn: toNum(m.carryIn),
    })),
    meals,
    bazarTotal: toNum(bz?.approved),
    fixedCostTotal: toNum(fc?.total),
    depositsByMember,
  });

  const info = new Map(mm.map((m) => [m.membershipId, m]));
  const memberRows = result.members
    .map((r) => ({
      ...r,
      role: info.get(r.membershipId)!.role,
      status: info.get(r.membershipId)!.status,
      activeFrom: info.get(r.membershipId)!.activeFrom,
      activeTo: info.get(r.membershipId)!.activeTo,
      finalBalance: info.get(r.membershipId)!.finalBalance == null ? null : toNum(info.get(r.membershipId)!.finalBalance),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Today's kitchen count (only when today is inside this month)
  const today = todayStr;
  let todayInfo = null as null | {
    date: string;
    breakfast: number;
    lunch: number;
    dinner: number;
    guestBreakfast: number;
    guestLunch: number;
    guestDinner: number;
    duty: { membershipId: string; name: string }[];
  };
  if (today >= start && today <= end) {
    const t = allMeals.filter((m) => m.date === today);
    const duty = await db
      .select({ membershipId: bazarDuties.membershipId, name: users.name })
      .from(bazarDuties)
      .innerJoin(memberships, eq(memberships.id, bazarDuties.membershipId))
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(bazarDuties.monthId, month.id), eq(bazarDuties.date, today)));
    todayInfo = {
      date: today,
      breakfast: t.filter((m) => m.breakfast).length,
      lunch: t.filter((m) => m.lunch).length,
      dinner: t.filter((m) => m.dinner).length,
      guestBreakfast: t.reduce((s, m) => s + m.guestBreakfast, 0),
      guestLunch: t.reduce((s, m) => s + m.guestLunch, 0),
      guestDinner: t.reduce((s, m) => s + m.guestDinner, 0),
      duty,
    };
  }

  // Daily totals for the report chart
  const daily = dateRange(start, end).map((date) => {
    const d = meals.filter((m) => m.date === date);
    const bw = toNum(mess.breakfastWeight);
    let own = 0;
    let guest = 0;
    for (const m of d) {
      own += (month.mealsPerDay === 3 && m.breakfast ? bw : 0) + (m.lunch ? 1 : 0) + (m.dinner ? 1 : 0);
      guest += (month.mealsPerDay === 3 ? m.guestBreakfast * bw : 0) + m.guestLunch + m.guestDinner;
    }
    return { date, own, guest };
  });

  return {
    month: serializeMonth(month),
    countedUpTo: upTo,
    isFinal: full,
    mealRate: result.mealRate,
    totals: {
      ...result.totals,
      pendingBazar: toNum(bz?.pending),
      pendingBazarCount: bz?.pendingCount ?? 0,
      approvedBazarCount: bz?.approvedCount ?? 0,
      pendingDepositCount: depPending?.count ?? 0,
    },
    members: memberRows,
    today: todayInfo,
    daily,
  };
}

export function serializeMonth(m: Month) {
  const { start, end } = monthRange(m);
  return {
    id: m.id,
    year: m.year,
    month: m.month,
    start,
    end,
    mealsPerDay: m.mealsPerDay,
    fixedMealEnabled: m.fixedMealEnabled,
    fixedMealMin: m.fixedMealMin,
    status: m.status,
    closedAt: m.closedAt,
  };
}

/** Membership ids that belong to a month (used to validate who can be referenced). */
export async function monthMembershipIds(monthId: string): Promise<Set<string>> {
  const rows = await db.select({ id: monthMembers.membershipId }).from(monthMembers).where(eq(monthMembers.monthId, monthId));
  return new Set(rows.map((r) => r.id));
}

export async function membershipNames(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: memberships.id, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(inArray(memberships.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export { addDays };
