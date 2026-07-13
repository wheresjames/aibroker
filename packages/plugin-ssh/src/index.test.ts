import { describe, expect, it, vi } from "vitest";
import { confinementProfile, provisioningScript, sshPlugin } from "./index.js";
import { pluginConformanceProblems, probeConformanceProblems } from "@aibroker/plugin-sdk";

describe("sshPlugin", () => {
  it("is singleton and keeps raw shell exclusively in Full", () => {
    expect(pluginConformanceProblems(sshPlugin)).toEqual([]);
    expect(sshPlugin.cardinality).toBe("singleton");
    expect(sshPlugin.accessLevels.manage.toolNames).not.toContain("ssh.run_command");
    expect(sshPlugin.accessLevels.full.toolNames).toContain("ssh.run_command");
    expect(sshPlugin.tools.find(({ name }) => name === "ssh.run_command")).toMatchObject({ action: "operate", risk: "critical" });
  });

  it("builds a fixed confinement profile and idempotent script", () => {
    const profile = confinementProfile({ username: "aibroker", workspace_root: "/var/www/html" });
    const script = provisioningScript(profile, "PUBLIC KEY");
    expect(profile.sudoersLines).toEqual([expect.stringContaining("NOPASSWD")]);
    expect(script).toContain("id -u 'aibroker'");
    expect(script).toContain("setfacl -R -m u:aibroker:rwX '/var/www/html'");
    expect(script).toContain("no-port-forwarding");
  });

  it("round-trips probed capabilities", async () => expect(await probeConformanceProblems(sshPlugin, {
    id: "plugin", instanceName: "SSH", config: {}, server: { id: "server", name: "test", address: "host.test", metadata: {} },
    services: { probes: { ssh: async () => [{ capability: "ssh_connected", status: "available" as const }] } }
  })).toEqual([]));

  it("passes the elevated credential only to the in-memory runner", async () => {
    const runner = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const credential = { host: "host.test", port: 22, username: "admin", privateKey: "bootstrap", knownHostsLine: "host key", useSudo: true };
    const result = await sshPlugin.provision!(credential, {
      id: "plugin", instanceName: "SSH", config: { username: "aibroker", workspace_root: "/srv/www" },
      server: { id: "server", name: "Server", address: "host.test", metadata: {} }, services: { elevatedSshRunner: runner }
    });
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ credential }));
    expect(result.privateKey).toContain("PRIVATE KEY");
    expect(result.publicKey).toMatch(/^ssh-ed25519 /);
    expect(credential.privateKey).toBe("");
  });
});
