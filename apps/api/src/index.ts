import { buildServer, ensureBootstrapAdmin } from "./server.js";
import { loadConfig } from "@aibroker/core";
import { createPool } from "@aibroker/db";
import { prepareApiDatabase } from "./startup.js";

const config = loadConfig();
await prepareApiDatabase(config.databaseUrl);
const db = createPool(config.databaseUrl);
await ensureBootstrapAdmin(db);
const server = await buildServer({ config, db });

try {
  await server.listen({ port: config.apiPort, host: "0.0.0.0" });
  server.log.info({ port: config.apiPort }, "AIBroker API listening");
} catch (error) {
  server.log.error({ error }, "AIBroker API failed to start");
  await db.end();
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    server.log.info({ signal }, "Shutting down AIBroker API");
    await server.close();
    await db.end();
    process.exit(0);
  });
}
