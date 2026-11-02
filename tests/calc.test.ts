import { describe, it, expect } from "vitest";
import { calculateMonth, type CalcInput } from "../src/lib/calc";
import { canEdit } from "../src/routes/months";

const base = (over: Partial<CalcInput> = {}): CalcInput => ({
  mealsPerDay: 2,
  breakfastWeight: 0.5,
  fixedMealEnabled: false,
  fixedMealMin: 0,
  daysInMonth: 30,
  monthEnd: "2026-11-30",
  members: [],
  meals: [],
  bazarTotal: 0,
  fixedCostTotal: 0,
  depositsByMember: {},
  ...over,
});

const mem = (id: string, from = "2026-11-01", to: string | null = null, carryIn = 0) => ({
  membershipId: id,
  userId: "u" + id,
  name: id,
  activeFrom: from,
  activeTo: to,
  carryIn,
});

function meals(id: string, n: number, guests = 0) {
  // n days of lunch+dinner = 2n meals; guests on lunch of the first day
  return Array.from({ length: n }, (_, i) => ({
    membershipId: id,
    breakfast: true,
    lunch: true,
    dinner: true,
    guestBreakfast: 0,
    guestLunch: i === 0 ? guests : 0,
    guestDinner: 0,
  }));
}

describe("calculateMonth", () => {
  it("computes the meal rate and due / plus (example from the plan)", () => {
    // 400 meals in total, bazar 12,000 → rate 30
    const r = calculateMonth(
      base({
        members: [mem("rahim"), mem("karim")],
        meals: [...meals("rahim", 25), ...meals("karim", 175)],
        bazarTotal: 12000,
        depositsByMember: { rahim: 2000, karim: 9000 },
      }),
    );
    expect(r.mealRate).toBe(30);
    const rahim = r.members.find((m) => m.membershipId === "rahim")!;
    expect(rahim.ownMeals).toBe(50);
    expect(rahim.mealCost).toBe(1500);
    expect(rahim.balance).toBe(500); // plus
    const karim = r.members.find((m) => m.membershipId === "karim")!;
    expect(karim.balance).toBe(-1500); // due
    expect(r.totals.totalDue).toBe(1500);
    expect(r.totals.totalPlus).toBe(500);
    expect(r.totals.cashInHand).toBe(-1000);
  });

  it("ignores breakfast in a 2-meal month and weights it in a 3-meal month", () => {
    const two = calculateMonth(base({ members: [mem("a")], meals: meals("a", 10), bazarTotal: 100 }));
    expect(two.members[0].ownMeals).toBe(20);
    const three = calculateMonth(base({ mealsPerDay: 3, members: [mem("a")], meals: meals("a", 10), bazarTotal: 100 }));
    expect(three.members[0].ownMeals).toBe(25);
    const full = calculateMonth(base({ mealsPerDay: 3, breakfastWeight: 1, members: [mem("a")], meals: meals("a", 10) }));
    expect(full.members[0].ownMeals).toBe(30);
  });

  it("charges guest meals to the host and never lets guests fill the fixed minimum", () => {
    const r = calculateMonth(
      base({
        fixedMealEnabled: true,
        fixedMealMin: 40,
        members: [mem("host"), mem("b")],
        meals: [...meals("host", 10, 3), ...meals("b", 25)],
        bazarTotal: 4150,
      }),
    );
    const host = r.members.find((m) => m.membershipId === "host")!;
    expect(host.ownMeals).toBe(20);
    expect(host.guestMeals).toBe(3);
    expect(host.minMeals).toBe(40);
    expect(host.shortfall).toBe(20);
    expect(host.billedMeals).toBe(43); // 40 minimum + 3 guests
    const b = r.members.find((m) => m.membershipId === "b")!;
    expect(b.billedMeals).toBe(50);
    expect(r.totals.billedMeals).toBe(93);
    expect(r.mealRate).toBeCloseTo(4150 / 93, 2);
    // Everything billed adds up to the bazar total
    expect(host.mealCost + b.mealCost).toBeCloseTo(4150, 0);
  });

  it("matches the fixed-meal example (Rahim 55, Karim 25 → 40, Sakib 45, bazar 4200 → rate 30)", () => {
    const r = calculateMonth(
      base({
        fixedMealEnabled: true,
        fixedMealMin: 40,
        members: [mem("rahim"), mem("karim"), mem("sakib")],
        meals: [
          ...Array.from({ length: 55 }, () => ({ membershipId: "rahim", breakfast: false, lunch: true, dinner: false, guestBreakfast: 0, guestLunch: 0, guestDinner: 0 })),
          ...Array.from({ length: 25 }, () => ({ membershipId: "karim", breakfast: false, lunch: true, dinner: false, guestBreakfast: 0, guestLunch: 0, guestDinner: 0 })),
          ...Array.from({ length: 45 }, () => ({ membershipId: "sakib", breakfast: false, lunch: true, dinner: false, guestBreakfast: 0, guestLunch: 0, guestDinner: 0 })),
        ],
        bazarTotal: 4200,
      }),
    );
    expect(r.totals.billedMeals).toBe(140);
    expect(r.mealRate).toBe(30);
    expect(r.members.find((m) => m.membershipId === "karim")!.mealCost).toBe(1200);
  });

  it("prorates the fixed minimum and shared costs for mid-month joiners", () => {
    const r = calculateMonth(
      base({
        fixedMealEnabled: true,
        fixedMealMin: 40,
        members: [mem("full"), mem("half", "2026-11-16")],
        meals: [],
        fixedCostTotal: 900,
      }),
    );
    const half = r.members.find((m) => m.membershipId === "half")!;
    expect(half.activeDays).toBe(15);
    expect(half.minMeals).toBe(20);
    // 900 split by active days 30 : 15
    expect(half.sharedCost).toBe(300);
    expect(r.members.find((m) => m.membershipId === "full")!.sharedCost).toBe(600);
  });

  it("adds carried balance from last month", () => {
    const r = calculateMonth(base({ members: [mem("a", "2026-11-01", null, -250)], meals: meals("a", 5), bazarTotal: 300, depositsByMember: { a: 1000 } }));
    expect(r.members[0].balance).toBe(450);
  });

  it("returns a zero rate when nobody has eaten", () => {
    const r = calculateMonth(base({ members: [mem("a")], bazarTotal: 500 }));
    expect(r.mealRate).toBe(0);
    expect(r.members[0].mealCost).toBe(0);
  });
});

describe("meal cutoff rules", () => {
  const mess = { breakfastCutoff: "07:00", lunchCutoff: "10:00", dinnerCutoff: "17:00" };
  it("lets members change future days, today before cutoff, never past days", () => {
    expect(canEdit(false, "2026-11-05", "lunch", mess, "2026-11-04", "23:00")).toBe(true);
    expect(canEdit(false, "2026-11-04", "lunch", mess, "2026-11-04", "09:59")).toBe(true);
    expect(canEdit(false, "2026-11-04", "lunch", mess, "2026-11-04", "10:00")).toBe(false);
    expect(canEdit(false, "2026-11-04", "dinner", mess, "2026-11-04", "16:00")).toBe(true);
    expect(canEdit(false, "2026-11-04", "guestDinner", mess, "2026-11-04", "17:30")).toBe(false);
    expect(canEdit(false, "2026-11-03", "dinner", mess, "2026-11-04", "00:01")).toBe(false);
  });
  it("lets admins change anything", () => {
    expect(canEdit(true, "2026-11-01", "lunch", mess, "2026-11-20", "23:59")).toBe(true);
  });
});
