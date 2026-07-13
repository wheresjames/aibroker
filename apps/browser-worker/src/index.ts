import Fastify from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { validateDestination, type DestinationPolicy } from "./security.js";

interface BrowserRequest {
  tool: string; url: string; allowed_origins: string[]; allowed_path_prefixes: string[]; allow_private: boolean; private_hostname?: string;
  viewport: { width: number; height: number }; locale: string; timezone: string;
  color_scheme: "light" | "dark" | "no-preference"; wait_until: "load" | "domcontentloaded" | "settled";
  full_page?: boolean; locator?: Record<string, unknown> | null; max_nodes?: number;
  levels?: string[];
  storage_state?: Record<string, unknown>;
  worker_lease_id?: string; cursor?: number; value?: string; values?: string[]; key?: string;
  state?: "visible" | "hidden" | "enabled" | "disabled"; timeout_ms?: number;
}

interface SessionEventState {
  sequence: number; dropped: number; messageCount: number; errorCount: number;
  redactions: string[];
  messages: Array<Record<string, unknown> & { sequence: number }>;
  errors: Array<Record<string, unknown> & { sequence: number }>;
}

interface LiveSession {
  leaseId: string; context: BrowserContext; page: Page; policy: DestinationPolicy; events: SessionEventState;
  idleExpiresAt: number; absoluteExpiresAt: number; busy: boolean;
}

let browser: Browser | null = null;
const metrics = { launches: 0, crashes: 0, timeouts: 0, active: 0, operations: 0, failures: 0, blocked: 0, durationMs: 0 };
const replayWindow = new Map<string, number>();
const sessions = new Map<string, LiveSession>();
const secret = process.env.AIBROKER_BROWSER_WORKER_SECRET ?? "";
const port = Number(process.env.AIBROKER_BROWSER_WORKER_PORT ?? 8090);
const maxScreenshotBytes = Number(process.env.AIBROKER_BROWSER_MAX_SCREENSHOT_BYTES ?? 10 * 1024 * 1024);
const timeoutMs = Number(process.env.AIBROKER_BROWSER_OPERATION_TIMEOUT_MS ?? 30_000);
const maxConcurrent = Math.max(1, Number(process.env.AIBROKER_BROWSER_MAX_CONCURRENT ?? 4) || 4);
const maxSessions = Math.max(1, Number(process.env.AIBROKER_BROWSER_MAX_SESSIONS ?? 20) || 20);
let inFlight = 0;
if (!secret) throw new Error("AIBROKER_BROWSER_WORKER_SECRET is required");

async function getBrowser(): Promise<Browser> {
  if (!browser?.isConnected()) {
    browser = await chromium.launch({ headless: true }); metrics.launches++;
    browser.on("disconnected", () => { metrics.crashes++; });
  }
  return browser;
}

function authenticate(timestamp: string | undefined, nonce: string | undefined, signature: string | undefined, body: unknown): boolean {
  if (!timestamp || !nonce || !/^[0-9a-f-]{36}$/.test(nonce) || !signature || Math.abs(Date.now() - Number(timestamp)) > 30_000) return false;
  const replayKey = nonce;
  if (replayWindow.has(replayKey)) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${nonce}.${JSON.stringify(body)}`).digest();
  let supplied: Buffer; try { supplied = Buffer.from(signature, "hex"); } catch { return false; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
  const now = Date.now(); replayWindow.set(replayKey, now);
  for (const [key, seenAt] of replayWindow) if (now - seenAt > 30_000) replayWindow.delete(key);
  return true;
}

function bounded(value: string, length = 2000): string { return value.replace(/(authorization|cookie|token|password|secret)=?[^\s&]*/gi, "$1=[redacted]").slice(0, length); }

function locate(page: Page, spec: Record<string, unknown> | null | undefined): Locator {
  if (!spec) return page.locator("body");
  const keys = Object.keys(spec);
  if (typeof spec.role === "string" && keys.every((key) => key === "role" || key === "name")) return page.getByRole(spec.role as never, typeof spec.name === "string" ? { name: spec.name, exact: true } : {});
  if (typeof spec.label === "string" && keys.length === 1) return page.getByLabel(spec.label, { exact: true });
  if (typeof spec.text === "string" && keys.length === 1) return page.getByText(spec.text, { exact: true });
  if (typeof spec.test_id === "string" && keys.length === 1) return page.getByTestId(spec.test_id);
  throw new Error("browser_locator_not_allowed");
}

async function applyNetworkPolicy(context: BrowserContext, policy: DestinationPolicy): Promise<void> {
  await context.route("**/*", async (route) => {
    try { await validateDestination(route.request().url(), policy); await route.continue(); }
    catch { metrics.blocked++; await route.abort("blockedbyclient"); }
  });
  if ("routeWebSocket" in context) await context.routeWebSocket(/.*/, async (socket) => {
    try { await validateDestination(socket.url(), policy); socket.connectToServer(); }
    catch { metrics.blocked++; socket.close({ code: 1008, reason: "denied" }); }
  });
}

function attachSessionEvents(page: Page, state: SessionEventState): void {
  page.on("popup", (popup) => void popup.close());
  page.on("console", (message) => {
    state.messageCount++;
    const event = { sequence: ++state.sequence, level: message.type(), text: redactSessionText(bounded(message.text()), state), location: bounded(message.location().url ?? "", 500) };
    state.messages.push(event); if (state.messages.length > 200) { state.messages.shift(); state.dropped++; }
  });
  page.on("pageerror", (error) => {
    state.errorCount++;
    const event = { sequence: ++state.sequence, name: bounded(error.name, 100), message: redactSessionText(bounded(error.message), state), stack: redactSessionText(bounded(error.stack ?? "", 4000), state) };
    state.errors.push(event); if (state.errors.length > 100) { state.errors.shift(); state.dropped++; }
  });
}

function redactSessionText(value: string, state: SessionEventState): string {
  let result = value;
  for (const secret of state.redactions) if (secret) result = result.split(secret).join("[redacted]");
  return result;
}

function rememberSessionValues(state: SessionEventState, values: string[]): void {
  for (const value of values.filter(Boolean)) if (!state.redactions.includes(value)) state.redactions.push(value);
  if (state.redactions.length > 20) state.redactions.splice(0, state.redactions.length - 20);
}

async function newContext(input: BrowserRequest, policy: DestinationPolicy): Promise<BrowserContext> {
  const context = await (await getBrowser()).newContext({
    viewport: input.viewport, locale: input.locale, timezoneId: input.timezone,
    colorScheme: input.color_scheme, serviceWorkers: "block", acceptDownloads: false,
    permissions: [], ...(input.storage_state ? { storageState: input.storage_state as never } : {})
  });
  await applyNetworkPolicy(context, policy);
  return context;
}

function pageSummary(page: Page, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return page.title().then((title) => ({ final_url: page.url(), title: bounded(title, 500), status: null, truncated: false, dropped_count: 0, ...extra }));
}

async function closeLiveSession(session: LiveSession): Promise<void> {
  sessions.delete(session.leaseId);
  await session.context.close().catch(() => undefined);
  session.events.redactions.fill(""); session.events.messages.length = 0; session.events.errors.length = 0;
}

async function liveSession(input: BrowserRequest): Promise<LiveSession> {
  const leaseId = input.worker_lease_id;
  const session = leaseId ? sessions.get(leaseId) : undefined;
  if (!session) throw new Error("browser_session_not_found");
  const now = Date.now();
  if (now >= session.idleExpiresAt || now >= session.absoluteExpiresAt) { await closeLiveSession(session); throw new Error("browser_session_expired"); }
  if (session.busy) throw new Error("browser_session_busy");
  session.busy = true;
  session.idleExpiresAt = Math.min(now + 5 * 60_000, session.absoluteExpiresAt);
  return session;
}

async function waitForReviewed(locator: Locator, state: BrowserRequest["state"], timeout: number): Promise<void> {
  if (state === "visible" || state === "hidden") { await locator.waitFor({ state, timeout }); return; }
  const deadline = Date.now() + timeout, enabled = state === "enabled";
  while (Date.now() < deadline) {
    if (await locator.isEnabled().catch(() => !enabled) === enabled) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("browser_timeout");
}

async function executeSession(input: BrowserRequest): Promise<Record<string, unknown>> {
  if (input.tool === "playwright.open_session") {
    if (!input.worker_lease_id || sessions.has(input.worker_lease_id)) throw new Error("browser_session_conflict");
    if (sessions.size >= maxSessions) throw new Error("browser_session_limit");
    const policy: DestinationPolicy = { allowedOrigins: input.allowed_origins, allowedPathPrefixes: input.allowed_path_prefixes, allowPrivate: input.allow_private,
      ...(input.private_hostname ? { privateHostname: input.private_hostname } : {}), pinnedAddresses: new Map() };
    await validateDestination(input.url, policy);
    const context = await newContext(input, policy), page = await context.newPage();
    const events: SessionEventState = { sequence: 0, dropped: 0, messageCount: 0, errorCount: 0, redactions: [], messages: [], errors: [] };
    attachSessionEvents(page, events);
    const now = Date.now();
    const session: LiveSession = { leaseId: input.worker_lease_id, context, page, policy, events,
      idleExpiresAt: now + 5 * 60_000, absoluteExpiresAt: now + 15 * 60_000, busy: true };
    try {
      await page.goto(input.url, { waitUntil: input.wait_until === "settled" ? "domcontentloaded" : input.wait_until, timeout: timeoutMs });
      if (input.wait_until === "settled") await page.waitForTimeout(500);
      await validateDestination(page.url(), policy); session.busy = false; sessions.set(session.leaseId, session);
      return pageSummary(page, { worker_lease_id: session.leaseId });
    } catch (error) { await context.close().catch(() => undefined); throw error; }
  }
  const session = await liveSession(input);
  if (input.tool === "playwright.close_session") { await closeLiveSession(session); return { status: "closed" }; }
  try {
    const page = session.page;
    if (input.tool === "playwright.navigate") {
      await validateDestination(input.url, session.policy);
      const response = await page.goto(input.url, { waitUntil: input.wait_until === "settled" ? "domcontentloaded" : input.wait_until, timeout: timeoutMs });
      if (input.wait_until === "settled") await page.waitForTimeout(500);
      await validateDestination(page.url(), session.policy);
      return pageSummary(page, { status: response?.status() ?? null });
    }
    if (input.tool === "playwright.capture_screenshot") {
      const target = locate(page, input.locator); if (await target.count() !== 1) throw new Error("browser_locator_ambiguous");
      const data = input.locator ? await target.screenshot({ type: "png", timeout: timeoutMs }) : await page.screenshot({ type: "png", fullPage: input.full_page === true, timeout: timeoutMs });
      if (data.byteLength > maxScreenshotBytes) throw new Error("browser_output_too_large");
      return pageSummary(page, { mime_type: "image/png", data_base64: data.toString("base64") });
    }
    if (input.tool === "playwright.get_page_metadata") return pageSummary(page, { metadata: await page.evaluate(() => ({ language: document.documentElement.lang || null, description: document.querySelector('meta[name="description"]')?.getAttribute("content") ?? null })) });
    if (input.tool === "playwright.get_page_snapshot") {
      const raw = await page.locator("body").ariaSnapshot({ timeout: timeoutMs });
      const lines = raw.split("\n").map((line) => line.replace(/^(\s*-\s*(?:textbox|combobox|searchbox|spinbutton)\b[^:]*):.*$/i, "$1: [redacted]"));
      const maxNodes = Math.min(1000, Math.max(1, Number(input.max_nodes ?? 500))), snapshot = bounded(lines.slice(0, maxNodes).join("\n"), 100_000);
      return pageSummary(page, { snapshot, truncated: lines.length > maxNodes || snapshot.length >= 100_000, dropped_count: Math.max(0, lines.length - maxNodes) });
    }
    if (input.tool === "playwright.get_console_messages") {
      const cursor = Math.max(0, Number(input.cursor ?? 0));
      const candidates = session.events.messages.filter((event) => event.sequence > cursor && (!input.levels?.length || input.levels.includes(String(event.level))));
      const messages = candidates.slice(0, 100), nextCursor = messages.at(-1)?.sequence ?? cursor;
      return pageSummary(page, { messages, next_cursor: nextCursor, event_count: session.events.messageCount, truncated: candidates.length > messages.length, dropped_count: session.events.dropped });
    }
    if (input.tool === "playwright.get_page_errors") {
      const cursor = Math.max(0, Number(input.cursor ?? 0)), candidates = session.events.errors.filter((event) => event.sequence > cursor);
      const errors = candidates.slice(0, 50), nextCursor = errors.at(-1)?.sequence ?? cursor;
      return pageSummary(page, { errors, next_cursor: nextCursor, event_count: session.events.errorCount, truncated: candidates.length > errors.length, dropped_count: session.events.dropped });
    }
    const target = locate(page, input.locator); if (await target.count() !== 1) throw new Error("browser_locator_ambiguous");
    if (input.tool === "playwright.fill") { rememberSessionValues(session.events, [String(input.value ?? "")]); await target.fill(String(input.value ?? ""), { timeout: timeoutMs }); }
    else if (input.tool === "playwright.select_option") { rememberSessionValues(session.events, (input.values ?? []).map(String)); await target.selectOption((input.values ?? []).map(String), { timeout: timeoutMs }); }
    else if (input.tool === "playwright.press_key") await target.press(String(input.key), { timeout: timeoutMs });
    else if (input.tool === "playwright.wait_for") await waitForReviewed(target, input.state, Math.min(5000, Math.max(100, Number(input.timeout_ms ?? 3000))));
    else if (input.tool === "playwright.click") { await target.click({ timeout: timeoutMs, noWaitAfter: true }); await page.waitForTimeout(200); }
    else throw new Error("browser_tool_not_supported");
    await validateDestination(page.url(), session.policy);
    return pageSummary(page);
  } finally { session.busy = false; }
}

async function execute(input: BrowserRequest): Promise<Record<string, unknown>> {
  const started = Date.now(); metrics.operations++;
  const policy: DestinationPolicy = { allowedOrigins: input.allowed_origins, allowedPathPrefixes: input.allowed_path_prefixes, allowPrivate: input.allow_private,
    ...(input.private_hostname ? { privateHostname: input.private_hostname } : {}), pinnedAddresses: new Map() };
  try { await validateDestination(input.url, policy); } catch (error) { metrics.blocked++; throw error; }
  const instance = await getBrowser(); metrics.active++; let context: BrowserContext | null = null;
  const messages: Array<Record<string, unknown>> = [], errors: Array<Record<string, unknown>> = []; let dropped = 0;
  try {
    context = await instance.newContext({
      viewport: input.viewport, locale: input.locale, timezoneId: input.timezone,
      colorScheme: input.color_scheme, serviceWorkers: "block", acceptDownloads: false,
      ...(input.storage_state ? { storageState: input.storage_state as never } : {})
    });
    await context.route("**/*", async (route) => {
      try { await validateDestination(route.request().url(), policy); await route.continue(); }
      catch { metrics.blocked++; await route.abort("blockedbyclient"); }
    });
    if ("routeWebSocket" in context) await context.routeWebSocket(/.*/, async (socket) => {
      try { await validateDestination(socket.url(), policy); socket.connectToServer(); } catch { socket.close({ code: 1008, reason: "denied" }); }
    });
    const page = await context.newPage();
    page.on("popup", (popup) => void popup.close());
    page.on("console", (message) => {
      if (messages.length >= 100) { dropped++; return; }
      messages.push({ level: message.type(), text: bounded(message.text()), location: bounded(message.location().url ?? "", 500) });
    });
    page.on("pageerror", (error) => {
      if (errors.length >= 50) { dropped++; return; }
      errors.push({ name: bounded(error.name, 100), message: bounded(error.message), stack: bounded(error.stack ?? "", 4000) });
    });
    const response = await page.goto(input.url, { waitUntil: input.wait_until === "settled" ? "domcontentloaded" : input.wait_until, timeout: timeoutMs });
    if (input.wait_until === "settled") await page.waitForTimeout(500);
    await validateDestination(page.url(), policy);
    const base = { final_url: page.url(), title: bounded(await page.title(), 500), status: response?.status() ?? null, truncated: dropped > 0, dropped_count: dropped };
    switch (input.tool) {
      case "playwright.capture_screenshot": {
        const target = locate(page, input.locator); if (await target.count() !== 1) throw new Error("browser_locator_ambiguous");
        const data = input.locator ? await target.screenshot({ type: "png", timeout: timeoutMs }) : await page.screenshot({ type: "png", fullPage: input.full_page === true, timeout: timeoutMs });
        if (data.byteLength > maxScreenshotBytes) throw new Error("browser_output_too_large");
        return { ...base, mime_type: "image/png", data_base64: data.toString("base64") };
      }
      case "playwright.get_page_metadata": return { ...base, metadata: await page.evaluate(() => ({ language: document.documentElement.lang || null, description: document.querySelector('meta[name="description"]')?.getAttribute("content") ?? null })) };
      case "playwright.get_page_snapshot": {
        const raw = await page.locator("body").ariaSnapshot({ timeout: timeoutMs });
        const lines = raw.split("\n").map((line) => line.replace(/^(\s*-\s*(?:textbox|combobox|searchbox|spinbutton)\b[^:]*):.*$/i, "$1: [redacted]"));
        const maxNodes = Math.min(1000, Math.max(1, Number(input.max_nodes ?? 500)));
        const snapshot = bounded(lines.slice(0, maxNodes).join("\n"), 100_000);
        return { ...base, snapshot, truncated: lines.length > maxNodes || snapshot.length >= 100_000,
          dropped_count: dropped + Math.max(0, lines.length - maxNodes) };
      }
      case "playwright.get_console_messages": return { ...base, messages: input.levels?.length ? messages.filter((message) => input.levels!.includes(String(message.level))) : messages };
      case "playwright.get_page_errors": return { ...base, errors };
      default: throw new Error("browser_tool_not_supported");
    }
  } finally { metrics.active--; metrics.durationMs += Date.now() - started; await context?.close().catch(() => undefined); }
}

const app = Fastify({ bodyLimit: 256 * 1024, logger: true });
const executionBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["tool", "url", "allowed_origins", "allowed_path_prefixes", "allow_private", "viewport", "locale", "timezone", "color_scheme", "wait_until"],
  properties: {
    tool: { type: "string", enum: ["playwright.capture_screenshot", "playwright.get_page_metadata", "playwright.get_page_snapshot", "playwright.get_console_messages", "playwright.get_page_errors", "playwright.open_session", "playwright.navigate", "playwright.close_session", "playwright.fill", "playwright.select_option", "playwright.press_key", "playwright.wait_for", "playwright.click"] },
    url: { type: "string", minLength: 1, maxLength: 4096 },
    allowed_origins: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 2048 } },
    allowed_path_prefixes: { type: "array", maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 2048 } },
    allow_private: { type: "boolean" },
    private_hostname: { type: "string", minLength: 1, maxLength: 253 },
    viewport: { type: "object", additionalProperties: false, required: ["width", "height"], properties: {
      width: { type: "integer", minimum: 320, maximum: 3840 }, height: { type: "integer", minimum: 240, maximum: 2160 }
    } },
    locale: { type: "string", minLength: 2, maxLength: 35 },
    timezone: { type: "string", minLength: 1, maxLength: 100 },
    color_scheme: { type: "string", enum: ["light", "dark", "no-preference"] },
    wait_until: { type: "string", enum: ["load", "domcontentloaded", "settled"] },
    full_page: { type: "boolean" },
    locator: { type: ["object", "null"], additionalProperties: false, maxProperties: 2, properties: {
      role: { type: "string", maxLength: 100 }, name: { type: "string", maxLength: 500 }, label: { type: "string", maxLength: 500 },
      text: { type: "string", maxLength: 500 }, test_id: { type: "string", maxLength: 500 }
    } },
    max_nodes: { type: "integer", minimum: 1, maximum: 1000 },
    levels: { type: "array", maxItems: 10, uniqueItems: true, items: { type: "string", enum: ["log", "debug", "info", "error", "warning", "warn", "dir", "trace"] } },
    storage_state: { type: "object" },
    worker_lease_id: { type: "string", format: "uuid" },
    cursor: { type: "integer", minimum: 0 },
    value: { type: "string", maxLength: 10000 },
    values: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", maxLength: 500 } },
    key: { type: "string", enum: ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "Space"] },
    state: { type: "string", enum: ["visible", "hidden", "enabled", "disabled"] },
    timeout_ms: { type: "integer", minimum: 100, maximum: 5000 }
  }
} as const;
app.setErrorHandler((error, _request, reply) => {
  if ((error as { validation?: unknown }).validation) return reply.code(400).send({ error: "browser_invalid_request" });
  return reply.code(500).send({ error: "browser_runtime_unavailable" });
});
app.get("/health/live", async () => ({ status: "ok" }));
app.get("/metrics", async (_request, reply) => reply.type("text/plain; version=0.0.4").send([
  `aibroker_browser_launches_total ${metrics.launches}`,
  `aibroker_browser_crashes_total ${metrics.crashes}`,
  `aibroker_browser_timeouts_total ${metrics.timeouts}`,
  `aibroker_browser_active_contexts ${metrics.active + sessions.size}`,
  `aibroker_browser_live_sessions ${sessions.size}`,
  `aibroker_browser_max_sessions ${maxSessions}`,
  `aibroker_browser_requests_in_flight ${inFlight}`,
  `aibroker_browser_max_concurrent ${maxConcurrent}`,
  `aibroker_browser_operations_total ${metrics.operations}`,
  `aibroker_browser_failures_total ${metrics.failures}`,
  `aibroker_browser_blocked_requests_total ${metrics.blocked}`,
  `aibroker_browser_operation_duration_milliseconds_total ${metrics.durationMs}`
].join("\n") + "\n"));
app.get("/health/ready", async (_request, reply) => {
  try { await getBrowser(); return { status: "ok", browser: await browser!.version() }; }
  catch { return reply.code(503).send({ status: "error" }); }
});
app.post<{ Body: BrowserRequest }>("/v1/execute", { schema: { body: executionBodySchema } }, async (request, reply) => {
  if (!authenticate(request.headers["x-aib-timestamp"] as string | undefined, request.headers["x-aib-nonce"] as string | undefined, request.headers["x-aib-signature"] as string | undefined, request.body)) return reply.code(401).send({ error: "unauthorized" });
  if (inFlight >= maxConcurrent) return reply.code(429).send({ error: "browser_concurrency_limit" });
  inFlight++;
  const sessionOperation = Boolean(request.body.worker_lease_id || request.body.tool === "playwright.open_session");
  const started = Date.now(); if (sessionOperation) metrics.operations++;
  try { return sessionOperation ? await executeSession(request.body) : await execute(request.body); }
  catch (error) {
    metrics.failures++;
    const candidate = error instanceof Error ? error.message : "browser_execution_failed";
    const allowed = new Set(["browser_destination_denied", "browser_output_too_large", "browser_locator_ambiguous", "browser_locator_not_allowed", "browser_session_not_found", "browser_session_expired", "browser_session_busy", "browser_session_conflict", "browser_session_limit"]);
    const code = allowed.has(candidate) ? candidate : candidate.includes("Timeout") ? "browser_timeout" : "browser_navigation_failed";
    if (code === "browser_timeout") metrics.timeouts++;
    const status = code === "browser_destination_denied" ? 403 : code === "browser_output_too_large" ? 413 : code === "browser_timeout" ? 504 : 422;
    return reply.code(status).send({ error: code });
  }
  finally { inFlight--; if (sessionOperation) metrics.durationMs += Date.now() - started; }
});

app.post<{ Body: Record<string, never> }>("/v1/sessions/list", { schema: { body: { type: "object", additionalProperties: false } } }, async (request, reply) => {
  if (!authenticate(request.headers["x-aib-timestamp"] as string | undefined, request.headers["x-aib-nonce"] as string | undefined, request.headers["x-aib-signature"] as string | undefined, request.body)) return reply.code(401).send({ error: "unauthorized" });
  return { leases: [...sessions.values()].map((session) => ({ worker_lease_id: session.leaseId, current_url: session.page.url(), idle_expires_at: session.idleExpiresAt, absolute_expires_at: session.absoluteExpiresAt })) };
});
app.post<{ Body: { worker_lease_id: string } }>("/v1/sessions/close", { schema: { body: { type: "object", additionalProperties: false,
  required: ["worker_lease_id"], properties: { worker_lease_id: { type: "string", format: "uuid" } } } } }, async (request, reply) => {
  if (!authenticate(request.headers["x-aib-timestamp"] as string | undefined, request.headers["x-aib-nonce"] as string | undefined, request.headers["x-aib-signature"] as string | undefined, request.body)) return reply.code(401).send({ error: "unauthorized" });
  const session = sessions.get(request.body.worker_lease_id);
  if (session) await closeLiveSession(session);
  return { status: "closed" };
});

const sessionExpiry = setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) if (now >= session.idleExpiresAt || now >= session.absoluteExpiresAt) void closeLiveSession(session);
}, 5000);
sessionExpiry.unref();

const shutdown = async () => { clearInterval(sessionExpiry); await Promise.all([...sessions.values()].map(closeLiveSession)); await app.close(); await browser?.close(); process.exit(0); };
process.on("SIGTERM", () => void shutdown()); process.on("SIGINT", () => void shutdown());
await app.listen({ host: "0.0.0.0", port });
