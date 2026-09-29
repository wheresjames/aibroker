import React from "react";
import { navItems, canAccessNav, ADMIN_ROLES } from "./nav-access.js";
import type {
  User, Server, Group, GroupMembership, Token, ToolDefinition, Policy, PolicyPermission, Binding,
  EffectiveAccess, AuditEvent, MyActivity, ThemeMode, ToastTone, ToastItem, SelectItem, ComboboxOption, ZxcvbnModule, Api, Runner
} from "./types.js";
import { toolNames, readSession, writeSession, clearSession, initialTheme, applyTheme } from "./helpers.js";
import { ThemeSelector, ToastFooter, AccessDenied } from "./components.js";
import { Login, ChangePassword, Settings, Dashboard, Users, Groups, Servers, Sandbox, Tokens, Policies, Audit, HostAccess, WordPressSessions, Operations, Mcp, ClientSetup } from "./pages.js";

export function App() {
  const [active, setActive] = React.useState(navItems[0]);
  const [navOpen, setNavOpen] = React.useState(false);
  const [user, setUser] = React.useState<User | null>(() => readSession());
  const [passwordChangeUser, setPasswordChangeUser] = React.useState<User | null>(null);
  const [theme, setTheme] = React.useState<ThemeMode>(() => initialTheme());
  const [activeToast, setActiveToast] = React.useState<ToastItem | null>(null);
  const [toastHistory, setToastHistory] = React.useState<ToastItem[]>([]);
  const [state, setState] = React.useState({
    ready: "checking",
    summary: {},
    users: [] as User[],
    groups: [] as Group[],
    memberships: [] as GroupMembership[],
    servers: [] as Server[],
    tokens: [] as Token[],
    policies: [] as Policy[],
    bindings: [] as Binding[],
    tools: [] as ToolDefinition[],
    auditEvents: [] as AuditEvent[],
    myTokens: [] as Token[],
    myActivity: null as MyActivity | null,
    defaultServerName: "aibroker"
  });
  const [secret, setSecret] = React.useState("");
  const [sandboxEnabled, setSandboxEnabled] = React.useState(false);

  React.useEffect(() => { void fetch("/runtime").then((response) => response.json()).then((body) => setSandboxEnabled(body.sandbox_enabled === true)).catch(() => undefined); }, []);

  const api = React.useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const headers = new Headers(init.headers);
      // Only send a JSON content-type when there is a body. Empty-body POSTs
      // (revoke, disable, test-connection, refresh) with content-type set to
      // application/json are rejected by Fastify (FST_ERR_CTP_EMPTY_JSON_BODY).
      if (init.body !== undefined && init.body !== null) {
        headers.set("content-type", "application/json");
      }
      if (user) headers.set("x-aibroker-session", user.session_token);
      const response = await fetch(path, { ...init, headers });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) {
          clearSession();
          setUser(null);
        }
        // Keep the status and body so callers can act on structured errors (e.g. capture_id).
        throw Object.assign(new Error(body.message || body.error || `Request failed: ${response.status}`), { status: response.status, body });
      }
      return body as T;
    },
    [user]
  );

  const refresh = React.useCallback(async () => {
    if (!user) return;
    // Everyone has self-service data: their own tokens and their own activity feed.
    const mePromise = Promise.all([
      api<{ tokens: Token[] }>("/me/tokens"),
      api<MyActivity>("/me/activity"),
      api<{ default_mcp_server_name: string }>("/me/broker-config")
    ])
      .then(([tokens, activity, brokerConfig]) => ({
        myTokens: Array.isArray(tokens?.tokens) ? tokens.tokens : [],
        // Normalize so a partial/stale API response (e.g. one omitting `events`)
        // can never surface an undefined array to the Dashboard.
        myActivity: {
          events: Array.isArray(activity?.events) ? activity.events : [],
          last_login_at: activity?.last_login_at ?? null,
          active_tokens: Number(activity?.active_tokens ?? 0),
          recent_calls: Number(activity?.recent_calls ?? 0)
        } as MyActivity,
        defaultServerName: brokerConfig?.default_mcp_server_name || "aibroker"
      }))
      .catch(() => ({ myTokens: [] as Token[], myActivity: null, defaultServerName: "aibroker" }));

    // Regular users and auditors only have access to self-service surfaces
    // (Dashboard, Tokens, Client Setup). Skip the /admin/* loads so they don't
    // trip a 401 and flag the shell as errored.
    if (!ADMIN_ROLES.includes(user.role)) {
      try {
        const me = await mePromise;
        setState((current) => ({ ...current, ready: "ok", ...me }));
      } catch {
        setState((current) => ({ ...current, ready: "error" }));
      }
      return;
    }
    try {
      const [admin, me] = await Promise.all([
        Promise.all([
          api<{ users: number; servers: number; active_tokens: number; audit_events: number }>("/admin/summary"),
          api<{ users: User[] }>("/admin/users"),
          api<{ groups: Group[]; memberships: GroupMembership[] }>("/admin/groups"),
          api<{ servers: Server[] }>("/admin/servers"),
          api<{ tokens: Token[] }>("/admin/tokens"),
          api<{ policies: Policy[] }>("/admin/policies"),
          api<{ bindings: Binding[] }>("/admin/bindings"),
          api<{ tools: ToolDefinition[] }>("/admin/tools"),
          api<{ audit_events: AuditEvent[] }>("/admin/audit-events")
        ]),
        mePromise
      ]);
      const [summary, users, groups, servers, tokens, policies, bindings, tools, audit] = admin;
      setState((current) => ({
        ...current,
        ready: "ok",
        summary,
        users: users.users,
        groups: groups.groups,
        memberships: groups.memberships,
        servers: servers.servers,
        tokens: tokens.tokens,
        policies: policies.policies,
        bindings: bindings.bindings,
        tools: tools.tools,
        auditEvents: audit.audit_events,
        ...me
      }));
    } catch {
      setState((current) => ({ ...current, ready: "error" }));
    }
  }, [api, user]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  // Persist (and slide the 6-day expiry of) the session whenever the signed-in
  // user changes; clear it on sign-out.
  React.useEffect(() => {
    if (user) writeSession(user);
    else clearSession();
  }, [user]);

  React.useEffect(() => {
    if (!user) return;
    if (!canAccessNav(active, user.role) || (active === "Sandbox" && !sandboxEnabled)) {
      setActive(navItems.find((item) => canAccessNav(item, user.role) && (item !== "Sandbox" || sandboxEnabled)) ?? "");
    }
  }, [user, active, sandboxEnabled]);

  React.useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  React.useEffect(() => {
    if (!activeToast) return;
    const timeout = window.setTimeout(() => {
      setActiveToast((current) => (current?.id === activeToast.id ? null : current));
    }, 8000);
    return () => window.clearTimeout(timeout);
  }, [activeToast]);

  const notify = React.useCallback((text: string, tone: ToastTone = "info") => {
    const toast = { id: Date.now(), text, tone, createdAt: new Date() };
    setActiveToast(toast);
    setToastHistory((current) => [toast, ...current].slice(0, 60));
  }, []);

  const run = async (label: string, action: () => Promise<void>) => {
    try {
      await action();
      await refresh();
      notify(`${label} succeeded`, "success");
      return true;
    } catch (err) {
      notify(err instanceof Error ? err.message : `${label} failed`, "error");
      return false;
    }
  };

  if (!user) {
    if (passwordChangeUser) {
      return (
        <>
          <ChangePassword user={passwordChangeUser} onChanged={setUser} theme={theme} setTheme={setTheme} />
          <ToastFooter activeToast={activeToast} history={toastHistory} />
        </>
      );
    }
    return (
      <>
        <Login
          theme={theme}
          setTheme={setTheme}
          onLogin={(nextUser) => {
            if (nextUser.password_change_required) {
              setPasswordChangeUser(nextUser);
            } else {
              setUser(nextUser);
            }
          }}
        />
        <ToastFooter activeToast={activeToast} history={toastHistory} />
      </>
    );
  }

  return (
    <>
      <main className="app-shell">
        <div className={`nav-backdrop${navOpen ? " open" : ""}`} onClick={() => setNavOpen(false)} aria-hidden={!navOpen} />
        <aside className={`sidebar${navOpen ? " open" : ""}`} aria-label="Primary">
          <div className="brand">AIBroker</div>
          <div className="nav-label">Workspace</div>
          <nav>
            {navItems.filter((item) => canAccessNav(item, user.role) && (item !== "Sandbox" || sandboxEnabled)).map((item) => (
              <button className={active === item ? "active" : ""} key={item} onClick={() => { setActive(item); setNavOpen(false); }}>
                {item}
              </button>
            ))}
          </nav>
        <div className="sidebar-footer">
          <div className="sidebar-footer-group">
            <span>Theme</span>
            <ThemeSelector value={theme} onChange={setTheme} placement="sidebar" />
          </div>
          <button
            type="button"
            onClick={() => {
              // Revoke the session server-side; sign out locally even if that fails.
              if (user) void fetch("/auth/logout", { method: "POST", headers: { "x-aibroker-session": user.session_token } }).catch(() => undefined);
              setUser(null);
              setPasswordChangeUser(null);
              setSecret("");
              notify("Signed out", "info");
            }}
          >
            Sign out
          </button>
        </div>
        </aside>
        <section className="content">
          <header className="topbar">
            <button type="button" className="nav-toggle" aria-label="Open navigation" aria-expanded={navOpen} onClick={() => setNavOpen((current) => !current)}>
              <span className="nav-toggle-bar" />
              <span className="nav-toggle-bar" />
              <span className="nav-toggle-bar" />
            </button>
            <div>
              <h1>{active || "Access"}</h1>
              <p>{`${user.display_name} (${user.role})`}</p>
            </div>
            <span className={`status ${state.ready}`}>API {state.ready}</span>
          </header>

          {!canAccessNav(active, user.role) ? (
            <AccessDenied />
          ) : (
            <>
              {active === "Dashboard" ? <Dashboard summary={state.summary} user={user} myActivity={state.myActivity} myTokens={state.myTokens} /> : null}
              {active === "Users" ? <Users users={state.users} servers={state.servers} policies={state.policies} bindings={state.bindings} memberships={state.memberships} groups={state.groups} run={run} api={api} /> : null}
              {active === "Groups" ? <Groups users={state.users} groups={state.groups} memberships={state.memberships} servers={state.servers} policies={state.policies} bindings={state.bindings} run={run} api={api} /> : null}
              {active === "Servers" ? <Servers servers={state.servers} groups={state.groups} users={state.users} policies={state.policies} bindings={state.bindings} run={run} api={api} /> : null}
              {active === "Sandbox" && sandboxEnabled ? <Sandbox api={api} run={run} /> : null}
              {active === "Tokens" ? (
                <Tokens user={user} users={state.users} tokens={state.tokens} myTokens={state.myTokens} run={run} api={api} secret={secret} setSecret={setSecret} />
              ) : null}
              {active === "Policies" ? (
                <Policies policies={state.policies} bindings={state.bindings} tools={state.tools} users={state.users} servers={state.servers} run={run} api={api} />
              ) : null}
              {active === "Audit Logs" ? <Audit events={state.auditEvents} /> : null}
              {active === "Host Access" ? <HostAccess api={api} run={run} /> : null}
              {active === "WordPress Sessions" ? <WordPressSessions api={api} run={run} /> : null}
              {active === "Operations" ? <Operations api={api} /> : null}
              {active === "MCP" ? <Mcp api={api} servers={state.servers} user={user} notify={notify} /> : null}
              {active === "Client Setup" ? <ClientSetup secret={secret} user={user} myTokens={state.myTokens} defaultServerName={state.defaultServerName} /> : null}
              {active === "Settings" ? <Settings user={user} onUser={setUser} defaultServerName={state.defaultServerName} onDefaultServerName={(name) => setState((current) => ({ ...current, defaultServerName: name }))} run={run} api={api} notify={notify} /> : null}
            </>
          )}
        </section>
      </main>
      <ToastFooter activeToast={activeToast} history={toastHistory} />
    </>
  );
}
