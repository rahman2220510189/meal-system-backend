import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: process.env.TEST_DATABASE_URL || "postgresql://postgres@localhost:5432/meal_test",
      DIRECT_URL: process.env.TEST_DATABASE_URL || "postgresql://postgres@localhost:5432/meal_test",
      JWT_SECRET: "test-secret-test-secret-test-secret",
      FRONTEND_URL: "http://localhost:3000",
    },
  },
});
