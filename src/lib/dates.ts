// Dates are handled as plain "YYYY-MM-DD" strings. "Today" is always Bangladesh time.
export const TZ = "Asia/Dhaka";

export function todayDhaka(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function nowDhakaHM(now = new Date()): string {
  const s = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  return s;
}

export function currentYearMonthDhaka(now = new Date()): { year: number; month: number } {
  const [y, m] = todayDhaka(now).split("-").map(Number);
  return { year: y, month: m };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function monthStart(year: number, month: number): string {
  return `${year}-${pad(month)}-01`;
}

export function monthEnd(year: number, month: number): string {
  return `${year}-${pad(month)}-${pad(daysInMonth(year, month))}`;
}

export function addDays(d: string, n: number): string {
  const dt = new Date(d + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export function daysBetweenInclusive(from: string, to: string): number {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  return Math.max(0, Math.round((b - a) / 86_400_000) + 1);
}

export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function clampDate(d: string, min: string, max: string): string {
  return d < min ? min : d > max ? max : d;
}

export function isValidDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const dt = new Date(d + "T00:00:00Z");
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
}
