import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition } from "@aibroker/mcp-tools";
import { isBrokerToolResult } from "@aibroker/plugin-sdk";
import { McpToolError, type McpAuditContext, type McpPipeline, type PipelineActor } from "./pipeline.js";

// Short human-readable descriptions shown by MCP clients in tool pickers. Falling back
// to a category-based sentence keeps every tool self-describing without a bespoke string.
const TOOL_DESCRIPTIONS: Record<string, string> = {
  "wordpress.list_sites": "List the WordPress servers this token may access.",
  "wordpress.get_site_summary": "Get a summary of a WordPress server (name, URL, capabilities).",
  "wordpress.list_pages": "List pages on a WordPress server, optionally filtered by status or search.",
  "wordpress.get_page": "Fetch a single WordPress page by id.",
  "wordpress.create_draft_page": "Create a new draft page (write tool; requires idempotency key).",
  "wordpress.update_draft_page": "Update an existing draft page (write tool; optimistic-concurrency).",
  "wordpress.publish_page": "Publish a page (write tool).",
  "wordpress.run_health_check": "Run a diagnostic health check against a server."
};

function describeTool(tool: ToolDefinition): string {
  // Prefer the catalog description that ships with the tool's metadata; fall back to the
  // curated picker string, then a category sentence.
  return tool.description ?? TOOL_DESCRIPTIONS[tool.name] ?? `${tool.category} tool (${tool.name}).`;
}

// Build a per-request MCP Server bound to one authenticated actor. tools/list is served
// from the stored JSON schemas (MVP_TOOL_DEFINITIONS); tools/call routes through the
// shared pipeline (policy + rate-limit + execute + audit). We create a fresh Server per
// request so the actor + audit context are captured without any shared session state
// (stateless, static-bearer auth — decision B3).
export function createMcpServer(opts: {
  name: string;
  version: string;
  pipeline: McpPipeline;
  actor: PipelineActor;
  audit: McpAuditContext;
  listTools: () => Promise<ToolDefinition[]>;
  readResource?: (uri: string) => Promise<{ mimeType: string; data: Uint8Array }>;
}): Server {
  const server = new Server({ name: opts.name, version: opts.version }, { capabilities: { tools: {}, resources: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await opts.listTools()).map((tool) => ({
      name: tool.name,
      description: describeTool(tool),
      inputSchema: tool.inputSchema as { type: "object" },
      outputSchema: tool.outputSchema as { type: "object" }
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await opts.pipeline.run(opts.actor, name, args, opts.audit);
      if (isBrokerToolResult(result)) {
        return {
          content: (result.content ?? [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }]).map((item) =>
            item.type === "image"
              ? { type: "image" as const, data: item.data ?? "", mimeType: item.mimeType ?? "application/octet-stream" }
              : { type: "text" as const, text: item.text ?? "" }),
          structuredContent: result.structuredContent
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        ...(result && typeof result === "object" ? { structuredContent: result as Record<string, unknown> } : {})
      };
    } catch (err) {
      if (err instanceof McpToolError) {
        // An unknown/invalid tool name is a protocol-level client error.
        if (err.code === "validation_error") {
          throw new McpError(ErrorCode.InvalidParams, err.message ?? "Invalid tool or arguments");
        }
        // Policy denials, rate limits, and tool execution failures are returned in-band as
        // an error result so the model sees the reason and can recover.
        return {
          content: [{ type: "text" as const, text: err.message ? `${err.code}: ${err.message}` : err.code }],
          isError: true
        };
      }
      throw err;
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (!opts.readResource) throw new McpError(ErrorCode.InvalidRequest, "Resources are unavailable");
    try {
      const value = await opts.readResource(request.params.uri);
      return { contents: [{ uri: request.params.uri, mimeType: value.mimeType, blob: Buffer.from(value.data).toString("base64") }] };
    } catch (error) {
      throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : "artifact_not_found");
    }
  });

  return server;
}
