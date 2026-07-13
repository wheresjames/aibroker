import { generateKeyPairSync } from "node:crypto";
import type { ToolDefinition } from "@aibroker/mcp-tools";
import type {
  AccessLevelMap,
  BrokerPlugin,
  CapabilityRecord,
  ConfinementProfile,
  ElevatedCredential,
  PluginExecutionContext,
  PluginProbeContext,
  PluginProvisionContext,
  ProvisionPreview
} from "@aibroker/plugin-sdk";
import { runtimeExecutor, runtimeProbe } from "@aibroker/plugin-sdk";

export type ElevatedSshRunner = (input: {
  credential: ElevatedCredential;
  script: string;
}) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

type SshExecutor = (toolName: string, input: Record<string, unknown>, context: PluginExecutionContext) => Promise<unknown>;
type SshProbe = (context: PluginProbeContext) => Promise<CapabilityRecord[]>;

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", additionalProperties: false, properties, required
});
const target = {
  server_plugin_id: { type: "string", format: "uuid" },
  reason: { type: ["string", "null"], minLength: 1, maxLength: 1000 }
};
const operationOutput = object({ operation_id: { type: "string", format: "uuid" }, status: { type: "string" } }, ["operation_id", "status"]);

function tool(
  name: string,
  action: ToolDefinition["action"],
  risk: ToolDefinition["risk"],
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  reversible = true
): ToolDefinition {
  const isWrite = action !== "read";
  return {
    name, version: 1, category: isWrite ? "write" : "read", isWrite,
    inputSchema: object({ ...target, ...properties, ...(isWrite ? { idempotency_key: { type: "string", minLength: 16 } } : {}) },
      ["server_plugin_id", ...required, ...(isWrite ? ["idempotency_key"] : [])]),
    outputSchema: operationOutput, domain: "host", action, risk, reversible,
    executorKind: "ssh", credentialKinds: ["ssh_private_key"], supportsDryRun: false,
    isLongRunning: true, description
  };
}

const workspace = {
  workspace: { type: "string", minLength: 1 },
  path: { type: ["string", "null"] },
  content: { type: ["string", "null"] },
  expected_hash: { type: ["string", "null"] },
  command: { type: ["string", "null"] }
};

export const SSH_TOOL_DEFINITIONS: ToolDefinition[] = [
  tool("ssh.list_files", "read", "low", "List files inside a confined workspace.", workspace, ["workspace"]),
  tool("ssh.read_file", "read", "low", "Read an allowed file inside a confined workspace.", workspace, ["workspace", "path"]),
  tool("ssh.file_hash", "read", "low", "Read a confined file's content hash.", workspace, ["workspace", "path"]),
  tool("ssh.create_file", "create", "medium", "Create a file inside a confined workspace.", workspace, ["workspace", "path", "content"]),
  tool("ssh.update_file", "change", "medium", "Update a confined file with optimistic concurrency.", workspace, ["workspace", "path", "content", "expected_hash"]),
  tool("ssh.remove_file", "remove", "high", "Remove a file inside a confined workspace.", workspace, ["workspace", "path", "expected_hash"], false),
  tool("ssh.run_named_command", "operate", "high", "Run a manifest-approved command inside a confined workspace.", workspace, ["workspace", "command"]),
  tool("ssh.run_command", "operate", "critical", "Run an arbitrary command as the confined account. Break-glass only; fully recorded.", {
    command: { type: "string", minLength: 1, maxLength: 65536 },
    reason: { type: "string", minLength: 1, maxLength: 1000 }
  }, ["command", "reason"], false)
];

const names = (predicate: (value: ToolDefinition) => boolean) => SSH_TOOL_DEFINITIONS.filter(predicate).map(({ name }) => name);
const accessLevels: AccessLevelMap = {
  none: { label: "None", description: "No host access.", riskCeiling: null, toolNames: [] },
  read: { label: "Read", description: "Inspect files inside configured roots.", riskCeiling: "medium", toolNames: names((item) => item.action === "read") },
  contribute: { label: "Contribute", description: "Inspect and create new files inside configured roots.", riskCeiling: "medium", toolNames: names((item) => item.action === "read" || item.action === "create") },
  manage: { label: "Manage", description: "Manage confined files and run approved commands; no raw shell.", riskCeiling: "high", toolNames: names((item) => item.name !== "ssh.run_command") },
  full: { label: "Full", description: "Break-glass access including a recorded raw shell command.", riskCeiling: "critical", toolNames: SSH_TOOL_DEFINITIONS.map(({ name }) => name) }
};

function safeRoot(value: unknown): string {
  const root = typeof value === "string" ? value.trim() : "";
  if (!root.startsWith("/") || root.includes("\0") || root.split("/").includes("..")) throw new Error("invalid_workspace_root");
  return root.replace(/\/+$/, "") || "/";
}

function safeUsername(value: unknown): string {
  const username = typeof value === "string" && value.trim() ? value.trim() : "aibroker";
  if (!/^[a-z_][a-z0-9_-]{0,30}$/.test(username)) throw new Error("invalid_confined_username");
  return username;
}

export function confinementProfile(config: Record<string, unknown>): ConfinementProfile {
  const username = safeUsername(config.username);
  const workspaceRoot = safeRoot(config.workspace_root);
  const helperCommands = ["/usr/local/lib/aibroker/workspace", "/usr/local/lib/aibroker/wp-cli"];
  return {
    username,
    workspaceRoot,
    authorizedKeyPath: `/home/${username}/.ssh/authorized_keys`,
    forceCommand: "/usr/local/lib/aibroker/force-command",
    sudoersPath: `/etc/sudoers.d/aibroker-${username}`,
    helperCommands,
    sudoersLines: [`${username} ALL=(root) NOPASSWD: ${helperCommands.join(", ")}`]
  };
}

export function provisioningPreview(config: Record<string, unknown>): ProvisionPreview {
  const profile = confinementProfile(config);
  return { profile, summary: [
    `Create or converge Unix account ${profile.username}`,
    `Limit filesystem access to ${profile.workspaceRoot}`,
    `Install a forced-command key in ${profile.authorizedKeyPath}`,
    `Install reviewed sudo rules at ${profile.sudoersPath}`,
    "Store only the generated confined private key; discard the elevated credential"
  ] };
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\"'\"'`)}'`; }

function opensshEd25519(publicKeyDer: Buffer): string {
  const raw = publicKeyDer.subarray(publicKeyDer.length - 32);
  const name = Buffer.from("ssh-ed25519");
  const length = (value: Buffer) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value.length); return bytes; };
  return `ssh-ed25519 ${Buffer.concat([length(name), name, length(raw), raw]).toString("base64")} aibroker-confined`;
}

export function provisioningScript(profile: ConfinementProfile, publicKey: string): string {
  const user = shellQuote(profile.username), root = shellQuote(profile.workspaceRoot);
  const authorizedKey = shellQuote(`command=\"${profile.forceCommand}\",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty ${publicKey.trim()}`);
  const sudoers = shellQuote(`${profile.sudoersLines.join("\n")}\n`);
  const forceCommand = Buffer.from([
    "#!/bin/sh", "set -eu", "case \"${SSH_ORIGINAL_COMMAND:-}\" in",
    "  \"'aibroker-probe'\") printf 'ok\\n' ;;",
    "  \"'aibroker-workspace' \"*) exec /bin/sh -lc \"$SSH_ORIGINAL_COMMAND\" ;;",
    "  \"'aibroker-break-glass' \"*) eval \"set -- $SSH_ORIGINAL_COMMAND\"; shift; exec /bin/sh -lc \"$1\" ;;",
    "  *) printf 'Command denied by AIBroker confinement\\n' >&2; exit 126 ;;", "esac", ""
  ].join("\n")).toString("base64");
  return [
    "set -eu",
    `id -u ${user} >/dev/null 2>&1 || useradd --create-home --shell /bin/sh ${user}`,
    `install -d -m 0700 -o ${user} -g ${user} /home/${profile.username}/.ssh`,
    `printf '%s\\n' ${authorizedKey} > ${profile.authorizedKeyPath}`,
    `chown ${user}:${user} ${profile.authorizedKeyPath}`,
    `chmod 0600 ${profile.authorizedKeyPath}`,
    "install -d -m 0755 /usr/local/lib/aibroker",
    `printf '%s' ${shellQuote(forceCommand)} | base64 -d > ${shellQuote(profile.forceCommand)}`,
    `chmod 0755 ${shellQuote(profile.forceCommand)}`,
    `setfacl -R -m u:${profile.username}:rwX ${root}`,
    `setfacl -d -m u:${profile.username}:rwX ${root}`,
    `printf '%s' ${sudoers} > ${profile.sudoersPath}`,
    `chmod 0440 ${profile.sudoersPath}`,
    `visudo -cf ${profile.sudoersPath}`
  ].join("\n");
}

export function deprovisioningScript(profile: ConfinementProfile): string {
  return [
    "set -eu",
    `rm -f ${shellQuote(profile.sudoersPath)}`,
    `setfacl -x ${shellQuote(`u:${profile.username}`)} ${shellQuote(profile.workspaceRoot)} 2>/dev/null || true`,
    `userdel --remove ${shellQuote(profile.username)} 2>/dev/null || true`
  ].join("\n");
}

export const sshPlugin: BrokerPlugin = {
  key: "ssh", name: "SSH / Host", version: 1,
  description: "Confined host access with one-time elevated provisioning and recorded break-glass commands.",
  cardinality: "singleton", minRoleToEnable: "global_admin",
  configVars: ["server.address"],
  configSchema: {
    type: "object", additionalProperties: false,
    properties: {
      host: { type: "string", title: "SSH host", default: "${server.address}" },
      port: { type: "integer", title: "SSH port", default: 22 },
      username: { type: "string", title: "Confined username", default: "aibroker" },
      workspace_root: { type: "string", title: "Workspace / HTML root", default: "/var/www/html" }
    }, required: ["host", "workspace_root"]
  },
  credentialKinds: ["ssh_private_key"], domains: [{ key: "host", label: "SSH / Host" }],
  tools: SSH_TOOL_DEFINITIONS, accessLevels,
  previewProvision(context) { return provisioningPreview(context.config); },
  async provision(credential, context) {
    if (credential.kind === "postgres_admin") throw new Error("ssh_bootstrap_credential_required");
    const preview = provisioningPreview(context.config);
    const runner = context.services.elevatedSshRunner as ElevatedSshRunner | undefined;
    if (!runner) throw new Error("ssh_provisioner_unavailable");
    const pair = generateKeyPairSync("ed25519");
    const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKey = opensshEd25519(pair.publicKey.export({ type: "spki", format: "der" }));
    try {
      const applied = await runner({ credential, script: provisioningScript(preview.profile, publicKey) });
      if (applied.exitCode !== 0) throw new Error(`ssh_provisioning_failed: ${applied.stderr.slice(0, 500)}`);
      return { ...preview, privateKey, publicKey, credential: { kind: "ssh_private_key", payload: { privateKey } },
        publicIdentity: preview.profile.username, appliedAt: new Date().toISOString() };
    } finally { credential.privateKey = ""; }
  },
  async deprovision(credential, context) {
    if (credential.kind === "postgres_admin") throw new Error("ssh_bootstrap_credential_required");
    const runner = context.services.elevatedSshRunner as ElevatedSshRunner | undefined;
    if (!runner) throw new Error("ssh_provisioner_unavailable");
    try {
      const result = await runner({ credential, script: deprovisioningScript(confinementProfile(context.config)) });
      if (result.exitCode !== 0) throw new Error(`ssh_deprovisioning_failed: ${result.stderr.slice(0, 500)}`);
    } finally { credential.privateKey = ""; }
  },
  async probeCapabilities(context) {
    const probe = runtimeProbe(context, "ssh") as SshProbe | undefined;
    if (!probe) throw new Error("ssh_probe_unavailable");
    return probe(context);
  },
  async execute(definition, input, context) {
    const executor = runtimeExecutor(context, "ssh") as SshExecutor | undefined;
    if (!executor) throw new Error("ssh_executor_unavailable");
    return executor(definition.name, input, context);
  },
  auditDiff(before, after) { return { confinement: { before, after } }; }
};
