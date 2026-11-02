import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { pool } from "../src/db";
import { todayDhaka, currentYearMonthDhaka, monthEnd, addDays } from "../src/lib/dates";

const app = createApp();
const api = () => request(app);

type Session = { token: string; user: { id: string; name: string } };

async function register(name: string, email: string, password = "secret123"): Promise<Session> {
  const r = await api().post("/api/auth/register").send({ name, email, password });
  expect(r.status).toBe(201);
  return r.body;
}
const auth = (s: Session) => ({ Authorization: `Bearer ${s.token}` });

let admin: Session;
let rahim: Session;
let karim: Session;
let outsider: Session;
let messId: string;
let monthId: string;
let code: string;
let rahimMid: string;
let karimMid: string;
let adminMid: string;
const today = todayDhaka();
const { year, month } = currentYearMonthDhaka();
const lastDay = monthEnd(year, month);

beforeAll(async () => {
  admin = await register("Admin Bhai", "admin@test.com");
  rahim = await register("Rahim", "rahim@test.com");
  karim = await register("Karim", "karim@test.com");
  outsider = await register("Outsider", "out@test.com");
});

afterAll(async () => {
  await pool.end();
});

describe("auth", () => {
  it("rejects duplicate email, wrong password and missing token", async () => {
    expect((await api().post("/api/auth/register").send({ name: "X", email: "admin@test.com", password: "secret123" })).status).toBe(400);
    const dup = await api().post("/api/auth/register").send({ name: "Admin Two", email: "ADMIN@test.com", password: "secret123" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("EMAIL_TAKEN");
    const bad = await api().post("/api/auth/login").send({ email: "admin@test.com", password: "nope" });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("INVALID_LOGIN");
    expect((await api().get("/api/messes")).status).toBe(401);
    expect((await api().get("/api/messes").set({ Authorization: "Bearer garbage" })).status).toBe(401);
  });

  it("logs in and updates language", async () => {
    const r = await api().post("/api/auth/login").send({ email: "rahim@test.com", password: "secret123" });
    expect(r.status).toBe(200);
    const u = await api().patch("/api/auth/me").set(auth(rahim)).send({ language: "en" });
    expect(u.body.user.language).toBe("en");
  });
});

describe("mess setup and joining", () => {
  it("creates a mess with the current month open", async () => {
    const r = await api().post("/api/messes").set(auth(admin)).send({ name: "Mess A", mealsPerDay: 2 });
    expect(r.status).toBe(201);
    messId = r.body.mess.id;
    code = r.body.mess.code;
    adminMid = r.body.membershipId;
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    const d = await api().get(`/api/messes/${messId}`).set(auth(admin));
    expect(d.body.months).toHaveLength(1);
    expect(d.body.months[0]).toMatchObject({ year, month, status: "OPEN", mealsPerDay: 2 });
    monthId = d.body.months[0].id;
  });

  it("lets people request to join and only shows the mess after approval", async () => {
    const p = await api().get(`/api/messes/preview/${code}`).set(auth(rahim));
    expect(p.body.name).toBe("Mess A");
    expect((await api().post("/api/messes/join").set(auth(rahim)).send({ code: code.toLowerCase() })).status).toBe(201);
    expect((await api().post("/api/messes/join").set(auth(karim)).send({ code })).status).toBe(201);
    const again = await api().post("/api/messes/join").set(auth(rahim)).send({ code });
    expect(again.body.error.code).toBe("ALREADY_REQUESTED");
    // Pending member cannot open the mess yet
    expect((await api().get(`/api/messes/${messId}`).set(auth(rahim))).status).toBe(404);
    const mine = await api().get("/api/messes").set(auth(rahim));
    expect(mine.body.messes[0].status).toBe("PENDING");
  });

  it("only admins approve, and approval adds default-ON meals from today", async () => {
    const list = await api().get(`/api/messes/${messId}/members`).set(auth(admin));
    rahimMid = list.body.members.find((m: { name: string }) => m.name === "Rahim").membershipId;
    karimMid = list.body.members.find((m: { name: string }) => m.name === "Karim").membershipId;
    expect((await api().post(`/api/messes/${messId}/members/${rahimMid}/approve`).set(auth(admin))).status).toBe(200);
    expect((await api().post(`/api/messes/${messId}/members/${karimMid}/approve`).set(auth(admin))).status).toBe(200);
    // Approved member cannot approve
    expect((await api().post(`/api/messes/${messId}/members/${karimMid}/approve`).set(auth(rahim))).status).toBe(403);
    const meals = await api().get(`/api/messes/${messId}/months/${monthId}/meals`).set(auth(rahim));
    expect(meals.status).toBe(200);
    expect(meals.body.entries[0].date).toBe(today);
    expect(meals.body.entries.at(-1).date).toBe(lastDay);
    expect(meals.body.entries.every((e: { lunch: boolean; dinner: boolean }) => e.lunch && e.dinner)).toBe(true);
  });
});

describe("mess isolation (security)", () => {
  let messB: string;
  let monthB: string;
  let bazarA: string;

  it("an outsider cannot see or change another mess", async () => {
    const b = await api().post("/api/messes").set(auth(outsider)).send({ name: "Mess B" });
    messB = b.body.mess.id;
    monthB = (await api().get(`/api/messes/${messB}`).set(auth(outsider))).body.months[0].id;

    const ba = await api()
      .post(`/api/messes/${messId}/months/${monthId}/bazar`)
      .set(auth(admin))
      .send({ date: today, amount: 100, items: "isolation probe" });
    bazarA = ba.body.entry.id;

    for (const path of [
      `/api/messes/${messId}`,
      `/api/messes/${messId}/members`,
      `/api/messes/${messId}/months/${monthId}`,
      `/api/messes/${messId}/months/${monthId}/bazar`,
      `/api/messes/${messId}/activity`,
    ]) {
      expect((await api().get(path).set(auth(outsider))).status).toBe(404);
    }
    // Using own mess id with another mess's month or entry
    expect((await api().get(`/api/messes/${messB}/months/${monthId}`).set(auth(outsider))).status).toBe(404);
    expect((await api().post(`/api/messes/${messB}/bazar/${bazarA}/approve`).set(auth(outsider))).status).toBe(404);
    expect((await api().delete(`/api/messes/${messB}/bazar/${bazarA}`).set(auth(outsider))).status).toBe(404);
    expect((await api().post(`/api/messes/${messB}/members/${rahimMid}/remove`).set(auth(outsider))).status).toBe(404);
    // Admin of B cannot reference A's members in B's month
    const cross = await api()
      .post(`/api/messes/${messB}/months/${monthB}/deposits`)
      .set(auth(outsider))
      .send({ date: today, amount: 50, membershipId: rahimMid });
    expect(cross.status).toBe(400);
    // Clean up probe
    expect((await api().delete(`/api/messes/${messId}/bazar/${bazarA}`).set(auth(admin))).status).toBe(200);
  });

  it("members only see their own mess code when admin", async () => {
    const r = await api().get(`/api/messes/${messId}`).set(auth(rahim));
    expect(r.body.mess.code).toBeUndefined();
    const m = await api().get(`/api/messes/${messId}/members`).set(auth(rahim));
    expect(m.body.members[0].email).toBeUndefined();
  });
});

describe("meals", () => {
  it("members change only their own meals; admins change anyone's", async () => {
    const other = await api().put(`/api/messes/${messId}/months/${monthId}/meals`).set(auth(rahim)).send({ membershipId: karimMid, date: lastDay, lunch: false });
    expect(other.status).toBe(403);
    const admEdit = await api().put(`/api/messes/${messId}/months/${monthId}/meals`).set(auth(admin)).send({ membershipId: karimMid, date: today, lunch: false, guestDinner: 2 });
    expect(admEdit.status).toBe(200);
    expect(admEdit.body.entry).toMatchObject({ lunch: false, guestDinner: 2 });
  });

  it("members can change future days and bulk-switch a range", async () => {
    if (lastDay === today) return; // last day of month: no future day to test
    const r = await api().put(`/api/messes/${messId}/months/${monthId}/meals`).set(auth(rahim)).send({ date: lastDay, dinner: false, guestLunch: 3 });
    expect(r.status).toBe(200);
    const from = addDays(today, 1);
    const bulk = await api().post(`/api/messes/${messId}/months/${monthId}/meals/bulk`).set(auth(rahim)).send({ from, to: lastDay, lunch: false });
    expect(bulk.status).toBe(200);
    expect(bulk.body.updated).toBeGreaterThan(0);
    const back = await api().post(`/api/messes/${messId}/months/${monthId}/meals/bulk`).set(auth(rahim)).send({ from, to: lastDay, lunch: true });
    expect(back.body.updated).toBe(bulk.body.updated);
  });

  it("rejects invalid input", async () => {
    const bad = await api().put(`/api/messes/${messId}/months/${monthId}/meals`).set(auth(admin)).send({ date: "2026-13-40", lunch: true });
    expect(bad.status).toBe(400);
    const neg = await api().put(`/api/messes/${messId}/months/${monthId}/meals`).set(auth(admin)).send({ date: today, guestLunch: -1 });
    expect(neg.status).toBe(400);
    const outside = await api().put(`/api/messes/${messId}/months/${monthId}/meals`).set(auth(admin)).send({ date: "2020-01-01", lunch: true });
    expect(outside.body.error.code).toBe("DATE_OUTSIDE_MONTH");
  });
});

describe("bazar and deposits with approval", () => {
  let pendingBazar: string;

  it("member bazar is pending and not counted until approved", async () => {
    const b = await api().post(`/api/messes/${messId}/months/${monthId}/bazar`).set(auth(rahim)).send({ date: today, amount: 1200.5, items: "চাল, ডাল" });
    expect(b.status).toBe(201);
    expect(b.body.entry.status).toBe("PENDING");
    pendingBazar = b.body.entry.id;
    let s = await api().get(`/api/messes/${messId}/months/${monthId}`).set(auth(rahim));
    expect(s.body.totals.bazar).toBe(0);
    expect(s.body.totals.pendingBazarCount).toBe(1);
    // A member cannot approve
    expect((await api().post(`/api/messes/${messId}/bazar/${pendingBazar}/approve`).set(auth(karim))).status).toBe(403);
    // Another member cannot edit it
    expect((await api().patch(`/api/messes/${messId}/bazar/${pendingBazar}`).set(auth(karim)).send({ amount: 1 })).status).toBe(403);
    expect((await api().post(`/api/messes/${messId}/bazar/${pendingBazar}/approve`).set(auth(admin))).status).toBe(200);
    s = await api().get(`/api/messes/${messId}/months/${monthId}`).set(auth(rahim));
    expect(s.body.totals.bazar).toBe(1200.5);
    // Approved entries are locked for the member
    expect((await api().delete(`/api/messes/${messId}/bazar/${pendingBazar}`).set(auth(rahim))).status).toBe(403);
  });

  it("rejects with a reason and lets the member resubmit", async () => {
    const d = await api().post(`/api/messes/${messId}/months/${monthId}/deposits`).set(auth(karim)).send({ date: today, amount: 500, note: "bkash" });
    const id = d.body.entry.id;
    const rej = await api().post(`/api/messes/${messId}/deposits/${id}/reject`).set(auth(admin)).send({ reason: "টাকা পাইনি" });
    expect(rej.body.entry).toMatchObject({ status: "REJECTED", rejectReason: "টাকা পাইনি" });
    const fix = await api().patch(`/api/messes/${messId}/deposits/${id}`).set(auth(karim)).send({ amount: 600 });
    expect(fix.body.entry).toMatchObject({ status: "PENDING", amount: 600 });
    await api().post(`/api/messes/${messId}/deposits/${id}/approve`).set(auth(admin));
  });

  it("admin entries are approved immediately and costs are shared", async () => {
    const d = await api().post(`/api/messes/${messId}/months/${monthId}/deposits`).set(auth(admin)).send({ date: today, amount: 2000, membershipId: rahimMid });
    expect(d.body.entry.status).toBe("APPROVED");
    const c = await api().post(`/api/messes/${messId}/months/${monthId}/costs`).set(auth(admin)).send({ title: "গ্যাস বিল", amount: 300, date: today });
    expect(c.status).toBe(201);
    expect((await api().post(`/api/messes/${messId}/months/${monthId}/costs`).set(auth(rahim)).send({ title: "x", amount: 1, date: today })).status).toBe(403);
  });

  it("deletes are soft and appear in the activity log", async () => {
    const b = await api().post(`/api/messes/${messId}/months/${monthId}/bazar`).set(auth(karim)).send({ date: today, amount: 99 });
    expect((await api().delete(`/api/messes/${messId}/bazar/${b.body.entry.id}`).set(auth(karim))).status).toBe(200);
    const log = await api().get(`/api/messes/${messId}/activity`).set(auth(rahim));
    expect(log.body.logs.some((l: { action: string }) => l.action === "bazar.delete")).toBe(true);
  });
});

describe("summary, duty and month close", () => {
  it("summary adds up", async () => {
    const s = await api().get(`/api/messes/${messId}/months/${monthId}`).set(auth(rahim));
    expect(s.status).toBe(200);
    const sumCost = s.body.members.reduce((a: number, m: { totalCost: number }) => a + m.totalCost, 0);
    expect(sumCost).toBeCloseTo(1200.5 + 300, 0);
    expect(s.body.totals.deposit).toBe(2600);
    expect(s.body.today.date).toBe(today);
    // Running month: meals are counted only up to today
    expect(s.body.countedUpTo).toBe(today);
    const own = s.body.members.find((m: { name: string }) => m.name === "Rahim").ownMeals;
    expect(own).toBeLessThanOrEqual(2);
    expect(s.body.daily).toHaveLength(Number(lastDay.slice(8)));
  });

  it("sets bazar duty", async () => {
    const r = await api().put(`/api/messes/${messId}/months/${monthId}/duties`).set(auth(admin)).send({ date: today, membershipIds: [rahimMid, karimMid] });
    expect(r.status).toBe(200);
    const s = await api().get(`/api/messes/${messId}/months/${monthId}`).set(auth(karim));
    expect(s.body.today.duty.map((d: { name: string }) => d.name).sort()).toEqual(["Karim", "Rahim"]);
  });

  it("enables fixed meals for the month", async () => {
    const r = await api().patch(`/api/messes/${messId}/months/${monthId}`).set(auth(admin)).send({ fixedMealEnabled: true, fixedMealMin: 40 });
    expect(r.body.month.fixedMealMin).toBe(40);
    const s = await api().get(`/api/messes/${messId}/months/${monthId}`).set(auth(admin));
    const a = s.body.members.find((m: { name: string }) => m.name === "Admin Bhai");
    expect(a.minMeals).toBeGreaterThan(0);
  });

  it("warns about pending items, closes, locks and carries balances forward", async () => {
    await api().post(`/api/messes/${messId}/months/${monthId}/bazar`).set(auth(karim)).send({ date: today, amount: 10 });
    const warn = await api().post(`/api/messes/${messId}/months/${monthId}/close`).set(auth(admin)).send({});
    expect(warn.status).toBe(409);
    expect(warn.body.error.code).toBe("PENDING_ITEMS");
    const closed = await api().post(`/api/messes/${messId}/months/${monthId}/close`).set(auth(admin)).send({ force: true });
    expect(closed.status).toBe(200);
    expect(closed.body.month.status).toBe("CLOSED");
    const rahimRow = closed.body.members.find((m: { name: string }) => m.name === "Rahim");
    expect(rahimRow.finalBalance).toBe(rahimRow.balance);

    // Locked
    const edit = await api().put(`/api/messes/${messId}/months/${monthId}/meals`).set(auth(admin)).send({ date: today, lunch: true });
    expect(edit.body.error.code).toBe("MONTH_CLOSED");

    // New month must be after the closed one
    const before = await api().post(`/api/messes/${messId}/months`).set(auth(admin)).send({ year, month, mealsPerDay: 3, fixedMealEnabled: false, fixedMealMin: 0 });
    expect(before.body.error.code).toBe("MONTH_NOT_AFTER_LAST");
    const ny = month === 12 ? year + 1 : year;
    const nm = month === 12 ? 1 : month + 1;
    const next = await api().post(`/api/messes/${messId}/months`).set(auth(admin)).send({ year: ny, month: nm, mealsPerDay: 3, fixedMealEnabled: false, fixedMealMin: 0 });
    expect(next.status).toBe(201);
    const s2 = await api().get(`/api/messes/${messId}/months/${next.body.month.id}`).set(auth(admin));
    const r2 = s2.body.members.find((m: { name: string }) => m.name === "Rahim");
    expect(r2.carryIn).toBe(rahimRow.balance);
    expect(s2.body.month.mealsPerDay).toBe(3);

    // Old month cannot be reopened any more (not the latest)
    expect((await api().post(`/api/messes/${messId}/months/${monthId}/reopen`).set(auth(admin))).body.error.code).toBe("NOT_LATEST_MONTH");
  });
});

describe("members management", () => {
  it("protects the last admin", async () => {
    const r = await api().post(`/api/messes/${messId}/members/${adminMid}/role`).set(auth(admin)).send({ role: "MEMBER" });
    expect(r.body.error.code).toBe("LAST_ADMIN");
    expect((await api().post(`/api/messes/${messId}/members/${adminMid}/remove`).set(auth(admin)).send({})).body.error.code).toBe("LAST_ADMIN");
  });

  it("can make another admin", async () => {
    expect((await api().post(`/api/messes/${messId}/members/${karimMid}/role`).set(auth(admin)).send({ role: "ADMIN" })).status).toBe(200);
    expect((await api().get(`/api/messes/${messId}`).set(auth(karim))).body.mess.code).toBeDefined();
    await api().post(`/api/messes/${messId}/members/${karimMid}/role`).set(auth(admin)).send({ role: "MEMBER" });
  });

  it("reset password signs the member out and forces a change", async () => {
    const r = await api().post(`/api/messes/${messId}/members/${rahimMid}/reset-password`).set(auth(admin));
    expect(r.body.tempPassword).toBeTruthy();
    expect((await api().get("/api/auth/me").set(auth(rahim))).status).toBe(401);
    const login = await api().post("/api/auth/login").send({ email: "rahim@test.com", password: r.body.tempPassword });
    expect(login.body.user.mustChangePassword).toBe(true);
    const ch = await api()
      .post("/api/auth/change-password")
      .set({ Authorization: `Bearer ${login.body.token}` })
      .send({ currentPassword: r.body.tempPassword, newPassword: "newpass123" });
    expect(ch.body.user.mustChangePassword).toBe(false);
    rahim = { token: ch.body.token, user: ch.body.user };
  });

  it("warns before removing a member with dues, then removes", async () => {
    // Give Karim a due in the new open month
    const d = await api().get(`/api/messes/${messId}`).set(auth(admin));
    const open = d.body.months.find((m: { status: string }) => m.status === "OPEN");
    await api().post(`/api/messes/${messId}/months/${open.id}/bazar`).set(auth(admin)).send({ date: open.start, amount: 5000 });
    const s = await api().get(`/api/messes/${messId}/months/${open.id}`).set(auth(admin));
    const k = s.body.members.find((m: { name: string }) => m.name === "Karim");
    const res = await api().post(`/api/messes/${messId}/members/${karimMid}/remove`).set(auth(admin)).send({});
    if (k.balance < 0) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("MEMBER_HAS_DUE");
      expect((await api().post(`/api/messes/${messId}/members/${karimMid}/remove`).set(auth(admin)).send({ force: true })).status).toBe(200);
    } else {
      expect(res.status).toBe(200);
    }
    expect((await api().get(`/api/messes/${messId}`).set(auth(karim))).status).toBe(404);
    // Removed member can ask to join again
    expect((await api().post("/api/messes/join").set(auth(karim)).send({ code })).status).toBe(201);
  });

  it("regenerates the join code", async () => {
    const r = await api().post(`/api/messes/${messId}/code`).set(auth(admin));
    expect(r.body.code).not.toBe(code);
    expect((await api().get(`/api/messes/preview/${code}`).set(auth(outsider))).status).toBe(404);
  });
});

describe("misc", () => {
  it("health, config and unknown routes", async () => {
    expect((await api().get("/api/health")).body.db).toBe("ok");
    expect((await api().get("/api/config")).body.uploads).toBe(false);
    expect((await api().get("/api/nope")).status).toBe(404);
    const up = await api().post(`/api/messes/${messId}/uploads/receipt`).set(auth(admin));
    expect(up.body.error.code).toBe("UPLOAD_DISABLED");
  });
});
