import { Router } from "express";
import { z } from "zod";
import { and, eq, sql, desc, asc } from "drizzle-orm";
import { db } from "../db";
import { messes, memberships, users, months } from "../db/schema";
import { parse, zTime } from "../lib/validate";
import { makeJoinCode, makeTempPassword, hashPassword } from "../lib/auth";
import { badRequest, conflict, notFound } from "../lib/errors";
import { requireAdmin, requireMember, isUuid } from "../middleware/auth";
import { logActivity } from "../lib/log";
import { createMonth, openMonthOf, addMemberToMonth, endMemberInMonth, buildSummary, serializeMonth } from "../services/months";
import { currentYearMonthDhaka, todayDhaka } from "../lib/dates";
import { toNum } from "../lib/money";

export const messRouter = Router();

function serializeMess(m: typeof messes.$inferSelect, isAdmin: boolean) {
  return {
    id: m.id,
    name: m.name,
    code: isAdmin ? m.code : undefined,
    breakfastWeight: toNum(m.breakfastWeight),
    breakfastCutoff: m.breakfastCutoff,
    lunchCutoff: m.lunchCutoff,
    dinnerCutoff: m.dinnerCutoff,
    createdAt: m.createdAt,
  };
}

async function uniqueCode(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = makeJoinCode();
    const [hit] = await db.select({ id: messes.id }).from(messes).where(eq(messes.code, code)).limit(1);
    if (!hit) return code;
  }
  throw new Error("Could not generate a join code");
}

// ---- Messes of the signed-in user -------------------------------------------------
messRouter.get("/", async (req, res) => {
  const rows = await db
    .select({ membership: memberships, mess: messes })
    .from(memberships)
    .innerJoin(messes, eq(messes.id, memberships.messId))
    .where(eq(memberships.userId, req.user!.id))
    .orderBy(desc(memberships.requestedAt));
  res.json({
    messes: rows
      .filter((r) => r.membership.status !== "REMOVED")
      .map((r) => ({
        id: r.mess.id,
        name: r.mess.name,
        role: r.membership.role,
        status: r.membership.status,
        membershipId: r.membership.id,
        requestedAt: r.membership.requestedAt,
      })),
  });
});

messRouter.post("/", async (req, res) => {
  const body = parse(
    z.object({
      name: z.string().trim().min(2).max(60),
      mealsPerDay: z.coerce.number().int().refine((n) => n === 2 || n === 3).default(2),
    }),
    req.body,
  );
  const user = req.user!;
  const result = await db.transaction(async (tx) => {
    const [mess] = await tx.insert(messes).values({ name: body.name, code: await uniqueCode() }).returning();
    const [mem] = await tx
      .insert(memberships)
      .values({ messId: mess.id, userId: user.id, role: "ADMIN", status: "APPROVED", approvedAt: new Date() })
      .returning();
    const { year, month } = currentYearMonthDhaka();
    await createMonth(tx, mess.id, { year, month, mealsPerDay: body.mealsPerDay, fixedMealEnabled: false, fixedMealMin: 0 }, new Map());
    await logActivity(tx, { messId: mess.id, user, action: "mess.create", meta: { name: mess.name } });
    return { mess, mem };
  });
  res.status(201).json({ mess: serializeMess(result.mess, true), membershipId: result.mem.id });
});

// Shows only the mess name for a join code (used by the join page)
messRouter.get("/preview/:code", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const [m] = await db.select({ id: messes.id, name: messes.name }).from(messes).where(eq(messes.code, code)).limit(1);
  if (!m) throw notFound("CODE_NOT_FOUND", "No mess has this code");
  const [cnt] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.messId, m.id), eq(memberships.status, "APPROVED")));
  res.json({ name: m.name, members: cnt?.n ?? 0 });
});

messRouter.post("/join", async (req, res) => {
  const body = parse(z.object({ code: z.string().trim().toUpperCase().min(4).max(12) }), req.body);
  const user = req.user!;
  const [mess] = await db.select().from(messes).where(eq(messes.code, body.code)).limit(1);
  if (!mess) throw notFound("CODE_NOT_FOUND", "No mess has this code");
  const [existing] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.messId, mess.id), eq(memberships.userId, user.id)))
    .limit(1);
  if (existing?.status === "APPROVED") throw conflict("ALREADY_MEMBER", "You are already a member of this mess");
  if (existing?.status === "PENDING") throw conflict("ALREADY_REQUESTED", "Your request is waiting for approval");
  if (existing) {
    await db
      .update(memberships)
      .set({ status: "PENDING", role: "MEMBER", requestedAt: new Date(), removedAt: null })
      .where(eq(memberships.id, existing.id));
  } else {
    await db.insert(memberships).values({ messId: mess.id, userId: user.id });
  }
  await logActivity(db, { messId: mess.id, user, action: "member.request" });
  res.status(201).json({ mess: { id: mess.id, name: mess.name }, status: "PENDING" });
});

// ---- Everything below needs an approved membership --------------------------------
const scoped = Router({ mergeParams: true });
messRouter.use("/:messId", requireMember, scoped);

scoped.get("/", async (req, res) => {
  const isAdmin = req.membership!.role === "ADMIN";
  const allMonths = await db
    .select()
    .from(months)
    .where(eq(months.messId, req.mess!.id))
    .orderBy(desc(months.year), desc(months.month));
  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.messId, req.mess!.id), eq(memberships.status, "PENDING")));
  res.json({
    mess: serializeMess(req.mess!, isAdmin),
    me: { membershipId: req.membership!.id, role: req.membership!.role },
    months: allMonths.map(serializeMonth),
    pendingMembers: isAdmin ? pending?.n ?? 0 : 0,
  });
});

scoped.patch("/", requireAdmin, async (req, res) => {
  const body = parse(
    z.object({
      name: z.string().trim().min(2).max(60).optional(),
      breakfastWeight: z.coerce.number().refine((n) => n === 0.5 || n === 1).optional(),
      breakfastCutoff: zTime.optional(),
      lunchCutoff: zTime.optional(),
      dinnerCutoff: zTime.optional(),
    }),
    req.body,
  );
  const patch: Partial<typeof messes.$inferInsert> = {};
  if (body.name) patch.name = body.name;
  if (body.breakfastWeight !== undefined) patch.breakfastWeight = String(body.breakfastWeight);
  if (body.breakfastCutoff) patch.breakfastCutoff = body.breakfastCutoff;
  if (body.lunchCutoff) patch.lunchCutoff = body.lunchCutoff;
  if (body.dinnerCutoff) patch.dinnerCutoff = body.dinnerCutoff;
  if (!Object.keys(patch).length) throw badRequest("NOTHING_TO_UPDATE");
  const [m] = await db.update(messes).set(patch).where(eq(messes.id, req.mess!.id)).returning();
  await logActivity(db, { messId: m.id, user: req.user!, action: "mess.settings", meta: { ...body } });
  res.json({ mess: serializeMess(m, true) });
});

scoped.post("/code", requireAdmin, async (req, res) => {
  const code = await uniqueCode();
  await db.update(messes).set({ code }).where(eq(messes.id, req.mess!.id));
  await logActivity(db, { messId: req.mess!.id, user: req.user!, action: "mess.code" });
  res.json({ code });
});

// ---- Members ------------------------------------------------------------------------
scoped.get("/members", async (req, res) => {
  const isAdmin = req.membership!.role === "ADMIN";
  const rows = await db
    .select({
      membershipId: memberships.id,
      userId: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      role: memberships.role,
      status: memberships.status,
      requestedAt: memberships.requestedAt,
      approvedAt: memberships.approvedAt,
      removedAt: memberships.removedAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.messId, req.mess!.id))
    .orderBy(asc(users.name));
  const visible = isAdmin ? rows : rows.filter((r) => r.status === "APPROVED");
  // Members see each other's name and phone; email is admin-only
  res.json({ members: visible.map((r) => (isAdmin ? r : { ...r, email: undefined })) });
});

async function getTargetMembership(messId: string, membershipId: string) {
  if (!isUuid(membershipId)) throw notFound("MEMBER_NOT_FOUND");
  const [row] = await db
    .select({ m: memberships, u: users })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.id, membershipId), eq(memberships.messId, messId)))
    .limit(1);
  if (!row) throw notFound("MEMBER_NOT_FOUND");
  return row;
}

async function adminCount(messId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.messId, messId), eq(memberships.role, "ADMIN"), eq(memberships.status, "APPROVED")));
  return r?.n ?? 0;
}

scoped.post("/members/:membershipId/approve", requireAdmin, async (req, res) => {
  const { m, u } = await getTargetMembership(req.mess!.id, String(req.params.membershipId));
  if (m.status === "APPROVED") throw conflict("ALREADY_MEMBER");
  if (m.status !== "PENDING") throw conflict("NOT_PENDING", "This person has no pending request");
  await db.transaction(async (tx) => {
    await tx.update(memberships).set({ status: "APPROVED", approvedAt: new Date() }).where(eq(memberships.id, m.id));
    const open = await openMonthOf(tx, req.mess!.id);
    if (open) await addMemberToMonth(tx, open, m.id, todayDhaka());
    await logActivity(tx, { messId: req.mess!.id, user: req.user!, action: "member.approve", meta: { member: u.name } });
  });
  res.json({ ok: true });
});

scoped.post("/members/:membershipId/reject", requireAdmin, async (req, res) => {
  const { m, u } = await getTargetMembership(req.mess!.id, String(req.params.membershipId));
  if (m.status !== "PENDING") throw conflict("NOT_PENDING", "This person has no pending request");
  await db.update(memberships).set({ status: "REJECTED" }).where(eq(memberships.id, m.id));
  await logActivity(db, { messId: req.mess!.id, user: req.user!, action: "member.reject", meta: { member: u.name } });
  res.json({ ok: true });
});

scoped.post("/members/:membershipId/remove", requireAdmin, async (req, res) => {
  const body = parse(z.object({ force: z.boolean().optional() }), req.body ?? {});
  const { m, u } = await getTargetMembership(req.mess!.id, String(req.params.membershipId));
  if (m.status !== "APPROVED") throw conflict("NOT_MEMBER", "This person is not an active member");
  if (m.role === "ADMIN" && (await adminCount(req.mess!.id)) <= 1) {
    throw conflict("LAST_ADMIN", "A mess needs at least one admin. Make someone else admin first.");
  }
  const open = await openMonthOf(db, req.mess!.id);
  if (open && !body.force) {
    const summary = await buildSummary(req.mess!, open);
    const row = summary.members.find((r) => r.membershipId === m.id);
    if (row && row.balance < 0) {
      throw conflict("MEMBER_HAS_DUE", "This member still has dues", { balance: row.balance });
    }
  }
  await db.transaction(async (tx) => {
    await tx.update(memberships).set({ status: "REMOVED", role: "MEMBER", removedAt: new Date() }).where(eq(memberships.id, m.id));
    if (open) await endMemberInMonth(tx, open, m.id, todayDhaka());
    await logActivity(tx, { messId: req.mess!.id, user: req.user!, action: "member.remove", meta: { member: u.name } });
  });
  res.json({ ok: true });
});

scoped.post("/members/:membershipId/role", requireAdmin, async (req, res) => {
  const body = parse(z.object({ role: z.enum(["ADMIN", "MEMBER"]) }), req.body);
  const { m, u } = await getTargetMembership(req.mess!.id, String(req.params.membershipId));
  if (m.status !== "APPROVED") throw conflict("NOT_MEMBER");
  if (m.role === body.role) return res.json({ ok: true });
  if (body.role === "MEMBER" && (await adminCount(req.mess!.id)) <= 1) {
    throw conflict("LAST_ADMIN", "A mess needs at least one admin");
  }
  await db.update(memberships).set({ role: body.role }).where(eq(memberships.id, m.id));
  await logActivity(db, {
    messId: req.mess!.id,
    user: req.user!,
    action: body.role === "ADMIN" ? "member.make_admin" : "member.remove_admin",
    meta: { member: u.name },
  });
  res.json({ ok: true });
});

scoped.post("/members/:membershipId/reset-password", requireAdmin, async (req, res) => {
  const { m, u } = await getTargetMembership(req.mess!.id, String(req.params.membershipId));
  if (m.status !== "APPROVED") throw conflict("NOT_MEMBER");
  if (u.id === req.user!.id) throw badRequest("USE_PROFILE", "Change your own password from your profile");
  const temp = makeTempPassword();
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(temp), mustChangePassword: true, tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(eq(users.id, u.id));
  await logActivity(db, { messId: req.mess!.id, user: req.user!, action: "member.reset_password", meta: { member: u.name } });
  res.json({ tempPassword: temp });
});

export { scoped as messScopedRouter };
