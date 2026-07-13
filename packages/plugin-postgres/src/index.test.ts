import { describe, expect, it, vi } from "vitest";
import { postgresPlugin } from "./index.js";
import { pluginConformanceProblems, probeConformanceProblems } from "@aibroker/plugin-sdk";

describe("postgresPlugin", () => {
  it("passes the plugin conformance kit", () => expect(pluginConformanceProblems(postgresPlugin)).toEqual([]));
  it("round-trips probed capabilities", async () => expect(await probeConformanceProblems(postgresPlugin, {
    id: "plugin", instanceName: "Postgres", config: {}, server: { id: "server", name: "test", address: "postgres", metadata: {} },
    services: { probes: { postgres: async () => [{ capability: "postgres_connected", status: "available" as const }] } }
  })).toEqual([]));
  it("keeps unrestricted SQL exclusively in Full", () => {
    expect(postgresPlugin.accessLevels.manage.toolNames).not.toContain("postgres.run_sql");
    expect(postgresPlugin.accessLevels.full.toolNames).toContain("postgres.run_sql");
    expect(postgresPlugin.tools.find(({ name }) => name === "postgres.run_sql")).toMatchObject({ action: "operate", risk: "critical" });
  });
  it("discards the admin connection after provisioning", async () => {
    const credential = { kind: "postgres_admin" as const, connectionString: "postgres://admin:secret@db/test" };
    const provisioner = vi.fn(async () => undefined);
    const result = await postgresPlugin.provision!(credential, { id: "p", instanceName: "db", config: { host: "db", database: "test", scoped_role: "scoped", allowed_schemas: ["public"] },
      server: { id: "s", name: "s", address: "db", metadata: {} }, services: { postgresProvisioner: provisioner } });
    expect(provisioner).toHaveBeenCalled(); expect(credential.connectionString).toBe("");
    expect(result.credential?.kind).toBe("postgres_scoped_role");
  });
});
