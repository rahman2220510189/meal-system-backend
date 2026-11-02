// Pure month calculation — no database access, fully unit tested.
//
//   own meals      = lunch + dinner (+ breakfast × breakfastWeight when 3 meals a day)
//   guest meals    = same rule applied to the guest counts
//   minimum meals  = fixed-meal minimum, prorated by the days the member was active
//   counted meals  = max(own meals, minimum meals)   (guests never fill the minimum)
//   billed meals   = counted meals + guest meals
//   meal rate      = approved bazar ÷ Σ billed meals
//   meal cost      = billed meals × meal rate
//   shared cost    = fixed costs split by active days
//   balance        = carry-in + approved deposits − (meal cost + shared cost)
//                    positive → plus (gets money back), negative → due (must pay)
import { daysBetweenInclusive } from "./dates";
import { round2, roundHalf } from "./money";

export interface CalcMember {
  membershipId: string;
  userId: string;
  name: string;
  activeFrom: string;
  activeTo: string | null;
  carryIn: number;
}

export interface CalcMeal {
  membershipId: string;
  breakfast: boolean;
  lunch: boolean;
  dinner: boolean;
  guestBreakfast: number;
  guestLunch: number;
  guestDinner: number;
}

export interface CalcInput {
  mealsPerDay: number;
  breakfastWeight: number;
  fixedMealEnabled: boolean;
  fixedMealMin: number;
  daysInMonth: number;
  monthEnd: string;
  members: CalcMember[];
  meals: CalcMeal[];
  bazarTotal: number;
  fixedCostTotal: number;
  depositsByMember: Record<string, number>;
}

export interface MemberResult {
  membershipId: string;
  userId: string;
  name: string;
  activeDays: number;
  ownMeals: number;
  guestMeals: number;
  minMeals: number;
  shortfall: number;
  billedMeals: number;
  mealCost: number;
  sharedCost: number;
  totalCost: number;
  deposit: number;
  carryIn: number;
  balance: number;
}

export interface CalcResult {
  mealRate: number;
  totals: {
    ownMeals: number;
    guestMeals: number;
    billedMeals: number;
    bazar: number;
    sharedCost: number;
    deposit: number;
    carryIn: number;
    totalCost: number;
    cashInHand: number;
    totalDue: number;
    totalPlus: number;
  };
  members: MemberResult[];
}

export function mealValue(m: Pick<CalcMeal, "breakfast" | "lunch" | "dinner">, mealsPerDay: number, bw: number): number {
  return (mealsPerDay === 3 && m.breakfast ? bw : 0) + (m.lunch ? 1 : 0) + (m.dinner ? 1 : 0);
}

export function guestValue(m: Pick<CalcMeal, "guestBreakfast" | "guestLunch" | "guestDinner">, mealsPerDay: number, bw: number): number {
  return (mealsPerDay === 3 ? m.guestBreakfast * bw : 0) + m.guestLunch + m.guestDinner;
}

export function calculateMonth(input: CalcInput): CalcResult {
  const { mealsPerDay, breakfastWeight: bw } = input;

  const own = new Map<string, number>();
  const guest = new Map<string, number>();
  for (const m of input.meals) {
    own.set(m.membershipId, (own.get(m.membershipId) || 0) + mealValue(m, mealsPerDay, bw));
    guest.set(m.membershipId, (guest.get(m.membershipId) || 0) + guestValue(m, mealsPerDay, bw));
  }

  const rows = input.members.map((mem) => {
    const activeDays = daysBetweenInclusive(mem.activeFrom, mem.activeTo ?? input.monthEnd);
    const ownMeals = own.get(mem.membershipId) || 0;
    const guestMeals = guest.get(mem.membershipId) || 0;
    const minMeals =
      input.fixedMealEnabled && input.fixedMealMin > 0 && input.daysInMonth > 0
        ? roundHalf((input.fixedMealMin * activeDays) / input.daysInMonth)
        : 0;
    const counted = Math.max(ownMeals, minMeals);
    return { mem, activeDays, ownMeals, guestMeals, minMeals, billed: counted + guestMeals };
  });

  const totalBilled = rows.reduce((s, r) => s + r.billed, 0);
  const totalActiveDays = rows.reduce((s, r) => s + r.activeDays, 0);
  const mealRate = totalBilled > 0 ? input.bazarTotal / totalBilled : 0;

  const members: MemberResult[] = rows.map((r) => {
    const mealCost = r.billed * mealRate;
    const sharedCost = totalActiveDays > 0 ? (input.fixedCostTotal * r.activeDays) / totalActiveDays : 0;
    const totalCost = mealCost + sharedCost;
    const deposit = input.depositsByMember[r.mem.membershipId] || 0;
    const balance = r.mem.carryIn + deposit - totalCost;
    return {
      membershipId: r.mem.membershipId,
      userId: r.mem.userId,
      name: r.mem.name,
      activeDays: r.activeDays,
      ownMeals: round2(r.ownMeals),
      guestMeals: round2(r.guestMeals),
      minMeals: r.minMeals,
      shortfall: round2(Math.max(0, r.minMeals - r.ownMeals)),
      billedMeals: round2(r.billed),
      mealCost: round2(mealCost),
      sharedCost: round2(sharedCost),
      totalCost: round2(totalCost),
      deposit: round2(deposit),
      carryIn: round2(r.mem.carryIn),
      balance: round2(balance),
    };
  });

  const sum = (f: (m: MemberResult) => number) => round2(members.reduce((s, m) => s + f(m), 0));
  const depositTotal = Object.entries(input.depositsByMember).reduce((s, [, v]) => s + v, 0);

  return {
    mealRate: round2(mealRate),
    totals: {
      ownMeals: sum((m) => m.ownMeals),
      guestMeals: sum((m) => m.guestMeals),
      billedMeals: round2(totalBilled),
      bazar: round2(input.bazarTotal),
      sharedCost: round2(input.fixedCostTotal),
      deposit: round2(depositTotal),
      carryIn: sum((m) => m.carryIn),
      totalCost: sum((m) => m.totalCost),
      cashInHand: round2(depositTotal - input.bazarTotal - input.fixedCostTotal),
      totalDue: sum((m) => (m.balance < 0 ? -m.balance : 0)),
      totalPlus: sum((m) => (m.balance > 0 ? m.balance : 0)),
    },
    members,
  };
}
