import { createApp } from "./app";
import { env } from "./env";
import { pool } from "./db";

const app = createApp();
const server = app.listen(env.PORT, () => {
  console.log(`✔ Meal System API running on http://localhost:${env.PORT}`);
});

function shutdown() {
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
