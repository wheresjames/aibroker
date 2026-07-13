import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpServer } from "./server.js";
import type { McpAuditContext, McpPipeline, PipelineActor } from "./pipeline.js";
import type { ToolDefinition } from "@aibroker/mcp-tools";

export interface McpTransportOptions {
  serverName: string;
  serverVersion: string;
  pipeline: McpPipeline;
  // Map the request's Authorization: Bearer token → actor (decision B3). Returns null and
  // has already sent a 401 when the token is missing/invalid.
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<PipelineActor | null>;
  auditContext: (request: FastifyRequest) => McpAuditContext;
  listTools: (actor: PipelineActor) => Promise<ToolDefinition[]>;
  readResource?: (actor: PipelineActor, uri: string) => Promise<{ mimeType: string; data: Uint8Array }>;
}

// Mount the native, SDK-backed MCP endpoint on Fastify (decision B7: in-process, no new
// service). Streamable-HTTP in stateless mode with JSON responses: each POST is a
// self-contained JSON-RPC exchange, so we build a fresh Server+transport per request bound
// to the authenticated actor. The SDK transport speaks Node req/res, so we bridge it via
// Fastify's request.raw / reply.raw and hijack the reply so the SDK owns the response.
export function registerMcpTransport(app: FastifyInstance, options: McpTransportOptions): void {
  app.post("/mcp", async (request, reply) => {
    const actor = await options.authenticate(request, reply);
    if (!actor) return; // authenticate() already sent 401

    const server = createMcpServer({
      name: options.serverName,
      version: options.serverVersion,
      pipeline: options.pipeline,
      actor,
      audit: options.auditContext(request),
      listTools: () => options.listTools(actor),
      ...(options.readResource ? { readResource: (uri: string) => options.readResource!(actor, uri) } : {})
    });
    // Omitting sessionIdGenerator selects stateless mode; enableJsonResponse returns a
    // single JSON response per POST instead of an SSE stream.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    // Fastify already parsed the JSON body; pass it through so the transport doesn't try to
    // re-read the consumed request stream.
    reply.hijack();
    await server.connect(transport as Transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // Stateless mode has no server-initiated SSE stream and no session lifecycle, so the
  // GET (stream) and DELETE (session end) verbs of the transport are not applicable.
  const methodNotAllowed = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header("Allow", "POST").send({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed: this MCP endpoint is stateless; use POST." },
      id: null
    });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
}
