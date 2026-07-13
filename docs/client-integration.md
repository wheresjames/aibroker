# AIBroker Client Integration Guide

This guide explains how a developer connects an AI client such as Claude, Codex, Cursor, or a generic MCP-capable tool to AIBroker.

Client machines receive only a AIBroker API token. They must not receive WordPress credentials, SSH keys, deploy keys, WP-CLI config, hosting provider tokens, or database credentials.

## Endpoint

Native MCP endpoint (Streamable-HTTP, JSON-RPC) — this is what MCP clients connect to:

```text
http://localhost:8080/mcp
```

Transport:

- Native MCP over Streamable-HTTP (`@modelcontextprotocol/sdk`), stateless with JSON responses.
- Authorization through `Authorization: Bearer <wpb_token>` (static bearer).
- Tools are discovered by the client automatically via MCP `tools/list`.
- stdio-only clients point the `mcp-remote` bridge at this same `/mcp` endpoint.

> A dev-only `POST /mcp/call` REST shim (`{ tool, input }`) and `GET /mcp/tools` are retained
> for quick curl smoke tests and scripting. They are **not** the MCP protocol — do not point
> MCP clients at them.

## Token Creation

1. Start AIBroker.
2. Open `http://localhost:3000`.
3. Log in with a broker admin account.
4. Go to `Tokens`.
5. Select a user.
6. Create a named token with an expiration date.
7. Copy the token immediately. It is shown only once.

Default local development admin:

```text
admin@example.com
change_me_in_local_dev
```

## Generic HTTP MCP Configuration

```json
{
  "type": "http",
  "url": "http://localhost:8080/mcp",
  "headers": {
    "Authorization": "Bearer wpb_user_token"
  }
}
```

## Claude Desktop

Use the client-specific MCP configuration location for your Claude Desktop version. Configure AIBroker as a remote HTTP MCP server when supported:

```json
{
  "mcpServers": {
    "aibroker": {
      "type": "http",
      "url": "http://localhost:8080/mcp",
      "headers": {
        "Authorization": "Bearer wpb_user_token"
      }
    }
  }
}
```

If your Claude Desktop version does not support HTTP MCP reliably, use the stdio bridge fallback after it is completed.

## Codex

Use the Codex MCP configuration mechanism for your installed Codex version and point it at the broker HTTP endpoint:

```json
{
  "type": "http",
  "url": "http://localhost:8080/mcp",
  "headers": {
    "Authorization": "Bearer wpb_user_token"
  }
}
```

## Smoke Test

After creating a token and binding the token's user or group to at least one server, run
the dev-only `/mcp/call` REST shim (a quick curl check — not the MCP protocol):

```sh
curl -X POST http://localhost:8080/mcp/call \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer wpb_user_token' \
  -d '{"tool":"wordpress.list_sites","input":{"limit":50}}'
```

Expected response:

```json
{
  "result": {
    "servers": [],
    "next_cursor": null
  }
}
```

The `servers` array is empty until the token's user has a direct server binding or belongs to a group with a server binding.

## MVP Tools

- `wordpress.list_sites`
- `wordpress.get_site_summary`
- `wordpress.list_pages`
- `wordpress.get_page`
- `wordpress.create_draft_page`
- `wordpress.update_draft_page`
- `wordpress.list_posts`
- `wordpress.get_post`
- `wordpress.list_media`
- `wordpress.get_media`
- `wordpress.list_taxonomies`
- `wordpress.list_terms`
- `wordpress.list_custom_post_types`
- `wordpress.list_plugins`
- `wordpress.list_themes`
- `wordpress.get_active_theme`
- `wordpress.run_health_check`
- `wordpress.request_publish_page`
- `wordpress.apply_approved_publish`

Draft creation requires:

- A bound policy that allows `wordpress.create_draft_page`.
- A server with active REST credentials.
- An `idempotency_key` in the tool input.

Draft updates also require `expected_revision_id` so AIBroker can reject stale writes.

Diagnostic tools use a strict internal WP-CLI command allowlist. They do not expose arbitrary shell, SQL, file-write, option-update, or WP-CLI command execution.

Publish is governed by tool permissions: a client whose bound policy allows
`wordpress.publish_page` calls it directly with a `page_id` and `idempotency_key`, and
AIBroker publishes the page as long as it is still a draft.

## Common Errors

- `unauthenticated`: token missing or invalid.
- `token_expired`: token expiration has passed.
- `token_revoked`: token was revoked in AIBroker.
- `server_not_found`: requested server ID does not exist.
- `server_disabled`: server is disabled.
- `tool_denied`: tool is unavailable.
- `not_granted`: no direct user binding or group binding provides a matching materialized grant.
- `risk_ceiling`: the policy grants the domain/action, but the tool is above its risk ceiling.
- `constraint_failed`: a matching grant exists, but its constraints reject the requested input.
- `connector_unavailable`: AIBroker could not connect to the WordPress server.
- `wordpress_error`: WordPress REST API returned an error.
- `validation_error`: request shape is invalid.
- `idempotency_conflict`: the same idempotency key was reused with different input.
- `rate_limited`: token, user, server, or tool exceeded the current per-minute budget.
- `ssh_credential_missing`: diagnostic tool needs SSH credentials for the selected server.

## Token Rotation And Revocation

To rotate a token:

1. Create a replacement token.
2. Update the client configuration.
3. Run the smoke test.
4. Revoke the old token.

To revoke a token:

1. Open `Tokens`.
2. Find the token prefix.
3. Click `Revoke`.
4. Confirm future MCP requests fail with `token_revoked`.

## Stdio-only Clients

Clients that cannot speak remote HTTP MCP (e.g. some Claude Desktop versions) reach the
native `/mcp` endpoint through the standard `mcp-remote` bridge:

```json
{
  "mcpServers": {
    "aibroker": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:8080/mcp", "--header", "Authorization: Bearer wpb_user_token"]
    }
  }
}
```

The `apps/mcp-bridge` package is reserved for an optional first-party stdio↔HTTP shim if we
later need to drop the third-party dependency. Any bridge must remain a thin transport
adapter: it never receives WordPress credentials or performs WordPress operations directly.
