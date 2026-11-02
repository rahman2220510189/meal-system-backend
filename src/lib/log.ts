import { db, type Tx } from "../db";
import { activityLogs } from "../db/schema";

export async function logActivity(
  tx: Tx | typeof db,
  p: { messId: string; user: { id: string; name: string } | null; action: string; meta?: Record<string, unknown> },
) {
  await tx.insert(activityLogs).values({
    messId: p.messId,
    userId: p.user?.id ?? null,
    userName: p.user?.name ?? "System",
    action: p.action,
    meta: p.meta ?? null,
  });
}
