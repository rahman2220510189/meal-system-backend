import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { env } from "../env";

const TOKEN_TTL = "30d";

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

export function signToken(userId: string, tokenVersion: number): string {
  return jwt.sign({ sub: userId, tv: tokenVersion }, env.JWT_SECRET, { expiresIn: TOKEN_TTL, algorithm: "HS256" });
}

export function readToken(token: string): { sub: string; tv: number } | null {
  try {
    const p = jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    if (typeof p.sub !== "string" || typeof p.tv !== "number") return null;
    return { sub: p.sub, tv: p.tv };
  } catch {
    return null;
  }
}

// Join codes avoid look-alike characters (0/O, 1/I/L)
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function makeJoinCode(len = 8): string {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function makeTempPassword(): string {
  const words = ["rice", "dal", "fish", "egg", "tea", "mango", "lemon", "chili"];
  const w = words[crypto.randomInt(words.length)];
  return `${w}-${crypto.randomInt(1000, 9999)}-${makeJoinCode(3).toLowerCase()}`;
}
