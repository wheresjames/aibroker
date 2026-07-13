import { runMigrations, seedToolDefinitions } from "@aibroker/db";

export interface ApiDatabaseStartup {
  migrate(connectionString: string): Promise<void>;
  syncCatalog(connectionString: string): Promise<void>;
}

const defaultStartup: ApiDatabaseStartup = {
  migrate: runMigrations,
  syncCatalog: seedToolDefinitions
};

export async function prepareApiDatabase(
  connectionString: string,
  startup: ApiDatabaseStartup = defaultStartup
): Promise<void> {
  await startup.migrate(connectionString);
  // Code manifests are the source of truth for plugin types and tools. Synchronize their
  // database mirror before accepting requests so server_plugins foreign keys and policy
  // authoring work immediately on a fresh or reset database.
  await startup.syncCatalog(connectionString);
}
