# AIBroker

> A plugin-based server-management broker for AI tools. One token per client, one
> policy per server, every call audited.

AI coding tools (Claude Code, Codex, and any MCP-compatible client) talk to AIBroker
through a single HTTP MCP endpoint. AIBroker checks **who** is asking, **which server
plugin instance** they are targeting, and **which tools** the bound policy allows. The
built-in WordPress plugin then runs the action with credentials that never leave the
broker. Clients never see WordPress passwords, SSH keys, or WP-CLI config.

This keeps access centralized, revocable, and auditable: rotate a token, change a
policy, or unbind a server and every affected client's behavior changes in one place.

---

## Table of contents

- [What AIBroker does](#what-aibroker-does)
- [How it fits together](#how-it-fits-together)
- [Quick start](#quick-start)
- [The access model in one minute](#the-access-model-in-one-minute)
- [Roles](#roles)
- [The admin UI](#the-admin-ui)
- [The MCP tool surface](#the-mcp-tool-surface)
- [Connecting an AI client](#connecting-an-ai-client)
- [Throwaway WordPress test servers](#throwaway-wordpress-test-servers)
- [Day-to-day `dev.sh` commands](#day-to-day-devsh-commands)
- [Testing](#testing)
- [Configuration](#configuration)
- [Production operations](#production-operations)
- [Project layout](#project-layout)
- [Further reading](#further-reading)

---

## What AIBroker does

- **One token per client.** Each AI client (or script) holds a single AIBroker token.
  WordPress application passwords, SSH keys, and WP-CLI paths live in the broker and
  are never shipped to the client machine.
- **Plugin-based servers.** A server stores only its name and address. Independently
  configured plugin instances contribute tools, credentials, and discovered capabilities.
- **Policy-based access.** A *policy* lists which MCP tools are allowed or denied (with
  optional constraints). A *binding* attaches a policy to a (group or user) × server pair.
  A *group* collects users. The broker evaluates every call against the matching
  binding's policy.
- **Safe tool exposure.** WordPress, typed PostgreSQL, confined SSH, and isolated Playwright
  browser tools are exposed over a streamable-HTTP MCP endpoint. SSH onboarding uses a one-time
  sudo-capable credential to provision a dedicated account; only its generated confined key is
  retained. Browser calls run in a private Chromium sidecar restricted to exact configured origins.
- **Visible break glass.** Raw `ssh.run_command` is critical, Full-only, justification-required,
  fully captured, and emits a distinct `break_glass_used` audit event. PostgreSQL follows the
  same pattern: typed reads are the default while `postgres.run_sql` is Full-only and queued.
- **Full audit trail.** Every login, token use, policy/group/binding change, and tool
  call is recorded with actor, server, tool, status, and a before/after diff where
  relevant.
- **Self-service for everyone.** Regular users manage their own tokens, set up their
  clients from a guided page, and see their own activity — no admin needed for the
  basics.

---

## How it fits together

```
                 ┌─────────────┐   MCP (HTTP, Bearer token)
  AI client ───▶ │  AIBroker   │ ──── POST /mcp ────▶ policy check ──▶ tool run
  (Claude Code,  │   API       │                       │
   Codex, …)     │  :8080      │                       ├─▶ WordPress REST  (app password)
                 └─────────────┘                       ├─▶ WP-CLI / confined shell over SSH
                        │                                └─▶ PostgreSQL scoped role
                        │
              ┌─────────┴─────────┐
              ▼                   ▼
        PostgreSQL :5432      Redis :6379
        (policies, groups,     (rate limits,
         bindings, audit)       job queue)
              ▲
              │  admin / self-service
        ┌─────┴──────┐
        │  Web UI    │  React + Vite, :3000
        │  :3000     │  proxies /admin /me /auth /health to the API
        └────────────┘
```

**Request flow for a tool call:**

1. The client connects to the native MCP endpoint (`POST /mcp`, Streamable-HTTP) with
   `Authorization: Bearer <aibroker-token>` and issues `tools/call`. (A dev-only
   `POST /mcp/call` REST shim accepting `{ tool, input }` is retained for smoke tests.)
2. The API resolves the token to its owner, records `last_used_at`, and enforces rate
   limits (Redis).
3. The **policy evaluator** finds the matching binding for `(user-or-group, server)` and
   applies the policy: deny-wins, union across groups, constraint narrowing, and global
   hard stops (write-tools / production-writes / server-disabled).
4. If allowed, the tool executor runs against the server (WordPress REST, WP-CLI-over-SSH,
   PostgreSQL, or the isolated Playwright worker), using credentials stored encrypted in PostgreSQL.
5. The call and its outcome are written to the audit log, win or lose.

Provisioned SSH and PostgreSQL plugins use a bootstrap-once pattern. An elevated key or
admin connection string exists in memory only long enough to create or rotate a confined
identity; AIBroker encrypts only that scoped identity for later calls.

The **Web UI** is just a browser over those same endpoints — admins manage users,
groups, servers, and policies; everyone manages their own tokens, settings, and client
setup. The UI calls `/admin/*` (admins), `/me/*` (self-service, any role), and
`/auth/*` (login / change password).

---

## Quick start

You need **Docker** and (for non-Linux hosts) **corepack/pnpm** available for the
dependency-install step. The whole stack runs in Docker Compose.

```sh
# 1. Configure environment
cp .env.example .env
#   then edit .env: set AIBROKER_SESSION_SECRET to a long random string, and
#   AIBROKER_ENCRYPTION_KEY_BASE64 to: openssl rand -base64 32

# 2. (one time) install local dependencies so typecheck/tests work on the host
./dev.sh deps-install        # or: corepack pnpm install

# 3. Bring up the full dev stack (API + Web + worker + Postgres + Redis + WordPress)
./dev.sh run
```

Once it's up:

- **Web UI:** http://localhost:3000
- **API health:** `http://localhost:8080/health/live` (liveness) and
  `http://localhost:8080/health/ready` (readiness — checks DB + Redis)
- **WordPress (the bundled demo server):** http://localhost:8081

On startup, the API applies the schema and synchronizes the code-defined plugin, tool, and
built-in policy catalog automatically. The commands remain available for explicit maintenance:

```sh
./dev.sh migrate             # explicitly run database migrations
./dev.sh seed                # explicitly resynchronize tools, plugins, policies, and local admin
```

The seeded local admin comes from `AIBROKER_BOOTSTRAP_ADMIN_EMAIL` /
`AIBROKER_BOOTSTRAP_ADMIN_PASSWORD` in `.env` (defaults to `admin@example.com` /
`change_me_in_local_dev`). The API prints these configured credentials only while the
bootstrap password still requires rotation. On first login you'll be prompted to change the
password; subsequent starts do not echo the credentials.

> Tip: To try the full end-to-end flow against a *real* throwaway WordPress server, start
> the stack with a test server instead: `./dev.sh run --wptest server1`. See
> [Throwaway WordPress test servers](#throwaway-wordpress-test-servers).

---

## The access model in one minute

Three concepts, composed:

- **Policy** — a named plugin-relative access intent. The common path is one persona dropdown
  per plugin: **None / Read / Contribute / Manage / Full**. Advanced mode exposes the domain ×
  action grid, risk ceiling, explicit tool denies, and per-instance overrides. Saving
  materializes the intent to explicit tool rows for fast enforcement. New low/medium-risk
  tools can join matching intents automatically; high/critical tools wait in the review queue.
- **Group** — a collection of users. Most access is granted *to a group*.
- **Binding** — attaches one policy to a `(subject, server)` pair, where the subject is a
  group or a single user. This is the thing that actually grants access.

To give a user access to a server:

1. Create or pick a **policy** (Policies tab → choose a persona level per plugin).
2. Create or pick a **group** (Groups tab) and add the user to it (Members sub-tab).
3. Bind the group to the **server** and choose the policy for that server (Servers sub-tab).
4. (Optional) Use the **Effective access** view to see exactly which binding/policy
   allows or denies a given tool.

Direct user-to-server bindings exist for exceptions, but groups are the norm.

---

## Roles

| Role          | What they can do |
|---------------|------------------|
| `global_admin` | Everything: manage all users/groups/servers/policies/tokens, view audit logs. |
| `team_admin`  | Manage users/groups/servers within their ownership subtree; consume (not edit) policies. |
| `auditor`     | Self-service only (like `user`); intended for read/review. |
| `user`        | Self-service: their own tokens, settings, client setup, and personal dashboard. |

Regular users (`user`, `auditor`) see only **Dashboard**, **Tokens**, **Host Access**,
**Client Setup**, and **Settings** in the sidebar — the admin areas are hidden because the
backing API would deny them anyway. Nav visibility mirrors API permissions, so a tab is never
shown to a role that can't use it. (Host Access is self-service but still policy-gated: it only
lets a user act on servers their own bindings already allow.)

---

## The admin UI

The Web UI is a single-page app served on `:3000` that proxies `/admin`, `/me`, and
`/auth` to the API. A left sidebar lists the workspace areas; **nav visibility mirrors what
the API enforces**, so a role never sees a tab it would only be denied. Every page carries a
top bar with the page title, the signed-in identity and role, and a live **API ok/…** status
pill; the sidebar footer holds the light/dark theme selector and **Sign out**.

The screenshots below are from a freshly seeded local stack in dark theme (the UI ships both
light and dark, switchable from the sidebar).

### Sign in

![AIBroker sign-in screen](docs/images/ui/01-login.png)

**What it does:** authenticates a user and starts a browser session (stored client-side and
sent as a header on every API call).

**On the page:**
- **Username** and **Password** fields and a **Log in** button; a failed attempt shows an
  inline error, never revealing whether it was the email or the password.
- A **theme selector** (Auto / Light / Dark) in the top corner, available before login.
- On first launch the bootstrap admin is redirected to a **Change password** screen — current
  password, new password with a live **strength meter**, and confirm — before the workspace
  unlocks (see [Quick start](#quick-start)).

### Dashboard

![Dashboard with summary tiles, personal activity, and recent events](docs/images/ui/02-dashboard.png)

**What it does:** an at-a-glance landing page — workspace health for admins, personal activity
for everyone.

**On the page:**
- **Summary tiles** (admins only): **Servers** (registered), **Users** (broker accounts),
  **Tokens** (active API tokens), **Audit** (recorded events).
- **Your activity** (all roles): **Last login**, **Active tokens** (your unrevoked tokens),
  and **API calls (7d)** (your MCP tool calls this week).
- **Recent activity**: a feed of the latest audited events — timestamp, event type, and a
  success/failure status chip. Regular users and auditors see only the personal panels.

### Users

![Users list](docs/images/ui/03-users.png)

**What it does:** manage broker accounts, roles, and the ownership hierarchy (admins only).

**On the page:**
- Header count and **+ Add user** (a modal for email, display name, initial password, role,
  and owner).
- Table columns: **User** (display name, email, owner path), **Owner** (an inline dropdown to
  reassign ownership), **Status** chip, **Role**, **Children** (how many accounts this user
  owns), and **Actions** — **Move** and **Disable**.
- Clicking a user opens a **detail page** (back arrow to return) with **Overview / Bindings /
  Effective access** tabs and an **Edit** button on the header. Team admins only see accounts
  within their ownership subtree.

### Groups

![Groups list](docs/images/ui/04-groups.png)

**What it does:** groups collect users and are the normal unit that access is granted to
(admins only).

**On the page:**
- **+ Add group** (name and description).
- List columns: **name**, **owner**, **member count**, **server count**, and **description**.
- The detail page has three sub-tabs: **Members** (add/remove users), **Servers** (the group's
  bindings — each row pairs a server with the policy it grants, so this is where you bind a
  policy to a group × server), and **Effective access** (the resolved allow/deny result).

### Servers

![Servers list](docs/images/ui/05-servers.png)

**What it does:** register the targets AIBroker acts on. A server row stores only a **name** and
**address**; tools, credentials, and capabilities all come from the plugin instances attached to
it.

**On the page:**
- **+ Add server** (name and address only).
- List columns: **name** (links to the detail page), **address**, **status** chip, **plugins**
  (count of enabled instances), and **Actions** (**Disable**).
- The detail page has **Overview / Plugins / Capabilities / Audit** tabs. **Capabilities**
  lists what each plugin discovered (plugin, capability, status, executor kind, discovered-at)
  with a **Discover capabilities** button; **Audit** is the server-scoped event slice.

**Plugins tab** — add and manage WordPress, SSH, PostgreSQL, and Playwright instances:

![Server detail, Plugins tab](docs/images/ui/06-server-plugins.png)

- **+ Add plugin** opens the catalog picker and a **schema-driven config form** (labelled
  strings, URLs, numbers, enums, booleans, and string lists — not raw key/value text).
- Columns: **type**, **instance**, **status** chip (or provisioning status), **last probe**,
  and a non-wrapping **Actions** group. Available actions depend on the plugin type: **Edit**;
  **Add/Replace credential** (WordPress, Playwright); **Provision / Rotate** and **De-provision**
  (SSH, PostgreSQL); **Test connection**; **Disable**; and **Remove** (which requires a reason
  and a typed confirmation, and is a retained/soft delete so audit history survives).
- Playwright is a **singleton** per server, and its instance name is a **drill-down link** (the
  `Browser ›` affordance) into a dedicated detail page.

![Playwright browser plugin drill-down](docs/images/ui/07-browser-detail.png)

The browser detail page keeps browser administration out of the plugin list. Its header carries
the instance name, a status chip, and an auth-state chip, with three tabs:
- **Overview** — summary rows for **Base URL**, **Allowed origins**, **Viewport**, **Artifact
  retention**, **Authentication state**, and **Last probe**.
- **Sessions** — a table of short-lived token-owned browser contexts (status, current URL,
  actor, token prefix, last activity, idle-expiry) with an admin **Close** action that requires
  a reason.
- **Artifacts** — a table of expiring screenshots (type, MIME, byte size, abbreviated SHA-256,
  actor, status, created, expires). Only metadata is shown; screenshot **bytes are never
  displayed or exported here**.

### Policies

![Policies list with built-in policies](docs/images/ui/08-policies.png)

**What it does:** a policy is a named, plugin-relative access intent that gets materialized into
explicit allow/deny tool rows (admins only).

**On the page:**
- **+ Add policy**, plus list columns: **name**, **description**, **permission count** (how many
  tool rows it materializes to), **binding count** (how many bindings use it), a **built-in**
  marker, and **Actions** — **View**, **Clone**, **Delete** (built-ins can be viewed and cloned
  but not deleted).
- The editor uses a **persona ladder** per plugin — **None / Read / Contribute / Manage /
  Full** — by default. **Advanced** mode exposes the **domain × action grid**, a **risk
  ceiling**, explicit **tool denies**, and **per-instance overrides**.
- A **Test policy** panel previews the effective result: pick a **user** and a **server** and it
  returns a table of instance, tool, **allowed/denied**, and the deciding **reason**.

### Tokens

![Tokens page](docs/images/ui/09-tokens.png)

**What it does:** create and revoke API tokens — your own (all roles), or anyone's (admins).

**On the page:**
- **+ Add token** opens a modal for a **token name** and an **expiration** (date/time); the
  admin variant also picks the **owning user**.
- The full secret is shown **once** at creation — it's stored hashed and can never be retrieved
  again, so copy it then.
- List columns: **name**, **token prefix**, **last used**, **expires**, **revoked**, and
  **Actions** (**Revoke**); the admin view adds an **email** column. Revocation is irreversible
  and tokens are never hard-deleted, because the audit trail ties every tool call back to a token.

### Host Access

![Host Access self-service SSH](docs/images/ui/10-host-access.png)

**What it does:** self-service SSH — start an authorized host session and track durable typed
host operations (all roles, still policy-gated).

**On the page:**
- **Start an authorized session** panel: a **server** dropdown (only servers your bindings
  allow), a **mode** dropdown (**Read-only shell / Constrained shell / Full Shell / Root
  Access**), an optional **Reason**, and a **Start session** button.
- **Operations** table: tool, status, started, finished, and an inline **Cancel** for queued or
  running operations.
- **Sessions** table: mode, host (`user@host`), status, started, and an inline **End** for
  active sessions. The page auto-refreshes.

### Operations

![Operations and recovery dashboard](docs/images/ui/11-operations.png)

**What it does:** an admin-only, read-only correlation of recovery and infrastructure activity —
one place to answer "what ran, did it finish, and is there a backup to fall back to?"

**On the page** — six stacked tables:
- **Recent operations** (server, tool, status, progress, error code, created).
- **Backup inventory** (server, kind, status, size, verified-at, retention-until, created).
- **Restore history** (server, status, backup id, rollback backup id, created, finished).
- **Deployments** (server, environment, status, provider reference, created, finished).
- **Provider health** (server, adapter, base URL, API version, status, last discovered).
- **Multisite networks** (name, domain, base path, status, server count).

### Audit Logs

![Audit Logs](docs/images/ui/12-audit.png)

**What it does:** the full, immutable audit trail — every login, token use, policy/group/binding
change, and tool call (admins only).

**On the page:**
- Columns: **created at**, **event type**, **status** chip, **tool name**, **error code**, and
  **input summary** — a redacted JSON blob (secrets stripped) rendered in a fixed-height box
  with a **Show more / Show less** toggle so one large event can't scroll-bomb the list.

> **Sandbox** (development only, not shown) appears when `AIBROKER_SANDBOX_ENABLED` is set. It
> creates disposable PostgreSQL targets or exposes the bundled WordPress test target, with
> copyable connection details and a one-click register shortcut; teardown destroys the target
> but retains its audit record. **MCP** (admins, not shown here because MCP is disabled in this
> capture) is a live monitor of MCP tool traffic — a session table (session, state, started,
> duration, call count, error rate, servers), a filterable per-call traffic table, and NDJSON/CSV
> export. Each call can be expanded to reveal the encrypted request/response body, but only when
> `AIBROKER_MCP_CAPTURE_BODIES` is on; otherwise the monitor shows metadata only.

### Client Setup

![Client Setup guided integration](docs/images/ui/13-client-setup.png)

**What it does:** generates copy-paste-ready MCP configuration for each supported client
(all roles).

**On the page:**
- Inputs at the top: **Broker URL**, **MCP server name** (arbitrary, local to your client), and
  an AIBroker **token selector** with an "or paste your token" fallback.
- Sub-tabs — **Overview**, **Claude Code**, **Claude Desktop**, **Cursor**, **VS Code**,
  **Codex**, **Other** — each render config with your URL, token, and server name already
  interpolated, plus **Copy** buttons and a shared **HTTP MCP endpoint** block. See
  [Connecting an AI client](#connecting-an-ai-client).

### Settings

![Settings](docs/images/ui/14-settings.png)

**What it does:** manage your own profile and (for admins) one workspace-wide default.

**On the page:**
- **Profile**: change your **display name** and **email**.
- **Change password**: current password, new password with a strength meter, and confirm.
- **Default MCP server name** (global admins only): the value new clients see pre-filled on the
  Client Setup page; each client can still override it locally.

---

## The MCP tool surface

Every client sees the same registry catalog over the `/mcp` endpoint; the policy on the
matching binding decides which tools the caller may actually run. Built-in plugin surfaces include:

- **Read** — `wordpress.list_sites`, `wordpress.get_site_summary`, `wordpress.list_pages`, `wordpress.get_page`
- **Write** — `wordpress.create_draft_page`, `wordpress.update_draft_page`, `wordpress.publish_page`
- **Diagnostic** — `wordpress.run_health_check`
- **PostgreSQL typed reads** — `postgres.list_tables`, `postgres.read_rows`, `postgres.run_named_query`
- **PostgreSQL break glass** — `postgres.run_sql` (Full/critical, reason and idempotency key required)
- **SSH** — confined file/session tools plus Full-only `ssh.run_command`
- **Browser inspection** — `playwright.capture_screenshot`, `playwright.get_page_metadata`,
  `playwright.get_page_snapshot` (low-risk reads) and `playwright.get_console_messages`,
  `playwright.get_page_errors` (medium-risk reads). Screenshots return native MCP image content plus
  a protected, expiring artifact reference; bytes never enter structured JSON or audit rows.
- **Browser sessions** — `playwright.open_session`, `playwright.navigate`, `playwright.list_sessions`,
  `playwright.close_session` open one short-lived, token-owned context (five-minute idle,
  fifteen-minute absolute lifetime).
- **Browser interactions** — strict semantic-locator tools `playwright.fill`, `playwright.select_option`,
  `playwright.press_key`, `playwright.wait_for`, and the write-classified `playwright.click`
  (idempotency key required). Values are redacted from audit and events; no arbitrary
  selectors, JavaScript, raw HTML, or navigation outside the configured origins.

Writes are governed only by explicit policy permissions on the matching server binding.
The seeded built-in policies (`read-only`, `editor`, `publisher`, `auditor`, `denied`) are
pre-wired to these categories: `read-only` allows the read tools, `editor` adds draft
create/update, `publisher` adds publish, and `auditor` allows read + diagnostic. Make
your own policy in the Policies editor by checking tools on or off.

---

## Connecting an AI client

From the **Client Setup** tab, enter your broker URL and choose a AIBroker token from the
selector (or paste one — create tokens on the **Tokens** tab). Then follow the sub-tab
for your client — each shows copy-paste-ready config that interpolates your URL, token,
and server name:

- **Claude Code** — `claude mcp add --transport http …` or a `.mcp.json` snippet.
- **Claude Desktop** — its config is stdio-only, so it uses the `mcp-remote` bridge.
- **Cursor** — a `~/.cursor/mcp.json` (or project `.cursor/mcp.json`) entry.
- **VS Code** — a `.vscode/mcp.json` entry for Copilot agent mode.
- **Codex** — a `~/.codex/config.toml` entry (token read from an env var).
- **Other** — the generic streamable-HTTP config + a curl smoke test.

The **MCP server name** (default `aibroker`, set org-wide by a global admin in Settings)
is how your client refers to this connection. It's arbitrary and lives only in your
client config — override it on the Client Setup page if you connect to more than one
AIBroker instance so their tools don't collide (e.g. `aibroker-staging`, `aibroker-prod`).

The endpoint every client uses is the native MCP surface at `http://<broker>/mcp`
(Streamable-HTTP, JSON-RPC) with `Authorization: Bearer <token>`. A dev-only
`POST /mcp/call` REST shim (`{ "tool": "...", "input": {...} }`) is kept for quick curl
smoke tests and is **not** the MCP protocol.

See [`docs/client-integration.md`](docs/client-integration.md) for the full details,
expected error codes, and token rotation.

---

## Throwaway WordPress test servers

`./dev.sh run --wptest <name>` brings up the full stack *and* a throwaway WordPress server
running alongside it, so you can exercise the real flow: register the server, bind a
policy, and call `wordpress.list_pages` / `wordpress.create_draft_page` to see allow/deny in action.

```sh
./dev.sh run --wptest server1          # start stack + a test server named "server1"
./dev.sh wptest-list                   # show test servers
./dev.sh wptest-stop server1           # stop it (keep data)
./dev.sh wptest-rm server1             # delete it and its data
```

Access details for the test server (admin login, REST application password, registration
and WordPress plugin settings, including `wordpress_path`) are written to
`data/wptest/<name>/config.txt` and printed at the end of the run.
Re-running reuses an existing server; use `wptest-rm` for a clean slate.

---

## Day-to-day `dev.sh` commands

`dev.sh` is the main developer entrypoint. The most-used commands:

| Command | What it does |
|---------|--------------|
| `./dev.sh run` | Build and run the full stack in the foreground (Ctrl+C stops it). |
| `./dev.sh run --wptest NAME` | Same, plus a throwaway WordPress test server. |
| `./dev.sh migrate` | Run DB migrations (in the API container). |
| `./dev.sh seed` | Seed tool definitions, built-in policies, and the local admin. |
| `./dev.sh test` | Typecheck + tests across all packages. |
| `./dev.sh down` | Stop all AIBroker Docker services. |
| `./dev.sh logs` | Follow service logs. |
| `./dev.sh backup` | Local PostgreSQL backup via `AIBROKER_DATABASE_URL`. |

Run `./dev.sh help` for the full list (build, run-image, k3s-smoke, wptest-* management,
deps-status/deps-install, etc.).

Local app data lives under `./data`. To fully reset the local app: stop the stack and
delete `./data` — databases and the bootstrap admin are recreated on the next
`./dev.sh run` (then re-run `./dev.sh migrate && ./dev.sh seed`).

---

## Testing

```sh
./dev.sh test              # everything (typecheck + all package tests)
# or target a layer:
corepack pnpm --filter @aibroker/api test
corepack pnpm --filter @aibroker/web test
corepack pnpm --filter './packages/**' test
```

Tests are Vitest. The API tests use a mock DB harness for unit-level checks of routes
and governance; the DB package has migration tests against a real temp Postgres.

---

## Configuration

All runtime config comes from environment variables (see `.env.example`):

- **Required:** `AIBROKER_DATABASE_URL`, `AIBROKER_REDIS_URL`,
  `AIBROKER_SESSION_SECRET` (≥32 chars), `AIBROKER_ENCRYPTION_KEY_BASE64`
  (`openssl rand -base64 32`).
- **Feature flags (all default off):**
  - `AIBROKER_MCP_ENABLED` — advertises whether MCP is enabled to the UI/clients (it's
    surfaced through the `/me` payload). The routes themselves stay registered.
  - `AIBROKER_ALLOW_PRIVATE_CONNECTOR_TARGETS` — let connectors (REST/SSH) reach private
    IPs; off by default to prevent SSRF toward internal networks.
  - `AIBROKER_MCP_CAPTURE_BODIES` — opt in to full-fidelity capture: the tool-call path
    encrypts the request input + result/error into `audit_events.encrypted_payload`
    (secrets still redacted) so the admin **MCP** monitor can reveal and export full
    bodies. Off by default — with it off, only metadata is recorded.
- **Bootstrap admin:** `AIBROKER_BOOTSTRAP_ADMIN_EMAIL` /
  `AIBROKER_BOOTSTRAP_ADMIN_PASSWORD` / `AIBROKER_BOOTSTRAP_ADMIN_NAME`.
- **Playwright browser worker:** `AIBROKER_BROWSER_WORKER_URL` and the shared
  `AIBROKER_BROWSER_WORKER_SECRET`. Browser access remains exact-origin scoped; local/private
  browser targets additionally require `AIBROKER_BROWSER_ALLOW_PRIVATE_TARGETS=true` and a
  server marked `local` or `throwaway`. `AIBROKER_BROWSER_MAX_CONCURRENT` bounds simultaneous
  operations and `AIBROKER_BROWSER_MAX_SESSIONS` bounds live in-memory contexts. Sessions have
  fixed five-minute idle and fifteen-minute absolute lifetimes.
- **Browser artifacts:** local development uses `AIBROKER_ARTIFACT_BACKEND=filesystem` and
  `AIBROKER_ARTIFACT_FILESYSTEM_ROOT`. Production uses the S3-compatible endpoint, region,
  bucket, access-key, and secret-key variables listed in `.env.example`. Screenshot bytes are
  not stored in PostgreSQL or MCP audit bodies.

> ⚠️ **Rebuild note:** the dev Docker images bake the source in at build time (there's
> no live source volume mount), so after editing app code you need to rebuild for the
> running containers to pick it up: stop the stack and re-run `./dev.sh run` (which does
> `docker compose up --build`).

---

## Production operations

- **Kubernetes:** `deploy/k8s/` manifests and `deploy/helm/` chart scaffold.
- **Alerts:** `deploy/alerts/prometheus-rules.yaml`.
- **Backup / restore:** `scripts/backup-postgres.sh`, `scripts/restore-postgres.sh`,
  `scripts/backup-drill.sh`.
- **Runbooks:** [`docs/production-runbook.md`](docs/production-runbook.md),
  [`docs/security-operations.md`](docs/security-operations.md).
- **Smoke a k3s deployment:** `./dev.sh k3s-smoke`.

---

## Project layout

```
apps/
  api/        Fastify API: auth, admin + self-service routes, native MCP /mcp (+ dev /mcp/call), audit
  web/        React + Vite admin/self-service UI
  worker/     BullMQ worker for durable SSH and database operations
  browser-worker/ isolated Playwright/Chromium one-shot and leased-session runtime
  mcp-bridge/ stdio MCP bridge for clients without reliable HTTP (planned)
packages/
  core/       config, shared types, constraint registry
  policy/     the policy evaluator (deny-wins, union, constraints, hard stops)
  mcp-tools/  MCP tool definitions + executors (wp_* read/write/diagnostic)
  wordpress-rest/  WordPress REST client (application passwords)
  wpcli-ssh/  WP-CLI over SSH client
  audit/      audit event writer
  auth/       password hashing/verification, API token generation
  db/         raw-SQL migrations + seed (pg, no ORM)
  crypto/     credential encryption at rest
  artifacts/  filesystem and S3-compatible protected artifact storage
  plugin-playwright/ target-scoped browser inspection plugin
  plugin-catalog/ shared built-in plugin manifest
deploy/       docker, k8s, helm, alerts
docs/         design + operations docs
scripts/      backup/restore/smoke helpers
dev.sh        developer entrypoint (run/test/migrate/seed/wptest/…)
```

---

## Further reading

- [`docs/local-development.md`](docs/local-development.md) — deeper dev setup
- [`docs/uxdesign.md`](docs/uxdesign.md) — UI design guide and patterns
- [`docs/users.md`](docs/users.md) — user/role model
- [`docs/client-integration.md`](docs/client-integration.md) — connecting AI clients
- [`docs/disposable-wordpress.md`](docs/disposable-wordpress.md) — throwaway test servers
- [`docs/security-foundation.md`](docs/security-foundation.md) &
  [`docs/security-operations.md`](docs/security-operations.md) — security model + ops
- [`docs/production-runbook.md`](docs/production-runbook.md) — production operations
- [`docs/expansion-plan.md`](docs/expansion-plan.md) — optional roadmap

---

AIBroker is for authorized WordPress operations and security testing on servers you
administer. Don't use it to access servers you don't own.
