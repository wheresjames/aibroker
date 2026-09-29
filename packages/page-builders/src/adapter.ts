import type { WordPressRestClient, WordPressSessionClient } from "@aibroker/wordpress-rest";

// Page-builder adapter contract (AB-ELEMENTOR layer 3). An adapter owns detection and
// the typed tool handlers for one builder; the API supplies the clients, the caller's
// optional WordPress session, snapshot storage and idempotency. Adding a builder means
// adding an adapter plus its tool definitions in @aibroker/mcp-tools — the transport
// layers (REST client, session client) do not change.

export interface SnapshotRecord {
  id: string;
  content_hash: string;
  byte_size: number;
  tool_name: string;
  actor_user_id: string | null;
  created_at: string;
}

export interface SnapshotStore {
  save(entry: { builder: string; postId: number; toolName: string; hash: string; data: string }): Promise<string>;
  list(builder: string, postId: number, limit: number): Promise<SnapshotRecord[]>;
  get(builder: string, postId: number, id: string): Promise<(SnapshotRecord & { data: string }) | null>;
}

export interface PageBuilderToolCtx {
  toolName: string;
  input: Record<string, unknown>;
  rest: WordPressRestClient;
  // The calling user's own WordPress login session, or null when they have not
  // connected one. Loaded lazily: most REST-path calls never need it.
  session(): Promise<WordPressSessionClient | null>;
  snapshots: SnapshotStore;
  pluginConfig: Record<string, unknown>;
  idempotent<T>(action: () => Promise<T>): Promise<T>;
  toolError(code: string, status?: number, message?: string): Error & { code: string; status: number };
}

export type PageBuilderToolHandler = (ctx: PageBuilderToolCtx) => Promise<unknown>;

export interface BuilderDetection {
  builder: string;
  active: boolean;
  version: string | null;
  details: Record<string, unknown>;
}

export interface PageBuilderAdapter {
  key: string;
  label: string;
  detect(rest: WordPressRestClient): Promise<BuilderDetection>;
  handlers: Record<string, PageBuilderToolHandler>;
}
