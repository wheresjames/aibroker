import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("migrations", () => {
  it("ships the baseline and additive feature migrations in order", () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
    expect(fs.readdirSync(dir).filter((file) => file.endsWith(".sql"))).toEqual([
      "001_initial_schema.sql",
      "002_phase2_permissions.sql",
      "003_ssh_provisioning.sql",
      "004_wordpress_network_membership.sql",
      "005_plugin_operations.sql",
      "006_playwright_artifacts.sql",
      "007_leased_sessions.sql",
    ]);
    const initial = fs.readFileSync(path.join(dir, "001_initial_schema.sql"), "utf8");
    const phase2 = fs.readFileSync(path.join(dir, "002_phase2_permissions.sql"), "utf8");
    const sshProvisioning = fs.readFileSync(path.join(dir, "003_ssh_provisioning.sql"), "utf8");
    const networkMembership = fs.readFileSync(path.join(dir, "004_wordpress_network_membership.sql"), "utf8");
    const pluginOperations = fs.readFileSync(path.join(dir, "005_plugin_operations.sql"), "utf8");
    const playwrightArtifacts = fs.readFileSync(path.join(dir, "006_playwright_artifacts.sql"), "utf8");
    const leasedSessions = fs.readFileSync(path.join(dir, "007_leased_sessions.sql"), "utf8");
    for (const table of ["servers", "plugins", "server_plugins", "server_credentials", "server_capabilities", "server_bindings"]) {
      expect(initial, table).toContain(`CREATE TABLE public.${table}`);
    }
    expect(initial).toContain("server_plugin_id uuid");
    expect(initial).toContain("plugin_key text");
    expect(initial).not.toContain("access_levels jsonb");
    expect(initial).not.toContain("policy_plugin_intents");
    expect(phase2).toContain("CREATE TABLE public.policy_plugin_intents");
    expect(phase2).toContain("ADD COLUMN access_levels jsonb");
    expect(phase2).toContain("ADD COLUMN risk_ceiling text");
    expect(phase2).toContain("ADD COLUMN instance_name text");
    expect(sshProvisioning).toContain("CREATE TABLE public.ssh_provisioning");
    expect(sshProvisioning).toContain("ADD COLUMN server_plugin_id uuid");
    expect(networkMembership).toContain("CREATE TABLE public.wordpress_network_servers");
    expect(pluginOperations).toContain("CREATE TABLE public.postgres_connectors");
    expect(pluginOperations).toContain("CREATE TABLE public.sandbox_targets");
    expect(playwrightArtifacts).toContain("CREATE TABLE public.browser_artifacts");
    expect(playwrightArtifacts).not.toMatch(/bytea/i);
    expect(leasedSessions).toContain("CREATE TABLE public.leased_sessions");
    expect(leasedSessions).toContain("leased_sessions_plugin_slot_active_idx");
    expect(initial).not.toMatch(/CREATE TABLE public\.sites\b/);
    expect(initial).not.toMatch(/CREATE TABLE public\.site_/);
    for (const column of ["domain", "action", "risk", "executor_kind", "credential_kinds"]) {
      expect(initial, column).toContain(column);
    }
  });
});
