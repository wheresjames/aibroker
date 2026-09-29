import { afterEach, describe, expect, it, vi } from "vitest";
import type { AIBrokerConfig } from "@aibroker/core";
import { generateApiToken } from "@aibroker/auth";
import { encryptJson } from "@aibroker/crypto";
import { buildServer } from "./server.js";

const key = Buffer.alloc(32, 7);
const config: AIBrokerConfig = {
  nodeEnv: "test", apiPort: 0, webPort: 0, publicUrl: "http://localhost", databaseUrl: "postgres://example",
  redisUrl: "redis://localhost:6379", sessionSecret: "test_session_secret_32_chars_long", encryptionKeyBase64: key.toString("base64"),
  allowPrivateConnectorTargets: true, mcpEnabled: true, mcpCaptureBodies: false, sandboxEnabled: false,
  browserWorkerUrl: "http://127.0.0.1:8090", browserWorkerSecret: "test-browser-secret", browserRpcTimeoutMs: 1000,
  browserAllowPrivateTargets: true, artifactBackend: "filesystem", allowFilesystemArtifacts: true,
  artifactFilesystemRoot: "/tmp/aibroker-test-artifacts", artifactDefaultRetentionSeconds: 86400, artifactMaxRetentionSeconds: 604800
};

// Mocks just enough of Postgres to drive wordpress.list_pages through the real pipeline
// with the given policy constraints. `recentConstraintCalls` feeds the per-tool limiter.
function mockDb(policyConstraints: Record<string, unknown>, recentConstraintCalls = 0) {
  const token = generateApiToken();
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes("from api_tokens t join users u")) {
      return { rows: [{ token_id: "t1", token_hash: token.hash, expires_at: new Date(Date.now() + 3600_000).toISOString(), revoked_at: null, user_id: "u1", role: "user", status: "active" }], rowCount: 1 };
    }
    if (sql.includes("from server_plugins sp join servers s")) {
      return { rows: [{ id: "sp1", plugin_key: "wordpress", instance_name: "default", status: "enabled", config: { base_url: "http://localhost" }, server_id: "s1", server_name: "wp", address: "localhost", server_status: "active", metadata: {} }], rowCount: 1 };
    }
    if (sql.includes("from server_bindings sb") && sql.includes("pp.tool_name = $2")) {
      return { rows: [{ binding_id: "b1", subject_type: "user", subject_id: "u1", server_id: "s1", policy_id: "p1", policy_name: "custom", policy_built_in: false, permission_id: "pp1", tool_name: params[1], effect: "allow", policy_constraints: policyConstraints, binding_constraints: {}, risk_ceiling: null, tool_risk: "low" }], rowCount: 1 };
    }
    if (sql.includes("rate_limit_events where bucket = $1")) {
      const constraintBucket = String(params[0]).startsWith("constraint:");
      return { rows: [{ count: constraintBucket ? recentConstraintCalls : 0 }], rowCount: 1 };
    }
    if (sql.includes("from server_credentials") && sql.includes("wordpress_rest_application_password")) {
      return { rows: [{ id: "c1", encrypted_payload: encryptJson({ username: "u", applicationPassword: "p" }, key), expires_at: null }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const db = { query, connect: async () => ({ query, release: () => undefined }) };
  return { db, token: token.token };
}

async function listPages(policyConstraints: Record<string, unknown>, input: Record<string, unknown>, recentConstraintCalls = 0) {
  const { db, token } = mockDb(policyConstraints, recentConstraintCalls);
  const requested: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    requested.push(new URL(String(url)));
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }));
  const server = await buildServer({ config, db: db as never });
  const response = await server.inject({
    method: "POST", url: "/mcp/call", headers: { authorization: `Bearer ${token}` },
    payload: { tool: "wordpress.list_pages", input: { server_plugin_id: "sp1", ...input } }
  });
  return { response, requested };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("policy constraints on tool calls", () => {
  it("clamps an omitted limit to maxResults", async () => {
    const { response, requested } = await listPages({ maxResults: 10 }, {});
    expect(response.statusCode).toBe(200);
    expect(requested[0]?.searchParams.get("per_page")).toBe("10");
  });

  it("still rejects an explicit limit above maxResults", async () => {
    const { response } = await listPages({ maxResults: 10 }, { limit: 50 });
    expect(response.statusCode).toBe(403);
  });

  it("enforces rateLimit.callsPerMinute", async () => {
    expect((await listPages({ rateLimit: { callsPerMinute: 2 } }, {}, 1)).response.statusCode).toBe(200);
    const limited = await listPages({ rateLimit: { callsPerMinute: 2 } }, {}, 2);
    expect(limited.response.statusCode).toBe(429);
    expect(limited.requested).toHaveLength(0);
  });
});
