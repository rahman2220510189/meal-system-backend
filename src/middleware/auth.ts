import type { Request, Response, NextFunction } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { users, memberships, messes } from "../db/schema";
import { readToken } from "../lib/auth";
import { forbidden, notFound, unauthorized } from "../lib/errors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID_RE.test(s);

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const payload = token ? readToken(token) : null;
  if (!payload || !isUuid(payload.sub)) throw unauthorized();
  const [user] = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
  if (!user || user.tokenVersion !== payload.tv) throw unauthorized("SESSION_EXPIRED", "Please sign in again");
  req.user = user;
  next();
}

/**
 * Loads the mess from :messId and checks that the signed-in user is an APPROVED member.
 * A non-member gets 404 (not 403) so mess ids cannot be probed.
 */
export async function requireMember(req: Request, _res: Response, next: NextFunction) {
  const messId = req.params.messId;
  if (!isUuid(messId)) throw notFound("MESS_NOT_FOUND");
  const [row] = await db
    .select({ membership: memberships, mess: messes })
    .from(memberships)
    .innerJoin(messes, eq(messes.id, memberships.messId))
    .where(and(eq(memberships.messId, messId), eq(memberships.userId, req.user!.id), eq(memberships.status, "APPROVED")))
    .limit(1);
  if (!row) throw notFound("MESS_NOT_FOUND");
  req.membership = row.membership;
  req.mess = row.mess;
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.membership?.role !== "ADMIN") throw forbidden("ADMIN_ONLY", "Only the mess admin can do this");
  next();
}
