import type { InferSelectModel } from "drizzle-orm";
import type { users, memberships, messes } from "./db/schema";

declare global {
  namespace Express {
    interface Request {
      user?: InferSelectModel<typeof users>;
      membership?: InferSelectModel<typeof memberships>;
      mess?: InferSelectModel<typeof messes>;
    }
  }
}

export {};
