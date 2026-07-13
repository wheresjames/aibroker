import type pg from "pg";
import type { AIBrokerConfig } from "@aibroker/core";

// The subset of an authenticated token actor the pipeline needs. Structurally identical
// to server.ts's TokenActor, so either can be passed in.
export interface PipelineActor {
  tokenId: string;
  userId: string;
  role: string;
  status: string;
  groupIds: string[];
}

// Audit metadata a caller must supply — decoupled from FastifyRequest so any transport
// (REST /mcp/call or the native SDK /mcp endpoint) can drive the same pipeline.
export interface McpAuditContext {
  requestId: string;
  clientIp?: string;
  userAgent?: string;
}

// A tool-call failure with the broker's stable error code and HTTP status. Callers map
// it to their surface: REST → HTTP status, MCP → JSON-RPC error / isError result.
export class McpToolError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message?: string) {
    super(message ?? code);
    this.name = "McpToolError";
    this.code = code;
    this.status = status;
  }
}

export interface McpPipeline {
  run(actor: PipelineActor, tool: unknown, input: Record<string, unknown>, audit: McpAuditContext): Promise<unknown>;
}

export interface McpPipelineDeps {
  db: pg.Pool;
  config: AIBrokerConfig;
  isKnownTool: (tool: unknown) => tool is string;
  checkRateLimit: (db: pg.Pool, actor: PipelineActor, tool: string, serverPluginScope: string) => Promise<{ allowed: boolean; reason?: string }>;
  executeMcpTool: (db: pg.Pool, config: AIBrokerConfig, actor: PipelineActor, tool: string, input: Record<string, unknown>) => Promise<unknown>;
  mapToolError: (err: unknown) => { code: string; status: number; message?: string };
  captureMcpBody: (
    config: AIBrokerConfig,
    tool: string,
    input: Record<string, unknown>,
    outcome: { result: unknown } | { error: { code: string; message?: string } }
  ) => unknown;
  writeAudit: (entry: {
    audit: McpAuditContext;
    actor: PipelineActor;
    tool: string;
    input: Record<string, unknown>;
    status: "success" | "failure" | "denied";
    errorCode?: string;
    durationMs: number;
    encryptedPayload: unknown;
    result?: unknown;
  }) => Promise<void>;
}

// The one shared MCP tool-call pipeline (Fix B): validate → rate-limit → execute →
// audit (+ optional full-body capture, decision C1). Both the retained dev/smoke
// /mcp/call and the native SDK /mcp endpoint run through this, so policy evaluation,
// rate limits, auditing, and capture behave identically no matter how a client arrived.
// Authentication happens before this (the transport maps its credential → actor).
export function createMcpPipeline(deps: McpPipelineDeps): McpPipeline {
  return {
    async run(actor, tool, input, audit) {
      const started = Date.now();
      if (!deps.isKnownTool(tool)) throw new McpToolError("validation_error", 400, "Unknown tool");
      const serverPluginScope = typeof input.server_plugin_id === "string" ? input.server_plugin_id : "global";
      const rate = await deps.checkRateLimit(deps.db, actor, tool, serverPluginScope);
      if (!rate.allowed) throw new McpToolError("rate_limited", 429, rate.reason);
      try {
        const result = await deps.executeMcpTool(deps.db, deps.config, actor, tool, input);
        await deps.writeAudit({
          audit,
          actor,
          tool,
          input,
          status: "success",
          durationMs: Date.now() - started,
          encryptedPayload: deps.captureMcpBody(deps.config, tool, input, { result }),
          result
        });
        return result;
      } catch (err) {
        const mapped = deps.mapToolError(err);
        await deps.writeAudit({
          audit,
          actor,
          tool,
          input,
          status: mapped.status === 403 ? "denied" : "failure",
          errorCode: mapped.code,
          durationMs: Date.now() - started,
          encryptedPayload: deps.captureMcpBody(deps.config, tool, input, {
            error: { code: mapped.code, ...(mapped.message ? { message: mapped.message } : {}) }
          })
        });
        throw new McpToolError(mapped.code, mapped.status, mapped.message);
      }
    }
  };
}
