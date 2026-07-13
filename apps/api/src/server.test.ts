import { describe, expect, it } from "vitest";
import { buildServer, ensureBootstrapAdmin } from "./server.js";
import type { AIBrokerConfig } from "@aibroker/core";
import { hashPassword } from "@aibroker/auth";
import { createHmac } from "node:crypto";

const config: AIBrokerConfig = {
  nodeEnv: "test",
  apiPort: 0,
  webPort: 0,
  publicUrl: "http://localhost",
  databaseUrl: "postgres://example",
  redisUrl: "redis://localhost:6379",
  sessionSecret: "test_session_secret_32_chars_long",
  encryptionKeyBase64: Buffer.alloc(32).toString("base64"),
  allowPrivateConnectorTargets: true,
  mcpEnabled: false,
  mcpCaptureBodies: false,
  sandboxEnabled: false,
  browserWorkerUrl: "http://127.0.0.1:8090",
  browserWorkerSecret: "test-browser-secret",
  browserRpcTimeoutMs: 1000,
  browserAllowPrivateTargets: true,
  artifactBackend: "filesystem",
  allowFilesystemArtifacts: true,
  artifactFilesystemRoot: "/tmp/aibroker-test-artifacts",
  artifactDefaultRetentionSeconds: 86400,
  artifactMaxRetentionSeconds: 604800,
};

function sessionHeaders(userId: string, expiresAt = Math.floor(Date.now() / 1000) + 3600) {
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: expiresAt })).toString("base64url");
  const signature = createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  return { "x-aibroker-session": `${payload}.${signature}` };
}

describe("API health", () => {
  it("returns live status without database access", async () => {
    const server = await buildServer({
      config,
      db: {
        query: async () => ({ rows: [], rowCount: 0 })
      } as never
    });
    const response = await server.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", checks: { api: "ok" } });
  });

  it("requires admin authentication for admin routes", async () => {
    const server = await buildServer({
      config,
      db: {
        query: async () => {
          throw new Error("database should not be queried without an admin header");
        }
      } as never
    });
    const response = await server.inject({ method: "GET", url: "/admin/summary" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "admin_auth_required" });
  });

  it("rejects the legacy caller-controlled user id header", async () => {
    const server = await buildServer({
      config,
      db: { query: async () => { throw new Error("an unsigned identity must not reach the database"); } } as never
    });
    const response = await server.inject({
      method: "GET",
      url: "/admin/summary",
      headers: { "x-aibroker-user-id": "admin-1" }
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a session token with a forged signature", async () => {
    const headers = sessionHeaders("admin-1");
    headers["x-aibroker-session"] += "forged";
    const server = await buildServer({
      config,
      db: { query: async () => { throw new Error("a forged session must not reach the database"); } } as never
    });
    const response = await server.inject({ method: "GET", url: "/admin/summary", headers });
    expect(response.statusCode).toBe(401);
  });

  it("rejects an expired signed session before database access", async () => {
    const server = await buildServer({
      config,
      db: { query: async () => { throw new Error("an expired session must not reach the database"); } } as never
    });
    const response = await server.inject({
      method: "GET",
      url: "/admin/summary",
      headers: sessionHeaders("admin-1", Math.floor(Date.now() / 1000) - 1)
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("bootstrap admin", () => {
  it("prints and forces rotation for a legacy seeded admin that has never logged in", async () => {
    const statements: string[] = [];
    const messages: string[] = [];
    const db = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("count(*)::int")) return { rows: [{ count: 1 }], rowCount: 1 };
        if (sql.includes("password_change_required, last_login_at")) {
          return { rows: [{ password_change_required: false, last_login_at: null }], rowCount: 1 };
        }
        if (sql.includes("insert into users")) return { rows: [], rowCount: 1 };
        if (sql.includes("select password_change_required")) {
          return { rows: [{ password_change_required: true }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    await ensureBootstrapAdmin(
      db as never,
      {
        AIBROKER_BOOTSTRAP_ADMIN_EMAIL: "admin@example.com",
        AIBROKER_BOOTSTRAP_ADMIN_PASSWORD: "temporary-password"
      } as NodeJS.ProcessEnv,
      { warn: (message) => messages.push(message) }
    );

    expect(statements.some((statement) => statement.includes("insert into users"))).toBe(true);
    expect(messages.join("\n")).toContain("Username: admin@example.com");
    expect(messages.join("\n")).toContain("Password: temporary-password");
  });

  it("does not print credentials after the bootstrap password was changed", async () => {
    const statements: string[] = [];
    const messages: string[] = [];
    const db = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("count(*)::int")) return { rows: [{ count: 1 }], rowCount: 1 };
        if (sql.includes("password_change_required, last_login_at")) {
          return { rows: [{ password_change_required: false, last_login_at: "2026-07-13T10:00:00Z" }], rowCount: 1 };
        }
        if (sql.includes("select password_change_required")) {
          return { rows: [{ password_change_required: false }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };

    await ensureBootstrapAdmin(
      db as never,
      {
        AIBROKER_BOOTSTRAP_ADMIN_EMAIL: "admin@example.com",
        AIBROKER_BOOTSTRAP_ADMIN_PASSWORD: "obsolete-password"
      } as NodeJS.ProcessEnv,
      { warn: (message) => messages.push(message) }
    );

    expect(statements.some((statement) => statement.includes("insert into users"))).toBe(false);
    expect(messages).toEqual([]);
  });
});

describe("password change policy", () => {
  it("rejects short new passwords in production", async () => {
    const server = await buildServer({
      config: { ...config, nodeEnv: "production" },
      db: {
        query: async () => {
          throw new Error("database should not be queried for invalid password policy");
        }
      } as never
    });

    const response = await server.inject({
      method: "POST",
      url: "/auth/change-password",
      payload: {
        email: "admin@example.com",
        current_password: "bootstrap",
        new_password: "short"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "validation_error",
      message: "New password must be at least 12 characters."
    });
  });

  it("allows short changed passwords in development", async () => {
    const currentPassword = "bootstrap";
    const passwordHash = await hashPassword(currentPassword);
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from users where email")) {
          return {
            rows: [
              {
                id: "user-1",
                email: "admin@example.com",
                display_name: "Admin",
                password_hash: passwordHash,
                role: "global_admin",
                status: "active",
                password_change_required: true
              }
            ],
            rowCount: 1
          };
        }
        if (sql.includes("insert into audit_events")) return { rows: [], rowCount: 1 };
        if (sql.includes("update users")) {
          return {
            rows: [
              {
                id: "user-1",
                email: "admin@example.com",
                display_name: "Admin",
                role: "global_admin",
                status: "active",
                password_change_required: false
              }
            ],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config: { ...config, nodeEnv: "development" }, db: db as never });

    const response = await server.inject({
      method: "POST",
      url: "/auth/change-password",
      payload: {
        email: "admin@example.com",
        current_password: currentPassword,
        new_password: "short"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().password_change_required).toBe(false);
  });
});

describe("user creation forces a password change", () => {
  it("sets password_change_required = true on the insert", async () => {
    const statements: string[] = [];
    const db = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("from users where id = $1")) {
          return { rows: [activeUserRow("admin-1", "global_admin")], rowCount: 1 };
        }
        if (sql.startsWith("insert into users")) {
          return {
            rows: [{ id: "u-new", email: "new@example.com", display_name: "New", role: "user", status: "active", password_change_required: true }],
            rowCount: 1
          };
        }
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({
      method: "POST",
      url: "/admin/users",
      headers: sessionHeaders("admin-1"),
      payload: { email: "new@example.com", display_name: "New", password: "temp-password-1", role: "user", status: "active" }
    });
    expect(response.statusCode).toBe(200);
    const insert = statements.find((statement) => statement.startsWith("insert into users"));
    expect(insert).toBeDefined();
    expect(insert).toContain("password_change_required");
    expect(insert).toContain("true)");
  });
});

function activeUserRow(id: string, role = "user") {
  return { id, owner_user_id: null, email: `${id}@example.com`, display_name: id, role, status: "active", password_change_required: false };
}

describe("self-service /me routes", () => {
  it("requires authentication", async () => {
    const server = await buildServer({
      config,
      db: {
        query: async () => {
          throw new Error("database should not be queried without a user header");
        }
      } as never
    });
    const response = await server.inject({ method: "GET", url: "/me/tokens" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "auth_required" });
  });

  it("lists the actor's own tokens", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from users where id = $1")) return { rows: [activeUserRow("u1")], rowCount: 1 };
        if (sql.includes("from api_tokens t join users u")) {
          return { rows: [{ id: "tok-1", user_id: "u1", name: "laptop", token_prefix: "wpb_abc12345_", expires_at: "2030-01-01" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({ method: "GET", url: "/me/tokens", headers: sessionHeaders("u1") });
    expect(response.statusCode).toBe(200);
    expect(response.json().tokens).toHaveLength(1);
    expect(response.json().tokens[0].name).toBe("laptop");
  });

  it("creates a token for the actor and returns the secret", async () => {
    let audited = false;
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from users where id = $1")) return { rows: [activeUserRow("u1")], rowCount: 1 };
        if (sql.includes("insert into api_tokens")) return { rows: [{ id: "tok-2", user_id: "u1", name: "client", token_prefix: "wpb_new_", expires_at: "2030-01-01", created_at: "2026-01-01" }], rowCount: 1 };
        if (sql.includes("insert into audit_events")) { audited = true; return { rows: [], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({
      method: "POST",
      url: "/me/tokens",
      headers: sessionHeaders("u1"),
      payload: { name: "client", expires_at: "2030-01-01" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().token.id).toBe("tok-2");
    expect(typeof response.json().secret).toBe("string");
    expect(response.json().secret.length).toBeGreaterThan(0);
    expect(audited).toBe(true);
  });

  it("explains which field is missing when a self-service token has no name", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from users where id = $1")) return { rows: [activeUserRow("u1")], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({
      method: "POST",
      url: "/me/tokens",
      headers: sessionHeaders("u1"),
      payload: { expires_at: "2030-01-01" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "validation_error", message: "A token name is required." });
  });

  it("explains that an admin token needs a target user", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from users where id = $1")) return { rows: [activeUserRow("admin-1", "global_admin")], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({
      method: "POST",
      url: "/admin/tokens",
      headers: sessionHeaders("admin-1"),
      payload: { name: "client", expires_at: "2030-01-01" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "validation_error", message: "A user is required for the token." });
  });

  it("rejects revoking another user's token", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from users where id = $1")) return { rows: [activeUserRow("u1")], rowCount: 1 };
        // ownership check: not owned by u1
        if (sql.includes("from api_tokens where id = $1 and user_id = $2")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({
      method: "POST",
      url: "/me/tokens/tok-other/revoke",
      headers: sessionHeaders("u1")
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "not_owner" });
  });

  it("returns only the actor's own activity", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from users where id = $1")) {
          if (sql.includes("last_login_at")) return { rows: [{ last_login_at: "2026-07-08T10:00:00Z" }], rowCount: 1 };
          return { rows: [activeUserRow("u1")], rowCount: 1 };
        }
        if (sql.includes("count(*)::int")) return { rows: [{ count: 7 }], rowCount: 1 };
        if (sql.includes("from audit_events where actor_user_id = $1")) {
          return { rows: [{ id: "e1", event_type: "mcp_tool_call", status: "success", tool_name: "wordpress.list_sites", created_at: "2026-07-08T09:00:00Z" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({ method: "GET", url: "/me/activity", headers: sessionHeaders("u1") });
    expect(response.statusCode).toBe(200);
    expect(response.json().events).toHaveLength(1);
    expect(response.json().last_login_at).toBe("2026-07-08T10:00:00Z");
    expect(response.json().active_tokens).toBe(7);
    expect(response.json().recent_calls).toBe(7);
  });
});

describe("broker defaults", () => {
  it("returns the default MCP server name to any active user", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from users where id = $1")) return { rows: [activeUserRow("u1")], rowCount: 1 };
        if (sql.includes("from app_settings where key = 'default_mcp_server_name'")) return { rows: [{ value: "aibroker" }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({ method: "GET", url: "/me/broker-config", headers: sessionHeaders("u1") });
    expect(response.statusCode).toBe(200);
    expect(response.json().default_mcp_server_name).toBe("aibroker");
  });

  it("falls back to aibroker when the setting is missing", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from users where id = $1")) return { rows: [activeUserRow("u1")], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({ method: "GET", url: "/me/broker-config", headers: sessionHeaders("u1") });
    expect(response.statusCode).toBe(200);
    expect(response.json().default_mcp_server_name).toBe("aibroker");
  });

  it("lets a global admin update the default server name", async () => {
    const statements: string[] = [];
    const db = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes("from users where id = $1")) return { rows: [activeUserRow("admin-1", "global_admin")], rowCount: 1 };
        if (sql.includes("from app_settings where key = 'default_mcp_server_name'")) return { rows: [{ value: "aibroker" }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({
      method: "PUT",
      url: "/admin/broker-defaults",
      headers: sessionHeaders("admin-1"),
      payload: { default_mcp_server_name: "acme-wp" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().default_mcp_server_name).toBe("acme-wp");
    expect(statements.some((sql) => sql.includes("insert into app_settings"))).toBe(true);
  });

  it("rejects an invalid server name", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from users where id = $1")) return { rows: [activeUserRow("admin-1", "global_admin")], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({
      method: "PUT",
      url: "/admin/broker-defaults",
      headers: sessionHeaders("admin-1"),
      payload: { default_mcp_server_name: "bad name!" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("validation_error");
  });

  it("forbids a team admin from updating broker defaults", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from users where id = $1")) return { rows: [activeUserRow("admin-2", "team_admin")], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({
      method: "PUT",
      url: "/admin/broker-defaults",
      headers: sessionHeaders("admin-2"),
      payload: { default_mcp_server_name: "acme-wp" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("global_admin_required");
  });
});

describe("profile and record editing", () => {
  it("lets a user update their own profile", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.startsWith("select id from users where email")) return { rows: [], rowCount: 0 };
        if (sql.includes("from users where id = $1")) return { rows: [activeUserRow("u1")], rowCount: 1 };
        if (sql.startsWith("update users set display_name")) {
          return { rows: [{ ...activeUserRow("u1"), display_name: "New Name", email: "new@example.com" }], rowCount: 1 };
        }
        if (sql.includes("insert into audit_events")) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({
      method: "PATCH",
      url: "/me/profile",
      headers: sessionHeaders("u1"),
      payload: { display_name: "New Name", email: "new@example.com" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.display_name).toBe("New Name");
    expect(response.json().user.email).toBe("new@example.com");
  });

  it("rejects a taken email on profile update", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.startsWith("select id from users where email")) return { rows: [{ id: "other" }], rowCount: 1 };
        if (sql.includes("from users where id = $1")) return { rows: [activeUserRow("u1")], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({
      method: "PATCH",
      url: "/me/profile",
      headers: sessionHeaders("u1"),
      payload: { display_name: "New", email: "taken@example.com" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("email_taken");
  });

  it("lets an admin edit a user", async () => {
    const target = { id: "u2", email: "u2@example.com", display_name: "U2", role: "user", status: "active", owner_user_id: "admin-1" };
    const db = {
      query: async (sql: string) => {
        if (sql.startsWith("select id from users where email")) return { rows: [], rowCount: 0 };
        if (sql.startsWith("select id, email, display_name, role, status, owner_user_id from users")) return { rows: [target], rowCount: 1 };
        if (sql.includes("from users where id = $1")) return { rows: [activeUserRow("admin-1", "global_admin")], rowCount: 1 };
        if (sql.startsWith("update users set display_name")) {
          return { rows: [{ ...activeUserRow("u2"), display_name: "Updated", status: "disabled", role: "auditor" }], rowCount: 1 };
        }
        if (sql.includes("insert into audit_events")) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({
      method: "PATCH",
      url: "/admin/users/u2",
      headers: sessionHeaders("admin-1"),
      payload: { display_name: "Updated", email: "u2@example.com", status: "disabled", role: "auditor" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.display_name).toBe("Updated");
    expect(response.json().user.status).toBe("disabled");
    expect(response.json().user.role).toBe("auditor");
  });

  it("denies user edit to non-admins", async () => {
    const server = await buildServer({ config, db: { query: async () => ({ rows: [activeUserRow("u1")], rowCount: 1 }) } as never });
    const response = await server.inject({
      method: "PATCH",
      url: "/admin/users/u2",
      headers: sessionHeaders("u1"),
      payload: { display_name: "X" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("admin_denied");
  });

  it("denies a team admin editing a user outside their ownership subtree", async () => {
    let mutated = false;
    const db = {
      query: async (sql: string) => {
        if (sql.includes("select id, owner_user_id, email") && sql.includes("where id = $1")) {
          return { rows: [activeUserRow("team-a", "team_admin")], rowCount: 1 };
        }
        if (sql.includes("with recursive scope")) return { rows: [], rowCount: 0 };
        if (sql.startsWith("update users")) mutated = true;
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({
      method: "PATCH",
      url: "/admin/users/outside-user",
      headers: sessionHeaders("team-a"),
      payload: { display_name: "Hijacked", email: "outside@example.com" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("admin_denied");
    expect(mutated).toBe(false);
  });

  it("does not let a team admin create another admin", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from users where id = $1")) return { rows: [activeUserRow("team-a", "team_admin")], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({
      method: "POST",
      url: "/admin/users",
      headers: sessionHeaders("team-a"),
      payload: { email: "peer@example.com", display_name: "Peer", password: "long-enough-password", role: "team_admin", owner_user_id: "team-a" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("admin_denied");
  });

  it("lets an admin edit a server", async () => {
    const serverRow = { id: "s1", name: "Old", slug: "old", address: "old.example", metadata: {} };
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from users where id = $1")) return { rows: [activeUserRow("admin-1", "global_admin")], rowCount: 1 };
        if (sql.startsWith("select * from servers where id = $1")) return { rows: [serverRow], rowCount: 1 };
        if (sql.startsWith("update servers set")) return { rows: [{ ...serverRow, name: "New", address: "new.example" }], rowCount: 1 };
        if (sql.includes("insert into audit_events")) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({
      method: "PATCH",
      url: "/admin/servers/s1",
      headers: sessionHeaders("admin-1"),
      payload: { name: "New", address: "new.example" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().server.name).toBe("New");
  });
});

describe("Phase 1 catalog + effective access", () => {
  it("returns tool catalog metadata and a catalog version", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from users where id = $1")) return { rows: [activeUserRow("admin-1", "global_admin")], rowCount: 1 };
        if (sql.includes("from tool_definitions where is_enabled = true order by domain")) {
          return { rows: [{ name: "wordpress.list_pages", domain: "content", action: "read", risk: "low", executor_kind: "rest", is_write: false }], rowCount: 1 };
        }
        if (sql.includes("as version from tool_definitions")) return { rows: [{ version: "123:18" }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({ method: "GET", url: "/admin/tools", headers: sessionHeaders("admin-1") });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.catalog_version).toBe("123:18");
    expect(body.tools[0]).toMatchObject({ domain: "content", action: "read", risk: "low" });
    expect(body.domains).toContain("host_access");
    expect(body.actions).toEqual(["read", "create", "change", "remove", "operate"]);
  });

  it("explains connector availability separately from policy for effective access", async () => {
    const db = {
      query: async (sql: string) => {
        if (sql.includes("from users where id = $1")) return { rows: [activeUserRow("admin-1", "global_admin")], rowCount: 1 };
        if (sql.includes("from group_memberships")) return { rows: [], rowCount: 0 };
        if (sql.includes("from servers where id")) return { rows: [{ id: "s1", status: "active" }], rowCount: 1 };
        // policy evaluation: one allow binding for the tool
        if (sql.includes("from server_bindings sb") && sql.includes("policy_permissions pp")) {
          return { rows: [{ binding_id: "b1", subject_type: "user", subject_id: "u1", server_id: "s1", policy_id: "p1", policy_name: "custom", policy_built_in: false, permission_id: "pp1", tool_name: "wordpress.list_pages", effect: "allow", policy_constraints: {}, binding_constraints: {} }], rowCount: 1 };
        }
        // credential present for rest
        if (sql.includes("from server_credentials")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
        // capability discovery: rest reachable
        if (sql.includes("from server_capabilities")) return { rows: [{ status: "available" }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
    };
    const server = await buildServer({ config, db: db as never });
    const response = await server.inject({
      method: "GET",
      url: "/admin/policy/effective?user_id=u1&server_id=s1&tool_name=wordpress.list_pages",
      headers: sessionHeaders("admin-1")
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.final).toBe("allowed");
    expect(body.connector.required_executor).toBe("rest");
    expect(body.connector.credential_status).toBe("present");
    expect(body.tool.domain).toBe("content");
  });
});
