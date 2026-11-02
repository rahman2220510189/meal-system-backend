import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`✖ Missing environment variable ${name}. Copy backend/.env.example to backend/.env and fill it in.`);
    process.exit(1);
  }
  return v;
}

const NODE_ENV = process.env.NODE_ENV || "development";

export const env = {
  NODE_ENV,
  PORT: Number(process.env.PORT || 4000),
  DATABASE_URL: required("DATABASE_URL"),
  JWT_SECRET: required("JWT_SECRET", NODE_ENV === "production" ? undefined : "dev-only-secret-change-me"),
  // Comma separated list of allowed frontend origins
  FRONTEND_URLS: (process.env.FRONTEND_URL || "http://localhost:3000")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean),
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME || "",
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY || "",
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET || "",
};

export const uploadsEnabled = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
);
