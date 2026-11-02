// Bazar, deposits, shared costs, bazar duty, activity log and receipt uploads.
import type { Router, Request } from "express";
import { z } from "zod";
import multer from "multer";
import { and, eq, isNull, desc, asc, lt, inArray } from "drizzle-orm";
import { db } from "../db";
import { bazars, deposits, fixedCosts, bazarDuties, activityLogs, memberships, users } from "../db/schema";
import { parse, zAmount, zDate, zUuid } from "../lib/validate";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { requireAdmin, isUuid } from "../middleware/auth";
import { logActivity } from "../lib/log";
import { getMonthOr404, assertOpen, assertDateInMonth, monthMembershipIds, membershipNames } from "../services/months";
import { toNum, money } from "../lib/money";
import { receiptUrl, uploadReceipt } from "../lib/uploads";
import { uploadsEnabled } from "../env";

type Kind = "bazar" | "deposit";
const TABLE = { bazar: bazars, deposit: deposits } as const;

async function memberIdFor(req: Request, monthId: string, requested?: string) {
  const self = req.membership!.id;
  if (!requested || requested === self) return self;
  if (req.membership!.role !== "ADMIN") throw forbidden("OWN_ENTRIES_ONLY", "You can only add entries for yourself");
  const ids = await monthMembershipIds(monthId);
  if (!ids.has(requested)) throw badRequest("MEMBER_NOT_IN_MONTH", "This member is not part of this month");
  return requested;
}

function serializeEntry(kind: Kind, e: Record<string, unknown>, names: Map<string, string>, creatorNames: Map<string, string>) {
  const row = e as {
    id: string;
    date: string;
    amount: string;
    status: string;
    rejectReason: string | null;
    membershipId: string;
    createdById: string;
    createdAt: Date;
    reviewedAt: Date | null;
    items?: string | null;
    note?: string | null;
    receiptId?: string | null;
  };
  return {
    id: row.id,
    date: row.date,
    amount: toNum(row.amount),
    status: row.status,
    rejectReason: row.rejectReason,
    membershipId: row.membershipId,
    memberName: names.get(row.membershipId) ?? "—",
    createdById: row.createdById,
    createdByName: creatorNames.get(row.createdById) ?? "—",
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt,
    ...(kind === "bazar"
      ? { items: row.items ?? null, receiptUrl: row.receiptId ? receiptUrl(row.receiptId) : null }
      : { note: row.note ?? null }),
  };
}

async function userNames(ids: string[]) {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map<string, string>();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, uniq));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function registerEntryKind(r: Router, kind: Kind) {
  const table = TABLE[kind];
  const path = kind === "bazar" ? "bazar" : "deposits";

  const createSchema = z.object({
    date: zDate,
    amount: zAmount,
    membershipId: zUuid.optional(),
    items: z.string().trim().max(1000).optional(),
    note: z.string().trim().max(300).optional(),
    receiptId: z.string().max(200).optional(),
  });

  async function loadEntry(req: Request) {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("ENTRY_NOT_FOUND");
    const [e] = await db
      .select()
      .from(table)
      .where(and(eq(table.id, id), isNull(table.deletedAt)))
      .limit(1);
    if (!e) throw notFound("ENTRY_NOT_FOUND");
    // Isolation: the entry's month must belong to this mess
    const month = await getMonthOr404(req.mess!.id, e.monthId).catch(() => {
      throw notFound("ENTRY_NOT_FOUND");
    });
    return { e, month };
  }

  async function respondOne(e: typeof table.$inferSelect) {
    const names = await membershipNames([e.membershipId]);
    const creators = await userNames([e.createdById]);
    return serializeEntry(kind, e, names, creators);
  }

  function checkReceipt(req: Request, receiptId?: string) {
    if (!receiptId) return null;
    if (kind !== "bazar") return null;
    if (!receiptId.startsWith(`meal-system/${req.mess!.id}/`)) throw badRequest("BAD_RECEIPT", "Invalid receipt");
    return receiptId;
  }

  r.get(`/months/:monthId/${path}`, async (req, res) => {
    const month = await getMonthOr404(req.mess!.id, String(req.params.monthId));
    const rows = await db
      .select()
      .from(table)
      .where(and(eq(table.monthId, month.id), isNull(table.deletedAt)))
      .orderBy(desc(table.date), desc(table.createdAt));
    const names = await membershipNames([...new Set(rows.map((x) => x.membershipId))]);
    const creators = await userNames(rows.map((x) => x.createdById));
    res.json({ entries: rows.map((x) => serializeEntry(kind, x, names, creators)) });
  });

  r.post(`/months/:monthId/${path}`, async (req, res) => {
    const month = await getMonthOr404(req.mess!.id, String(req.params.monthId));
    assertOpen(month);
    const body = parse(createSchema, req.body);
    assertDateInMonth(month, body.date);
    const membershipId = await memberIdFor(req, month.id, body.membershipId);
    const isAdmin = req.membership!.role === "ADMIN";
    const values = {
      monthId: month.id,
      membershipId,
      date: body.date,
      amount: money(body.amount),
      status: (isAdmin ? "APPROVED" : "PENDING") as "APPROVED" | "PENDING",
      createdById: req.user!.id,
      reviewedById: isAdmin ? req.user!.id : null,
      reviewedAt: isAdmin ? new Date() : null,
    };
    const [e] =
      kind === "bazar"
        ? await db
            .insert(bazars)
            .values({ ...values, items: body.items || null, receiptId: checkReceipt(req, body.receiptId) })
            .returning()
        : await db
            .insert(deposits)
            .values({ ...values, note: body.note || null })
            .returning();
    const names = await membershipNames([membershipId]);
    await logActivity(db, {
      messId: req.mess!.id,
      user: req.user!,
      action: `${kind}.create`,
      meta: { amount: toNum(e.amount), date: e.date, member: names.get(membershipId), status: e.status },
    });
    res.status(201).json({ entry: await respondOne(e) });
  });

  r.patch(`/${path}/:id`, async (req, res) => {
    const { e, month } = await loadEntry(req);
    assertOpen(month);
    const isAdmin = req.membership!.role === "ADMIN";
    const own = e.membershipId === req.membership!.id || e.createdById === req.user!.id;
    if (!isAdmin && !(own && e.status !== "APPROVED")) {
      throw forbidden("CANNOT_EDIT_ENTRY", "Only pending entries you added can be changed");
    }
    const body = parse(createSchema.partial(), req.body);
    if (body.date) assertDateInMonth(month, body.date);
    const patch: Record<string, unknown> = {};
    if (body.date) patch.date = body.date;
    if (body.amount !== undefined) patch.amount = money(body.amount);
    if (kind === "bazar" && body.items !== undefined) patch.items = body.items || null;
    if (kind === "bazar" && body.receiptId !== undefined) patch.receiptId = checkReceipt(req, body.receiptId);
    if (kind === "deposit" && body.note !== undefined) patch.note = body.note || null;
    if (isAdmin && body.membershipId) patch.membershipId = await memberIdFor(req, month.id, body.membershipId);
    if (!Object.keys(patch).length) throw badRequest("NOTHING_TO_UPDATE");
    // A member's corrected entry goes back for approval
    if (!isAdmin) Object.assign(patch, { status: "PENDING", rejectReason: null, reviewedAt: null, reviewedById: null });
    const [u] = await db.update(table).set(patch).where(eq(table.id, e.id)).returning();
    await logActivity(db, {
      messId: req.mess!.id,
      user: req.user!,
      action: `${kind}.edit`,
      meta: { before: { amount: toNum(e.amount), date: e.date }, after: { amount: toNum(u.amount), date: u.date } },
    });
    res.json({ entry: await respondOne(u) });
  });

  r.post(`/${path}/:id/approve`, requireAdmin, async (req, res) => {
    const { e, month } = await loadEntry(req);
    assertOpen(month);
    if (e.status === "APPROVED") throw conflict("ALREADY_APPROVED");
    const [u] = await db
      .update(table)
      .set({ status: "APPROVED", rejectReason: null, reviewedById: req.user!.id, reviewedAt: new Date() })
      .where(eq(table.id, e.id))
      .returning();
    const names = await membershipNames([e.membershipId]);
    await logActivity(db, {
      messId: req.mess!.id,
      user: req.user!,
      action: `${kind}.approve`,
      meta: { amount: toNum(e.amount), date: e.date, member: names.get(e.membershipId) },
    });
    res.json({ entry: await respondOne(u) });
  });

  r.post(`/${path}/:id/reject`, requireAdmin, async (req, res) => {
    const body = parse(z.object({ reason: z.string().trim().min(2).max(200) }), req.body);
    const { e, month } = await loadEntry(req);
    assertOpen(month);
    const [u] = await db
      .update(table)
      .set({ status: "REJECTED", rejectReason: body.reason, reviewedById: req.user!.id, reviewedAt: new Date() })
      .where(eq(table.id, e.id))
      .returning();
    const names = await membershipNames([e.membershipId]);
    await logActivity(db, {
      messId: req.mess!.id,
      user: req.user!,
      action: `${kind}.reject`,
      meta: { amount: toNum(e.amount), date: e.date, member: names.get(e.membershipId), reason: body.reason },
    });
    res.json({ entry: await respondOne(u) });
  });

  r.delete(`/${path}/:id`, async (req, res) => {
    const { e, month } = await loadEntry(req);
    assertOpen(month);
    const isAdmin = req.membership!.role === "ADMIN";
    const own = e.membershipId === req.membership!.id || e.createdById === req.user!.id;
    if (!isAdmin && !(own && e.status !== "APPROVED")) {
      throw forbidden("CANNOT_DELETE_ENTRY", "Only pending entries you added can be deleted");
    }
    // Soft delete: the row stays for the record
    await db.update(table).set({ deletedAt: new Date() }).where(eq(table.id, e.id));
    const names = await membershipNames([e.membershipId]);
    await logActivity(db, {
      messId: req.mess!.id,
      user: req.user!,
      action: `${kind}.delete`,
      meta: { amount: toNum(e.amount), date: e.date, member: names.get(e.membershipId), status: e.status },
    });
    res.json({ ok: true });
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp|heic|heif)$/.test(file.mimetype)),
});

export function registerLedgerRoutes(r: Router) {
  registerEntryKind(r, "bazar");
  registerEntryKind(r, "deposit");

  // ---- Shared (fixed) costs --------------------------------------------------------
  r.get("/months/:monthId/costs", async (req, res) => {
    const month = await getMonthOr404(req.mess!.id, String(req.params.monthId));
    const rows = await db
      .select()
      .from(fixedCosts)
      .where(and(eq(fixedCosts.monthId, month.id), isNull(fixedCosts.deletedAt)))
      .orderBy(desc(fixedCosts.date));
    res.json({ costs: rows.map((c) => ({ id: c.id, title: c.title, amount: toNum(c.amount), date: c.date, createdAt: c.createdAt })) });
  });

  r.post("/months/:monthId/costs", requireAdmin, async (req, res) => {
    const month = await getMonthOr404(req.mess!.id, String(req.params.monthId));
    assertOpen(month);
    const body = parse(z.object({ title: z.string().trim().min(2).max(80), amount: zAmount, date: zDate }), req.body);
    assertDateInMonth(month, body.date);
    const [c] = await db
      .insert(fixedCosts)
      .values({ monthId: month.id, title: body.title, amount: money(body.amount), date: body.date, createdById: req.user!.id })
      .returning();
    await logActivity(db, { messId: req.mess!.id, user: req.user!, action: "cost.create", meta: { title: c.title, amount: toNum(c.amount) } });
    res.status(201).json({ cost: { id: c.id, title: c.title, amount: toNum(c.amount), date: c.date, createdAt: c.createdAt } });
  });

  r.delete("/costs/:id", requireAdmin, async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound("ENTRY_NOT_FOUND");
    const [c] = await db
      .select()
      .from(fixedCosts)
      .where(and(eq(fixedCosts.id, id), isNull(fixedCosts.deletedAt)))
      .limit(1);
    if (!c) throw notFound("ENTRY_NOT_FOUND");
    const month = await getMonthOr404(req.mess!.id, c.monthId).catch(() => {
      throw notFound("ENTRY_NOT_FOUND");
    });
    assertOpen(month);
    await db.update(fixedCosts).set({ deletedAt: new Date() }).where(eq(fixedCosts.id, c.id));
    await logActivity(db, { messId: req.mess!.id, user: req.user!, action: "cost.delete", meta: { title: c.title, amount: toNum(c.amount) } });
    res.json({ ok: true });
  });

  // ---- Bazar duty -------------------------------------------------------------------
  r.get("/months/:monthId/duties", async (req, res) => {
    const month = await getMonthOr404(req.mess!.id, String(req.params.monthId));
    const rows = await db
      .select({ date: bazarDuties.date, membershipId: bazarDuties.membershipId, name: users.name })
      .from(bazarDuties)
      .innerJoin(memberships, eq(memberships.id, bazarDuties.membershipId))
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(bazarDuties.monthId, month.id))
      .orderBy(asc(bazarDuties.date), asc(users.name));
    res.json({ duties: rows });
  });

  r.put("/months/:monthId/duties", requireAdmin, async (req, res) => {
    const month = await getMonthOr404(req.mess!.id, String(req.params.monthId));
    assertOpen(month);
    const body = parse(z.object({ date: zDate, membershipIds: z.array(zUuid).max(10) }), req.body);
    assertDateInMonth(month, body.date);
    const ids = await monthMembershipIds(month.id);
    for (const id of body.membershipIds) if (!ids.has(id)) throw badRequest("MEMBER_NOT_IN_MONTH");
    await db.transaction(async (tx) => {
      await tx.delete(bazarDuties).where(and(eq(bazarDuties.monthId, month.id), eq(bazarDuties.date, body.date)));
      const uniq = [...new Set(body.membershipIds)];
      if (uniq.length) {
        await tx.insert(bazarDuties).values(uniq.map((membershipId) => ({ monthId: month.id, date: body.date, membershipId })));
      }
    });
    await logActivity(db, { messId: req.mess!.id, user: req.user!, action: "duty.set", meta: { date: body.date, count: body.membershipIds.length } });
    res.json({ ok: true });
  });

  // ---- Activity log ------------------------------------------------------------------
  r.get("/activity", async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
    const before = typeof req.query.before === "string" && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before) : null;
    const rows = await db
      .select()
      .from(activityLogs)
      .where(and(eq(activityLogs.messId, req.mess!.id), before ? lt(activityLogs.createdAt, before) : undefined))
      .orderBy(desc(activityLogs.createdAt))
      .limit(limit);
    res.json({ logs: rows, hasMore: rows.length === limit });
  });

  // ---- Receipt upload ---------------------------------------------------------------
  r.post("/uploads/receipt", (req, res, next) => {
    if (!uploadsEnabled) throw conflict("UPLOAD_DISABLED", "Receipt photos are not set up on this server");
    upload.single("file")(req, res, async (err?: unknown) => {
      try {
        if (err) {
          const code = (err as { code?: string }).code === "LIMIT_FILE_SIZE" ? "FILE_TOO_LARGE" : "UPLOAD_FAILED";
          throw badRequest(code, code === "FILE_TOO_LARGE" ? "Photo must be under 5 MB" : "Upload failed");
        }
        if (!req.file) throw badRequest("IMAGE_REQUIRED", "Choose a photo (JPG, PNG or WebP)");
        const receiptId = await uploadReceipt(req.mess!.id, req.file.buffer);
        res.status(201).json({ receiptId, url: receiptUrl(receiptId) });
      } catch (e) {
        next(e);
      }
    });
  });
}
