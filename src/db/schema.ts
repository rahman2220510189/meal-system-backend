// Meal System — database schema (Drizzle ORM, PostgreSQL)
// Every mess-owned row is reachable only through its mess; the API scopes every
// query by mess id, so one mess can never read or change another mess's data.
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  numeric,
  date,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["ADMIN", "MEMBER"]);
export const memberStatusEnum = pgEnum("member_status", ["PENDING", "APPROVED", "REJECTED", "REMOVED"]);
export const monthStatusEnum = pgEnum("month_status", ["OPEN", "CLOSED"]);
export const entryStatusEnum = pgEnum("entry_status", ["PENDING", "APPROVED", "REJECTED"]);

const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  phone: text("phone"),
  passwordHash: text("password_hash").notNull(),
  language: text("language").notNull().default("bn"),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  tokenVersion: integer("token_version").notNull().default(0),
  createdAt: created(),
});

export const messes = pgTable("messes", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  code: text("code").notNull().unique(),
  breakfastWeight: numeric("breakfast_weight", { precision: 3, scale: 2 }).notNull().default("0.5"),
  breakfastCutoff: text("breakfast_cutoff").notNull().default("07:00"),
  lunchCutoff: text("lunch_cutoff").notNull().default("10:00"),
  dinnerCutoff: text("dinner_cutoff").notNull().default("17:00"),
  createdAt: created(),
});

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messId: uuid("mess_id").notNull().references(() => messes.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull().default("MEMBER"),
    status: memberStatusEnum("status").notNull().default("PENDING"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("memberships_mess_user").on(t.messId, t.userId), index("memberships_user").on(t.userId)],
);

export const months = pgTable(
  "months",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messId: uuid("mess_id").notNull().references(() => messes.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    mealsPerDay: integer("meals_per_day").notNull().default(2),
    fixedMealEnabled: boolean("fixed_meal_enabled").notNull().default(false),
    fixedMealMin: integer("fixed_meal_min").notNull().default(0),
    status: monthStatusEnum("status").notNull().default("OPEN"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [uniqueIndex("months_mess_year_month").on(t.messId, t.year, t.month)],
);

export const monthMembers = pgTable(
  "month_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    monthId: uuid("month_id").notNull().references(() => months.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id").notNull().references(() => memberships.id, { onDelete: "cascade" }),
    carryIn: numeric("carry_in", { precision: 12, scale: 2 }).notNull().default("0"),
    activeFrom: date("active_from").notNull(),
    activeTo: date("active_to"),
    finalBalance: numeric("final_balance", { precision: 12, scale: 2 }),
  },
  (t) => [uniqueIndex("month_members_month_membership").on(t.monthId, t.membershipId)],
);

export const mealEntries = pgTable(
  "meal_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    monthId: uuid("month_id").notNull().references(() => months.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id").notNull().references(() => memberships.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    breakfast: boolean("breakfast").notNull().default(true),
    lunch: boolean("lunch").notNull().default(true),
    dinner: boolean("dinner").notNull().default(true),
    guestBreakfast: integer("guest_breakfast").notNull().default(0),
    guestLunch: integer("guest_lunch").notNull().default(0),
    guestDinner: integer("guest_dinner").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("meal_entries_membership_date").on(t.membershipId, t.date), index("meal_entries_month_date").on(t.monthId, t.date)],
);

export const bazars = pgTable(
  "bazars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    monthId: uuid("month_id").notNull().references(() => months.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id").notNull().references(() => memberships.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    items: text("items"),
    receiptId: text("receipt_id"),
    status: entryStatusEnum("status").notNull().default("PENDING"),
    rejectReason: text("reject_reason"),
    createdById: uuid("created_by_id").notNull(),
    reviewedById: uuid("reviewed_by_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [index("bazars_month").on(t.monthId)],
);

export const deposits = pgTable(
  "deposits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    monthId: uuid("month_id").notNull().references(() => months.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id").notNull().references(() => memberships.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    note: text("note"),
    status: entryStatusEnum("status").notNull().default("PENDING"),
    rejectReason: text("reject_reason"),
    createdById: uuid("created_by_id").notNull(),
    reviewedById: uuid("reviewed_by_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [index("deposits_month").on(t.monthId)],
);

export const fixedCosts = pgTable(
  "fixed_costs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    monthId: uuid("month_id").notNull().references(() => months.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    date: date("date").notNull(),
    createdById: uuid("created_by_id").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [index("fixed_costs_month").on(t.monthId)],
);

export const bazarDuties = pgTable(
  "bazar_duties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    monthId: uuid("month_id").notNull().references(() => months.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id").notNull().references(() => memberships.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
  },
  (t) => [uniqueIndex("bazar_duties_unique").on(t.monthId, t.date, t.membershipId)],
);

export const activityLogs = pgTable(
  "activity_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messId: uuid("mess_id").notNull().references(() => messes.id, { onDelete: "cascade" }),
    userId: uuid("user_id"),
    userName: text("user_name").notNull(),
    action: text("action").notNull(),
    meta: jsonb("meta"),
    createdAt: created(),
  },
  (t) => [index("activity_logs_mess_created").on(t.messId, t.createdAt)],
);
