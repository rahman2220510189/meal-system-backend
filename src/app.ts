import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { env, uploadsEnabled } from "./env";
import { ApiError } from "./lib/errors";
import { requireAuth } from "./middleware/auth";
import { authRouter } from "./routes/auth";
import { messRouter, messScopedRouter } from "./routes/messes";
import { registerMonthRoutes } from "./routes/months";
import { registerLedgerRoutes } from "./routes/ledger";
import { pool } from "./db";

registerMonthRoutes(messScopedRouter);
registerLedgerRoutes(messScopedRouter);

export function createApp() {
  const app = express();
  app.set("trust proxy", 1); // Render sits behind a proxy
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => {
        // Allow server-to-server / curl (no origin) and configured frontends (+ Vercel previews of the same project)
        if (!origin) return cb(null, true);
        const o = origin.replace(/\/$/, "");
        const ok = env.FRONTEND_URLS.includes(o) || env.FRONTEND_URLS.includes("*");
        cb(null, ok);
      },
      credentials: false,
      allowedHeaders: ["Content-Type", "Authorization"],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      maxAge: 86400,
    }),
  );
  app.use(express.json({ limit: "100kb" }));

  const isTest = env.NODE_ENV === "test";
  app.use(
    "/api",
    rateLimit({ windowMs: 60_000, limit: isTest ? 100_000 : 300, standardHeaders: "draft-8", legacyHeaders: false }),
  );
  const authLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: isTest ? 100_000 : 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: { code: "TOO_MANY_ATTEMPTS", message: "Too many attempts. Try again in 15 minutes." } }),
  });

  app.get("/", (_req, res) => res.json({ name: "Meal System API", status: "ok" }));
  app.get("/api/health", async (_req, res) => {
    try {
      await pool.query("select 1");
      res.json({ status: "ok", db: "ok" });
    } catch {
      res.status(503).json({ status: "degraded", db: "down" });
    }
  });
  app.get("/api/config", (_req, res) => res.json({ uploads: uploadsEnabled }));

  app.use("/api/auth/login", authLimiter);
  app.use("/api/auth/register", authLimiter);
  app.use("/api/auth", authRouter);
  app.use("/api/messes", requireAuth, messRouter);

  app.use((_req, res) => res.status(404).json({ error: { code: "ROUTE_NOT_FOUND", message: "Route not found" } }));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as { type?: string; status?: number };
    if (e?.type === "entity.parse.failed") {
      return res.status(400).json({ error: { code: "BAD_JSON", message: "Invalid JSON body" } });
    }
    if (e?.type === "entity.too.large") {
      return res.status(413).json({ error: { code: "TOO_LARGE", message: "Request is too large" } });
    }
    console.error(err);
    res.status(500).json({ error: { code: "SERVER_ERROR", message: "Something went wrong on the server" } });
  });

  return app;
}
