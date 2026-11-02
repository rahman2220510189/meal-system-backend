import { Router } from "express";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { hashPassword, signToken, verifyPassword } from "../lib/auth";
import { parse } from "../lib/validate";
import { conflict, unauthorized, badRequest } from "../lib/errors";
import { requireAuth } from "../middleware/auth";

export const authRouter = Router();

const zName = z.string().trim().min(2).max(60);
const zEmail = z.string().trim().toLowerCase().email().max(120);
const zPassword = z.string().min(6).max(100);
const zLang = z.enum(["bn", "en"]);
const zPhone = z
  .string()
  .trim()
  .max(20)
  .regex(/^[0-9+\-\s]*$/, "Digits only")
  .optional()
  .transform((v) => (v ? v : null));

export function publicUser(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    language: u.language,
    mustChangePassword: u.mustChangePassword,
    createdAt: u.createdAt,
  };
}

authRouter.post("/register", async (req, res) => {
  const body = parse(
    z.object({ name: zName, email: zEmail, password: zPassword, phone: zPhone, language: zLang.default("bn") }),
    req.body,
  );
  const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
  if (exists) throw conflict("EMAIL_TAKEN", "This email already has an account");
  const [u] = await db
    .insert(users)
    .values({
      name: body.name,
      email: body.email,
      phone: body.phone,
      language: body.language,
      passwordHash: await hashPassword(body.password),
    })
    .returning();
  res.status(201).json({ token: signToken(u.id, u.tokenVersion), user: publicUser(u) });
});

authRouter.post("/login", async (req, res) => {
  const body = parse(z.object({ email: zEmail, password: z.string().min(1).max(100) }), req.body);
  const [u] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
  // Same error for unknown email and wrong password
  if (!u || !(await verifyPassword(body.password, u.passwordHash))) {
    throw unauthorized("INVALID_LOGIN", "Email or password is wrong");
  }
  res.json({ token: signToken(u.id, u.tokenVersion), user: publicUser(u) });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  res.json({ user: publicUser(req.user!) });
});

authRouter.patch("/me", requireAuth, async (req, res) => {
  const body = parse(z.object({ name: zName.optional(), phone: zPhone, language: zLang.optional() }), req.body);
  const patch: Partial<typeof users.$inferInsert> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (req.body?.phone !== undefined) patch.phone = body.phone;
  if (body.language !== undefined) patch.language = body.language;
  if (!Object.keys(patch).length) throw badRequest("NOTHING_TO_UPDATE");
  const [u] = await db.update(users).set(patch).where(eq(users.id, req.user!.id)).returning();
  res.json({ user: publicUser(u) });
});

authRouter.post("/change-password", requireAuth, async (req, res) => {
  const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: zPassword }), req.body);
  const u = req.user!;
  if (!(await verifyPassword(body.currentPassword, u.passwordHash))) {
    throw badRequest("WRONG_PASSWORD", "Current password is wrong");
  }
  const [updated] = await db
    .update(users)
    .set({
      passwordHash: await hashPassword(body.newPassword),
      mustChangePassword: false,
      tokenVersion: sql`${users.tokenVersion} + 1`,
    })
    .where(eq(users.id, u.id))
    .returning();
  // Old sessions are signed out; this one gets a fresh token
  res.json({ token: signToken(updated.id, updated.tokenVersion), user: publicUser(updated) });
});
