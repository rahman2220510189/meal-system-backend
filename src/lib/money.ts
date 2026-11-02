export const toNum = (v: string | number | null | undefined): number => (v == null ? 0 : Number(v));
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
export const roundHalf = (n: number): number => Math.round(n * 2) / 2;
export const money = (n: number): string => round2(n).toFixed(2);
