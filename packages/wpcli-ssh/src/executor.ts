import { createPrivateKey } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ElevatedCredential } from "@aibroker/plugin-sdk";

export interface SshExecutionOptions {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  passphrase?: string;
  knownHostsLine: string;
  command: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface SshExecutionResult { exitCode: number; stdout: string; stderr: string; durationMs: number; }

export async function executeElevatedSshScript(options: { credential: ElevatedCredential; script: string }): Promise<SshExecutionResult> {
  validateConnection({
    host: options.credential.host, port: options.credential.port, username: options.credential.username,
    privateKey: options.credential.privateKey, knownHostsLine: options.credential.knownHostsLine, command: ["sh", "-s"]
  });
  if (!options.script.trim()) throw new Error("Provisioning script is required");
  const directory = await mkdtemp(path.join(tmpdir(), "aibroker-bootstrap-"));
  const knownHostsPath = path.join(directory, "known_hosts");
  const started = Date.now();
  let agent: { socket: string; pid: string } | null = null;
  try {
    await writeFile(knownHostsPath, `${options.credential.knownHostsLine.trim()}\n`, { mode: 0o600 });
    const launched = await runProcess("ssh-agent", ["-s"], undefined, {});
    if (launched.exitCode !== 0) throw new Error(`ssh_agent_failed: ${launched.stderr}`);
    const socket = launched.stdout.match(/SSH_AUTH_SOCK=([^;]+)/)?.[1];
    const pid = launched.stdout.match(/SSH_AGENT_PID=([0-9]+)/)?.[1];
    if (!socket || !pid) throw new Error("ssh_agent_output_invalid");
    agent = { socket, pid };
    const agentEnv = { SSH_AUTH_SOCK: socket, SSH_AGENT_PID: pid };
    const key = Buffer.from(options.credential.privateKey, "utf8");
    try {
      const added = await runProcess("ssh-add", ["-"], key, agentEnv);
      if (added.exitCode !== 0) throw new Error(`ssh_add_failed: ${added.stderr}`);
    } finally { key.fill(0); }
    const args = [
      "-T", "-p", String(options.credential.port), "-o", "BatchMode=yes", "-o", "IdentitiesOnly=no",
      "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHostsPath}`, "-o", "LogLevel=ERROR",
      `${options.credential.username}@${options.credential.host}`,
      options.credential.useSudo ? "sudo -n sh -s" : "sh -s"
    ];
    const result = await runProcess("ssh", args, Buffer.from(options.script, "utf8"), agentEnv);
    return { ...result, durationMs: Date.now() - started };
  } finally {
    if (agent) await runProcess("ssh-agent", ["-k"], undefined, { SSH_AUTH_SOCK: agent.socket, SSH_AGENT_PID: agent.pid }).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

export interface SshSessionOptions extends Omit<SshExecutionOptions, "command" | "signal"> {
  initialCommand?: string[];
  onOutput(chunk: Buffer): Promise<void>;
  readInput(): Promise<Buffer[]>;
  shouldStop(): Promise<boolean>;
}

export async function executeSshCommand(options: SshExecutionOptions): Promise<SshExecutionResult> {
  validateConnection(options);
  if (options.command.length === 0) throw new Error("Remote command is required");
  const directory = await mkdtemp(path.join(tmpdir(), "aibroker-ssh-"));
  const keyPath = path.join(directory, "key");
  const knownHostsPath = path.join(directory, "known_hosts");
  let keyMaterial = Buffer.from(exportKey(options.privateKey, options.passphrase), "utf8");
  const started = Date.now();
  try {
    await writeFile(keyPath, keyMaterial, { mode: 0o600 });
    await writeFile(knownHostsPath, `${options.knownHostsLine.trim()}\n`, { mode: 0o600 });
    const remoteCommand = options.command.map(posixQuote).join(" ");
    const args = [
      "-T", "-p", String(options.port), "-i", keyPath, "-o", "BatchMode=yes",
      "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHostsPath}`,
      "-o", "LogLevel=ERROR", `${options.username}@${options.host}`, remoteCommand
    ];
    return await runBounded("ssh", args, options.timeoutMs ?? 120_000, options.maxOutputBytes ?? 1024 * 1024, options.signal, started);
  } finally {
    keyMaterial.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runSshSession(options: SshSessionOptions): Promise<number> {
  validateConnection({ ...options, command: [] });
  const directory = await mkdtemp(path.join(tmpdir(), "aibroker-session-"));
  const keyPath = path.join(directory, "key"), knownHostsPath = path.join(directory, "known_hosts");
  let keyMaterial = Buffer.from(exportKey(options.privateKey, options.passphrase), "utf8");
  try {
    await writeFile(keyPath, keyMaterial, { mode: 0o600 }); await writeFile(knownHostsPath, `${options.knownHostsLine.trim()}\n`, { mode: 0o600 });
    const args = ["-tt", "-p", String(options.port), "-i", keyPath, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHostsPath}`, "-o", "LogLevel=ERROR", `${options.username}@${options.host}`, ...(options.initialCommand?.length ? [options.initialCommand.map(posixQuote).join(" ")] : [])];
    const child = spawn("ssh", args, { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", TERM: "xterm-256color" } });
    child.stdout.on("data", (chunk: Buffer) => void options.onOutput(Buffer.from(chunk))); child.stderr.on("data", (chunk: Buffer) => void options.onOutput(Buffer.from(chunk)));
    const pump = setInterval(async () => {
      if (await options.shouldStop()) child.kill("SIGHUP");
      else for (const chunk of await options.readInput()) child.stdin.write(chunk);
    }, 250);
    const timeout = setTimeout(() => child.kill("SIGHUP"), options.timeoutMs ?? 14_400_000);
    return await new Promise<number>((resolve, reject) => { child.on("error", reject); child.on("close", (code) => resolve(code ?? 255)); }).finally(() => { clearInterval(pump); clearTimeout(timeout); });
  } finally { keyMaterial.fill(0); await rm(directory, { recursive: true, force: true }); }
}

export function posixQuote(value: string): string {
  if (value.includes("\0")) throw new Error("Command argument contains NUL");
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function exportKey(privateKey: string, passphrase?: string): string {
  if (!passphrase) return privateKey;
  return createPrivateKey({ key: privateKey, format: "pem", passphrase }).export({ type: "pkcs8", format: "pem" }).toString();
}

function validateConnection(options: SshExecutionOptions): void {
  if (!/^[A-Za-z0-9.-]+$/.test(options.host)) throw new Error("Invalid SSH host");
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(options.username)) throw new Error("Invalid SSH username");
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("Invalid SSH port");
  if (!options.knownHostsLine.trim() || /[\r\n]/.test(options.knownHostsLine.trim())) throw new Error("A single pinned known_hosts entry is required");
}

function runBounded(executable: string, args: string[], timeoutMs: number, maxBytes: number, signal: AbortSignal | undefined, started: number): Promise<SshExecutionResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" } });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let total = 0, settled = false;
    const stop = (error: Error) => { if (settled) return; settled = true; child.kill("SIGKILL"); reject(error); };
    const collect = (target: Buffer[]) => (chunk: Buffer) => { total += chunk.length; if (total > maxBytes) stop(Object.assign(new Error("SSH output exceeded limit"), { code: "output_limit" })); else target.push(Buffer.from(chunk)); };
    child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
    const timer = setTimeout(() => stop(Object.assign(new Error("SSH command timed out"), { code: "timeout" })), timeoutMs);
    const abort = () => stop(Object.assign(new Error("SSH command cancelled"), { code: "cancelled" }));
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", stop);
    child.on("close", (code) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); if (settled) return; settled = true; resolve({ exitCode: code ?? 255, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), durationMs: Date.now() - started }); });
  });
}

function runProcess(executable: string, args: string[], input: Buffer | undefined, extraEnv: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", ...extraEnv } });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 255, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    if (input) { child.stdin!.end(input); }
  });
}
