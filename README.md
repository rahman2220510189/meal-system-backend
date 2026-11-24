<div align="center">

**English** · [বাংলা](README.bn.md)

# 🍚 Meal System — Backend API

API server for tracking meals, bazar (groceries) and money in shared messes.

`Node.js 22` · `Express 5` · `TypeScript` · `Drizzle ORM` · `PostgreSQL (Neon)`

The website (frontend) lives in a separate repo.

</div>

---

## Quick start

```
npm install
copy .env.example .env      (Mac/Linux: cp .env.example .env)
```

Open `.env`, fill in `DATABASE_URL`, `DIRECT_URL` and `JWT_SECRET`, then:

```
npm run db:migrate
npm run dev
```

The API runs on **http://localhost:4000** — check http://localhost:4000/api/health

Generate a `JWT_SECRET`:

```
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Demo data (optional): `npm run seed:demo` → log in with `demo@mealsystem.app` / `demo1234`

---

## Environment variables

| Key | Value | Required |
|---|---|:---:|
| `DATABASE_URL` | Neon → Connect → connection pooling **on** (`-pooler`) | ✅ |
| `DIRECT_URL` | Neon → Connect → connection pooling **off** (used for migrations) | ✅ |
| `JWT_SECRET` | Long random secret | ✅ |
| `FRONTEND_URL` | Website address; separate several with commas | ✅ |
| `PORT` | `4000` locally; Render sets its own | — |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | For receipt photos | optional |

---

## Deploying to Render

**Blueprint (easiest):** Render → **New → Blueprint** → this repo. Everything comes from `render.yaml`.

**Web Service (manual) — you must set:**

| Setting | Value |
|---|---|
| Region | Singapore |
| Build Command | `npm install --include=dev && npm run build` |
| Start Command | `npm run start:prod` |
| Health Check Path | `/api/health` |
| Environment | `NODE_VERSION=22`, `NODE_ENV=production`, plus the variables above (no quotes) |

`start:prod` runs database migrations before every start. A successful log shows:

```
✔ Database is up to date
✔ Meal System API running on ...
```

After deploying the website to Vercel, set `FRONTEND_URL` to its address.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server (restarts on file changes) |
| `npm run build` | TypeScript → `dist/` |
| `npm start` | Start the built server |
| `npm run start:prod` | Migrations + server (production) |
| `npm run db:migrate` | Run database migrations |
| `npm run db:generate` | Create a new migration after editing `src/db/schema.ts` |
| `npm run db:studio` | Browse the database in your browser |
| `npm run seed:demo` | Demo data |
| `npm run reset-password -- email` | Reset anyone's password (add `--password newPass` to set one) |
| `npm test` | 33 tests |

> ⚠️ Tests wipe and rebuild their database — **never run them against your real Neon database.** Use a local PostgreSQL `meal_test` database or set `TEST_DATABASE_URL`.

---

## Forgotten passwords

Admins can reset members' passwords in the app. If **the only admin** forgets theirs, the site owner runs this from their own computer (it uses `DATABASE_URL` from `.env`):

```
npm run reset-password -- admin@email.com
npm run reset-password -- admin@email.com --password newPass123
```

The first prints a temporary password that must be changed after login; the second sets the given password. All old sessions are signed out.

---

## Structure

```
src/
├── index.ts            → starts the server
├── app.ts              → Express, security, rate limits, error handling
├── env.ts              → reads environment variables
├── db/
│   ├── schema.ts       → all tables
│   ├── migrate.ts      → migrations (explains connection problems clearly)
│   └── url.ts          → cleans up pasted database URLs
├── lib/
│   ├── calc.ts         → every meal-rate and balance calculation
│   ├── auth.ts         → passwords, tokens, join codes
│   └── dates.ts        → dates in Bangladesh time
├── middleware/auth.ts  → login, member and admin checks
├── routes/             → auth, messes, months (meals), ledger (bazar/deposits/costs)
└── services/months.ts  → builds the monthly summary
```

## API at a glance

All routes require `Authorization: Bearer <token>` (except login, register and health).

| | Routes |
|---|---|
| Auth | `POST /api/auth/register`, `POST /api/auth/login`, `GET/PATCH /api/auth/me`, `POST /api/auth/change-password` |
| Messes | `GET/POST /api/messes`, `POST /api/messes/join`, `GET /api/messes/preview/:code` |
| Inside a mess | `/api/messes/:messId/...` → `members`, `months`, `months/:id/meals`, `months/:id/bazar`, `months/:id/deposits`, `months/:id/costs`, `months/:id/duties`, `activity` |
| Health | `GET /api/health` → `{"status":"ok","db":"ok"}` |

Errors always have the same shape: `{ "error": { "code": "MONTH_CLOSED", "message": "..." } }`
