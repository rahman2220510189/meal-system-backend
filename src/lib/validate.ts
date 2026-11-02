import { z } from "zod";
import { badRequest } from "./errors";
import { isValidDate } from "./dates";

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const details = r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw badRequest("VALIDATION", details[0] ? `${details[0].path}: ${details[0].message}` : "Invalid input", details);
  }
  return r.data;
}

export const zDate = z.string().refine(isValidDate, "Invalid date (YYYY-MM-DD)");
export const zAmount = z.coerce
  .number()
  .positive()
  .max(10_000_000)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, "At most 2 decimals");
export const zUuid = z.string().uuid();
export const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
export const zGuest = z.coerce.number().int().min(0).max(50);
