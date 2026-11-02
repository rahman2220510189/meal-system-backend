// Cleans a database URL pasted into an env var: stray quotes, a leading "psql",
// spaces, and upgrades sslmode=require to verify-full (same behaviour, no pg warning).
export function cleanDbUrl(raw: string | undefined): string {
  if (!raw) return "";
  let u = raw.trim();
  u = u.replace(/^psql\s+/i, "").trim();
  u = u.replace(/^['"]+|['"]+$/g, "").trim();
  u = u.replace(/[?&]sslmode=(require|prefer|verify-ca)\b/i, (m) => m.replace(/=(require|prefer|verify-ca)/i, "=verify-full"));
  return u;
}

/** Explains a pg connection error in plain words. */
export function explainDbError(err: unknown): string {
  const e = (err as { cause?: unknown })?.cause ?? err;
  const x = e as { code?: string; message?: string };
  const msg = x?.message || String(e);
  const hints: Record<string, string> = {
    ENOTFOUND: "Database host not found — the URL's host part is wrong or incomplete.",
    EAI_AGAIN: "DNS lookup failed — check the host in the URL.",
    ECONNREFUSED: "Connection refused — wrong host or port.",
    ETIMEDOUT: "Connection timed out — the database may be asleep or the host is wrong.",
    "28P01": "Wrong password or user name in the URL.",
    "28000": "Login rejected — check the user name in the URL.",
    "3D000": "The database name at the end of the URL does not exist.",
    "42501": "This database user is not allowed to create tables/schemas.",
  };
  const hint = (x?.code && hints[x.code]) || (/password/i.test(msg) ? hints["28P01"] : /Invalid URL|invalid connection/i.test(msg) ? "The URL is not a valid postgresql:// address." : "");
  return `${msg}${x?.code ? ` [${x.code}]` : ""}${hint ? `\n  → ${hint}` : ""}`;
}
