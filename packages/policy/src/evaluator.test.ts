import { describe, expect, it } from "vitest";
import { evaluatePolicy, type PolicyQueryHandle } from "./evaluator.js";

const base = {
  userId: "00000000-0000-0000-0000-000000000001",
  role: "user" as const,
  groupIds: ["00000000-0000-0000-0000-000000000002"],
  server: { id: "00000000-0000-0000-0000-000000000003", status: "active" },
  toolName: "wordpress.list_pages",
  isWrite: false,
  input: {},
};

function db(rows: Record<string, unknown>[]): PolicyQueryHandle {
  return {
    async query<T = Record<string, unknown>>() {
      return { rows: rows as T[] };
    }
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    binding_id: "00000000-0000-0000-0000-000000000010",
    subject_type: "group",
    subject_id: "00000000-0000-0000-0000-000000000002",
    server_id: base.server.id,
    policy_id: "00000000-0000-0000-0000-000000000011",
    policy_name: "read-only",
    policy_built_in: true,
    permission_id: "00000000-0000-0000-0000-000000000012",
    tool_name: "wordpress.list_pages",
    effect: "allow",
    policy_constraints: {},
    binding_constraints: {},
    ...overrides
  };
}

describe("evaluatePolicy", () => {
  it("allows matching group bindings", async () => {
    await expect(evaluatePolicy(db([row()]), base)).resolves.toMatchObject({
      allowed: true,
      reason: "policy_allow",
      matchedBindings: [{ policyName: "read-only" }]
    });
  });

  it("lets explicit deny win over allows", async () => {
    const decision = await evaluatePolicy(db([row(), row({ effect: "deny", subject_type: "user", subject_id: base.userId })]), base);
    expect(decision).toMatchObject({ allowed: false, reason: "explicit_deny" });
  });

  it("unions direct user and group bindings", async () => {
    const decision = await evaluatePolicy(
      db([
        row({ subject_type: "group", subject_id: base.groupIds[0], policy_name: "read-only" }),
        row({ subject_type: "user", subject_id: base.userId, policy_name: "direct-extra" })
      ]),
      base
    );
    expect(decision.allowed).toBe(true);
    expect(decision.matchedBindings.map((binding) => binding.policyName)).toEqual(["read-only", "direct-extra"]);
  });

  it("defaults to deny", async () => {
    await expect(evaluatePolicy(db([]), base)).resolves.toMatchObject({ allowed: false, reason: "not_granted" });
  });

  it("allows writes solely from an explicit matching permission", async () => {
    await expect(evaluatePolicy(db([row({ tool_name: "wordpress.update_draft_page" })]), {
      ...base,
      toolName: "wordpress.update_draft_page",
      isWrite: true
    })).resolves.toMatchObject({ allowed: true, reason: "policy_allow" });
  });

  it("does not let global admins bypass explicit permissions", async () => {
    await expect(evaluatePolicy(db([]), { ...base, role: "global_admin" })).resolves.toMatchObject({
      allowed: false,
      reason: "not_granted"
    });
  });

  it("blocks allows when merged constraints reject input", async () => {
    const decision = await evaluatePolicy(
      db([row({ policy_constraints: { maxResults: 10 }, binding_constraints: { maxResults: 5 } })]),
      { ...base, input: { limit: 6 } }
    );
    expect(decision).toMatchObject({ allowed: false, reason: "constraint_failed" });
    expect(decision.matchedBindings[0]?.effectiveConstraints).toEqual({ maxResults: 5 });
  });

  it("does not let binding constraints deny tools they do not apply to", async () => {
    const decision = await evaluatePolicy(
      db([row({ tool_name: "wordpress.get_page", policy_constraints: {}, binding_constraints: { maxResults: 5 } })]),
      { ...base, toolName: "wordpress.get_page" }
    );
    expect(decision).toMatchObject({ allowed: true, reason: "policy_allow", effectiveConstraints: {} });
  });

  it("rejects a materialized allow when tool risk rises above its ceiling", async () => {
    const decision = await evaluatePolicy(
      db([row({ risk_ceiling: "medium", tool_risk: "high" })]),
      { ...base, toolRisk: "high" }
    );
    expect(decision).toMatchObject({ allowed: false, reason: "risk_ceiling" });
  });
});
