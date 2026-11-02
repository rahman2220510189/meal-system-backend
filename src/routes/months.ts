import type { Router, Request } from "express";
import { z } from "zod";
import { and, eq, gte, lte, sql, isNull, asc } from "drizzle-orm";
import { db } from "../db";
import { months, monthMembers, mealEntries, bazars, deposits, memberships, users } from "../db/schema";
import { parse, zDate, zGuest, zUuid } from "../lib/validate";
import { conflict, forbidden, notFound, badRequest } from "../lib/errors";
import { requireAdmin } from "../middleware/auth";
import { logActivity } from "../lib/log";
import {
  getMonthOr404,
  assertOpen,
  assertDateInMonth,
  buildSummary,
  latestMonth,
  createMonth,
  openMonthOf,
  serializeMonth,
} from "../services/months";
import { todayDhaka, nowDhakaHM } from "../lib/dates";
import { toNum, money } from "../lib/money";

type MealField = "breakfast" | "lunch" | "dinner" | "guestBreakfast" | "guestLunch" | "guestDinner";
const FIELD_MEAL: Record<MealField, "breakfast" | "lunch" | "dinner"> = {
  breakfast: "breakfast",
  lunch: "lunch",
  dinner: "dinner",
  guestBreakfast: "breakfast",
  guestLunch: "lunch",
  guestDinner: "dinner",
};

/** Members may change future days freely and today's meals until each meal's cutoff. Admins may change anything. */
export function canEdit(
  isAdmin: boolean,
  date: string,
  field: MealField,
  mess: { breakfastCutoff: string; lunchCutoff: string; dinnerCutoff: string },
  today = todayDhaka(),
  nowHM = nowDhakaHM(),
): boolean {
  if (isAdmin) return true;
  if (date > today) return true;
  if (date < today) return false;
  const meal = FIELD_MEAL[field];
  const cutoff = meal === "breakfast" ? mess.breakfastCutoff : meal === "lunch" ? mess.lunchCutoff : mess.dinnerCutoff;
  return nowHM < cutoff;
}

const monthSettings = z.object({
  mealsPerDay: z.coerce.number().int().refine((n) => n === 2 || n === 3, "2 or 3"),
  fixedMealEnabled: z.boolean(),
  fixedMealMin: z.coerce.number().int().min(0).max(200),
});

function resolveTarget(req: Request, requested?: string) {
  const self = req.membership!.id;
  const target = requested || self;
  if (target !== self && req.membership!.role !== "ADMIN") throw forbidden("OWN_MEALS_ONLY", "You can only change your own meals");
  return target;
}

export function registerMonthRoutes(r: Router) {
  // ---- Month lifecycle ---------------------------------------------------------------
  r.get("/months/:monthId", async (req, res) => {
    const month = await getMonthOr404(req.mess!.id, String(req.params.monthId));
    res.json(await buildSummary(req.mess!, month));
  });

  r.post("/months", requireAdmin, async (req, res) => {
    const body = parse(
      monthSettings.extend({ year: z.coerce.number().int().min(2020).max(2100), month: z.coerce.number().int().min(1).max(12) }),
      req.body,
    );
    const messId = req.mess!.id;
    const created = await db.transaction(async (tx) => {
      if (await openMonthOf(tx, messId)) throw conflict("OPEN_MONTH_EXISTS", "Close the current month first");
      const last = await latestMonth(tx, messId);
      if (last && body.year * 12 + body.month <= last.year * 12 + last.month) {
        throw conflict("MONTH_NOT_AFTER_LAST", "The new month must come after the last month");
      }
      const carry = new Map<string, number>();
      if (last) {
        const rows = await tx
          .select({ id: monthMembers.membershipId, fb: monthMembers.finalBalance })
          .from(monthMembers)
          .where(eq(monthMembers.monthId, last.id));
        for (const row of rows) carry.set(row.id, toNum(row.fb));
      }
      const m = await createMonth(
        tx,
        messId,
        {
          year: body.year,
          month: body.month,
          mealsPerDay: body.mealsPerDay,
          fixedMealEnabled: body.fixedMealEnabled,
          fixedMealMin: body.fixedMealEnabled ? body.fixedMealMin : 0,
        },
        carry,
      );
      await logActivity(tx, { messId, user: req.user!, action: "month.create", meta: { year: m.year, month: m.month } });
      return m;
    });
    res.status(201).json({ month: serializeMonth(created) });
  });

  r.patch("/months/:monthId", requireAdmin, async (req, res) => {
    const month = await getMonthOr404(req.mess!.id, String(req.params.monthId));
    assertOpen(month);
    const body = parse(monthSettings.partial(), req.body);
    const patch: Partial<typeof months.$inferInsert> = {};
    if (body.mealsPerDay !== undefined) patch.mealsPerDay = body.mealsPerDay;
    if (body.fixedMealEnabled !== undefined) patch.fixedMealEnabled = body.fixedMealEnabled;
    if (body.fixedMealMin !== undefined) patch.fixedMealMin = body.fixedMealMin;
    if (!Object.keys(patch).length) throw badRequest("NOTHING_TO_UPDATE");
    const [m] = await db.update(months).set(patch).where(eq(months.id, month.id)).returning();
    await logActivity(db, { messId: req.mess!.id, user: req.user!, action: "month.settings", meta: { year: m.year, month: m.month, ...body } });
    res.json({ month: serializeMonth(m) });
  });

  r.post("/months/:monthId/close", requireAdmin, async (req, res) => {
    const body = parse(z.object({ force: z.boolean().optional() }), req.body ?? {});
    const month = await getMonthOr404(req.mess!.id, String(req.params.monthId));
    assertOpen(month);
    const summary = await buildSummary(req.mess!, month, { full: true });
    const pending = summary.totals.pendingBazarCount + summary.totals.pendingDepositCount;
    if (pending > 0 && !body.force) {
      throw conflict("PENDING_ITEMS", "Some bazar or deposit entries are still waiting for approval", {
        bazar: summary.totals.pendingBazarCount,
        deposit: summary.totals.pendingDepositCount,
      });
    }
    await db.transaction(async (tx) => {
      for (const m of summary.members) {
        await tx
          .update(monthMembers)
          .set({ finalBalance: money(m.balance) })
          .where(and(eq(monthMembers.monthId, month.id), eq(monthMembers.membershipId, m.membershipId)));
      }
      await tx.update(months).set({ status: "CLOSED", closedAt: new Date() }).where(eq(months.id, month.id));
      await logActivity(tx, {
        messId: req.mess!.id,
        user: req.user!,
        action: "month.close",
        meta: { year: month.year, month: month.month, mealRate: summary.mealRate },
      });
    });
    const fresh = await getMonthOr404(req.mess!.id, month.id);
    res.json(await buildSummary(req.mess!, fresh));
  });

  r.post("/months/:monthId/reopen", requireAdmin, async (req, res) => {
    const month = await getMonthOr404(req.mess!.id, String(req.params.monthId));
    if (month.status === "OPEN") throw conflict("MONTH_OPEN", "This month is already open");
    const last = await latestMonth(db, req.mess!.id);
    if (!last || last.id !== month.id) throw conflict("NOT_LATEST_MONTH", "Only the latest month can be reopened");
    await db.update(months).set({ status: "OPEN", closedAt: null }).where(eq(months.id, month.id));
    await logActivity(db, { messId: req.mess!.id, user: req.user!, action: "month.reopen", meta: { year: month.year, month: month.month } });
    res.json({ ok: true });
  });

  // ---- Meals -------------------------------------------------------------------------
  r.get("/months/:monthId/meals", async (req, res) => {
    const month = await getMonthOr404(req.mess!.id, String(req.params.monthId));
    const membershipId = typeof req.query.membershipId === "string" ? req.query.membershipId : req.membership!.id;
    const mm = await db
      .select({
        membershipId: monthMembers.membershipId,
        activeFrom: monthMembers.activeFrom,
        activeTo: monthMembers.activeTo,
        name: users.name,
      })
      .from(monthMembers)
      .innerJoin(memberships, eq(memberships.id, monthMembers.membershipId))
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(monthMembers.monthId, month.id))
      .orderBy(asc(users.name));
    const target = mm.find((m) => m.membershipId === membershipId);
    const entries = target
      ? await db
          .select()
          .from(mealEntries)
          .where(and(eq(mealEntries.monthId, month.id), eq(mealEntries.membershipId, membershipId)))
          .orderBy(asc(mealEntries.date))
      : [];
    res.json({
      month: serializeMonth(month),
      members: mm,
      member: target ?? null,
      entries: entries.map((e) => ({
        date: e.date,
        breakfast: e.breakfast,
        lunch: e.lunch,
        dinner: e.dinner,
        guestBreakfast: e.guestBreakfast,
        guestLunch: e.guestLunch,
        guestDinner: e.guestDinner,
      })),
      rules: {
        today: todayDhaka(),
        now: nowDhakaHM(),
        breakfastCutoff: req.mess!.breakfastCutoff,
        lunchCutoff: req.mess!.lunchCutoff,
        dinnerCutoff: req.mess!.dinnerCutoff,
        breakfastWeight: toNum(req.mess!.breakfastWeight),
      },
    });
  });

  r.put("/months/:monthId/meals", async (req, res) => {
    const month = await getMonthOr404(req.mess!.id, String(req.params.monthId));
    assertOpen(month);
    const body = parse(
      z.object({
        membershipId: zUuid.optional(),
        date: zDate,
        breakfast: z.boolean().optional(),
        lunch: z.boolean().optional(),
        dinner: z.boolean().optional(),
        guestBreakfast: zGuest.optional(),
        guestLunch: zGuest.optional(),
        guestDinner: zGuest.optional(),
      }),
      req.body,
    );
    assertDateInMonth(month, body.date);
    const target = resolveTarget(req, body.membershipId);
    const isAdmin = req.membership!.role === "ADMIN";
    const [entry] = await db
      .select()
      .from(mealEntries)
      .where(and(eq(mealEntries.monthId, month.id), eq(mealEntries.membershipId, target), eq(mealEntries.date, body.date)))
      .limit(1);
    if (!entry) throw notFound("NOT_ACTIVE_ON_DATE", "This member was not in the mess on that day");

    const fields: MealField[] = ["breakfast", "lunch", "dinner", "guestBreakfast", "guestLunch", "guestDinner"];
    const patch: Record<string, boolean | number | Date> = {};
    for (const f of fields) {
      const v = body[f];
      if (v === undefined || v === entry[f]) continue;
      if (!canEdit(isAdmin, body.date, f, req.mess!)) {
        throw forbidden(body.date < todayDhaka() ? "PAST_DAY_LOCKED" : "CUTOFF_PASSED", "This meal can no longer be changed");
      }
      patch[f] = v;
    }
    if (!Object.keys(patch).length) return res.json({ entry: pickEntry(entry) });
    patch.updatedAt = new Date();
    const [updated] = await db.update(mealEntries).set(patch).where(eq(mealEntries.id, entry.id)).returning();
    if (target !== req.membership!.id) {
      await logActivity(db, {
        messId: req.mess!.id,
        user: req.user!,
        action: "meal.edit_other",
        meta: { date: body.date, membershipId: target, changes: { ...patch, updatedAt: undefined } },
      });
    }
    res.json({ entry: pickEntry(updated) });
  });

  r.post("/months/:monthId/meals/bulk", async (req, res) => {
    const month = await getMonthOr404(req.mess!.id, String(req.params.monthId));
    assertOpen(month);
    const body = parse(
      z.object({
        membershipId: zUuid.optional(),
        from: zDate,
        to: zDate,
        breakfast: z.boolean().optional(),
        lunch: z.boolean().optional(),
        dinner: z.boolean().optional(),
      }),
      req.body,
    );
    if (body.from > body.to) throw badRequest("BAD_RANGE", "Start date must be before end date");
    assertDateInMonth(month, body.from);
    assertDateInMonth(month, body.to);
    const target = resolveTarget(req, body.membershipId);
    const isAdmin = req.membership!.role === "ADMIN";
    const set: Partial<Record<"breakfast" | "lunch" | "dinner", boolean>> = {};
    if (body.breakfast !== undefined) set.breakfast = body.breakfast;
    if (body.lunch !== undefined) set.lunch = body.lunch;
    if (body.dinner !== undefined) set.dinner = body.dinner;
    if (!Object.keys(set).length) throw badRequest("NOTHING_TO_UPDATE");

    const rows = await db
      .select()
      .from(mealEntries)
      .where(
        and(
          eq(mealEntries.monthId, month.id),
          eq(mealEntries.membershipId, target),
          gte(mealEntries.date, body.from),
          lte(mealEntries.date, body.to),
        ),
      );
    let updated = 0;
    let skipped = 0;
    await db.transaction(async (tx) => {
      for (const e of rows) {
        const patch: Record<string, boolean | Date> = {};
        let blocked = false;
        for (const [f, v] of Object.entries(set) as ["breakfast" | "lunch" | "dinner", boolean][]) {
          if (e[f] === v) continue;
          if (canEdit(isAdmin, e.date, f, req.mess!)) patch[f] = v;
          else blocked = true;
        }
        if (blocked) skipped++;
        if (Object.keys(patch).length) {
          patch.updatedAt = new Date();
          await tx.update(mealEntries).set(patch).where(eq(mealEntries.id, e.id));
          updated++;
        }
      }
      if (target !== req.membership!.id && updated) {
        await logActivity(tx, {
          messId: req.mess!.id,
          user: req.user!,
          action: "meal.bulk_other",
          meta: { from: body.from, to: body.to, membershipId: target, set },
        });
      }
    });
    res.json({ updated, skipped });
  });

  // Who is pending, for the admin approval badge
  r.get("/months/:monthId/pending", requireAdmin, async (req, res) => {
    const month = await getMonthOr404(req.mess!.id, String(req.params.monthId));
    const [b] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(bazars)
      .where(and(eq(bazars.monthId, month.id), eq(bazars.status, "PENDING"), isNull(bazars.deletedAt)));
    const [d] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(deposits)
      .where(and(eq(deposits.monthId, month.id), eq(deposits.status, "PENDING"), isNull(deposits.deletedAt)));
    res.json({ bazar: b?.n ?? 0, deposit: d?.n ?? 0 });
  });
}

function pickEntry(e: typeof mealEntries.$inferSelect) {
  return {
    date: e.date,
    breakfast: e.breakfast,
    lunch: e.lunch,
    dinner: e.dinner,
    guestBreakfast: e.guestBreakfast,
    guestLunch: e.guestLunch,
    guestDinner: e.guestDinner,
  };
}
