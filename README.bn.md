<div align="center">

[English](README.md) · **বাংলা**

# 🍚 মিল সিস্টেম — Backend API

মেসের মিল, বাজার আর টাকার হিসাবের API সার্ভার।

`Node.js 22` · `Express 5` · `TypeScript` · `Drizzle ORM` · `PostgreSQL (Neon)`

ওয়েবসাইট (frontend) আলাদা রিপোতে থাকে।

</div>

---

## দ্রুত শুরু

```
npm install
copy .env.example .env      (Mac/Linux: cp .env.example .env)
```

`.env` খুলে `DATABASE_URL`, `DIRECT_URL` আর `JWT_SECRET` বসান, তারপর:

```
npm run db:migrate
npm run dev
```

API চলবে **http://localhost:4000** — যাচাই: http://localhost:4000/api/health

`JWT_SECRET` বানাতে:

```
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

ডেমো ডেটা (ঐচ্ছিক): `npm run seed:demo` → লগইন `demo@mealsystem.app` / `demo1234`

---

## Environment ভেরিয়েবল

| Key | কী | বাধ্যতামূলক |
|---|---|:---:|
| `DATABASE_URL` | Neon → Connect → Connection pooling **চালু** (`-pooler`) | ✅ |
| `DIRECT_URL` | Neon → Connect → Connection pooling **বন্ধ** (মাইগ্রেশনের জন্য) | ✅ |
| `JWT_SECRET` | লম্বা গোপন লেখা | ✅ |
| `FRONTEND_URL` | ওয়েবসাইটের ঠিকানা, একাধিক হলে কমা দিয়ে | ✅ |
| `PORT` | লোকালে `4000`, Render নিজে দেয় | — |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | রশিদের ছবির জন্য | ঐচ্ছিক |

---

## Render-এ ডিপ্লয়

**Blueprint (সহজ):** Render → **New → Blueprint** → এই রিপো। `render.yaml` থেকে সব সেটিং নিজে আসবে।

**Web Service (হাতে) হলে অবশ্যই:**

| সেটিং | মান |
|---|---|
| Region | Singapore |
| Build Command | `npm install --include=dev && npm run build` |
| Start Command | `npm run start:prod` |
| Health Check Path | `/api/health` |
| Environment | `NODE_VERSION=22`, `NODE_ENV=production`, আর উপরের ভেরিয়েবলগুলো (উদ্ধৃতিচিহ্ন ছাড়া) |

`start:prod` প্রতিবার চালু হওয়ার আগে ডাটাবেস মাইগ্রেশন চালায়। সফল হলে লগে:

```
✔ Database is up to date
✔ Meal System API running on ...
```

Vercel-এ ওয়েবসাইট তোলার পর `FRONTEND_URL`-এ তার ঠিকানা বসাতে ভুলবেন না।

---

## কমান্ড

| কমান্ড | কাজ |
|---|---|
| `npm run dev` | ডেভেলপমেন্ট সার্ভার (ফাইল বদলালে রিস্টার্ট) |
| `npm run build` | TypeScript → `dist/` |
| `npm start` | বিল্ড করা সার্ভার চালু |
| `npm run start:prod` | মাইগ্রেশন + সার্ভার (production) |
| `npm run db:migrate` | ডাটাবেস মাইগ্রেশন |
| `npm run db:generate` | `src/db/schema.ts` বদলালে নতুন মাইগ্রেশন বানানো |
| `npm run db:studio` | ব্রাউজারে ডাটাবেস দেখা |
| `npm run seed:demo` | ডেমো ডেটা |
| `npm run reset-password -- email` | যেকারো পাসওয়ার্ড রিসেট (নির্দিষ্ট পাসওয়ার্ড দিতে `--password নতুনপাস`) |
| `npm test` | ৩৩টা টেস্ট |

> ⚠️ টেস্ট ডাটাবেস মুছে নতুন করে বানায় — **Neon-এর আসল ডাটাবেসে চালাবেন না।** লোকাল PostgreSQL-এ `meal_test` ডাটাবেস বা `TEST_DATABASE_URL` দিন।

---

## পাসওয়ার্ড ভুলে গেলে

অ্যাডমিন অ্যাপ থেকেই মেম্বারদের পাসওয়ার্ড রিসেট করতে পারে। **একমাত্র অ্যাডমিন** ভুলে গেলে সাইটের মালিক নিজের কম্পিউটার থেকে চালাবে (`.env`-এর `DATABASE_URL` ব্যবহার করে):

```
npm run reset-password -- admin@email.com
npm run reset-password -- admin@email.com --password newPass123
```

প্রথমটা একটা অস্থায়ী পাসওয়ার্ড দেখায়, যেটা লগইনের পর বদলাতে হবে। দ্বিতীয়টা দেওয়া পাসওয়ার্ডই বসিয়ে দেয়। পুরোনো সব লগইন বাতিল হয়।

---

## গঠন

```
src/
├── index.ts            → সার্ভার চালু
├── app.ts              → Express, নিরাপত্তা, রেট লিমিট, এরর হ্যান্ডলিং
├── env.ts              → environment ভেরিয়েবল পড়া
├── db/
│   ├── schema.ts       → সব টেবিল
│   ├── migrate.ts      → মাইগ্রেশন (সংযোগের সমস্যা স্পষ্ট করে বলে)
│   └── url.ts          → ডাটাবেসের ঠিকানা পরিষ্কার করা
├── lib/
│   ├── calc.ts         → মিল রেট আর ব্যালেন্সের সব হিসাব
│   ├── auth.ts         → পাসওয়ার্ড, টোকেন, জয়েন কোড
│   └── dates.ts        → বাংলাদেশ সময় ধরে তারিখ
├── middleware/auth.ts  → লগইন, মেম্বার আর অ্যাডমিন চেক
├── routes/             → auth, messes, months (মিল), ledger (বাজার/জমা/খরচ)
└── services/months.ts  → মাসের সারাংশ তৈরি
```

## API এক নজরে

সব রাউট `Authorization: Bearer <token>` চায় (লগইন/রেজিস্টার আর health ছাড়া)।

| | রাউট |
|---|---|
| লগইন | `POST /api/auth/register`, `POST /api/auth/login`, `GET/PATCH /api/auth/me`, `POST /api/auth/change-password` |
| মেস | `GET/POST /api/messes`, `POST /api/messes/join`, `GET /api/messes/preview/:code` |
| মেসের ভেতরে | `/api/messes/:messId/...` → `members`, `months`, `months/:id/meals`, `months/:id/bazar`, `months/:id/deposits`, `months/:id/costs`, `months/:id/duties`, `activity` |
| স্বাস্থ্য | `GET /api/health` → `{"status":"ok","db":"ok"}` |

এরর সবসময় একই আকারে আসে: `{ "error": { "code": "MONTH_CLOSED", "message": "..." } }`
