import React from "react";
import { createPortal } from "react-dom";
import { navItems, canAccessNav, ADMIN_ROLES } from "./nav-access.js";
import { RemoteBrowserCapture, type CaptureFrame } from "./capture.js";
import type {
  User, Server, ServerPlugin, PluginType, Group, GroupMembership, Token, ToolDefinition, Policy, PolicyPermission, PolicyPluginIntent, AccessLevel, Binding,
  EffectiveAccess, AuditEvent, MyActivity, McpSession, McpTrafficEvent, SandboxTarget, ThemeMode, ToastTone, ToastItem, SelectItem, ComboboxOption, ZxcvbnModule, Api, Runner
} from "./types.js";
import {
  toolNames, activityLabel, fetchJson, tokenStoreKey, readTokenSecrets, rememberTokenSecret, nextDate,
  statusTone, renderCell, flattenUserTree, ownerLabel, ownerPath, roleRankUi, canOwnRoleUi, isStatusColumn,
  relativeTime, formatDuration,
  MATRIX_ACTIONS, ACTION_LABELS
} from "./helpers.js";
import type { ServerCapability } from "./types.js";
import {
  Modal, Form, Select, Combobox, PageToolbar, Panel, DataTable, ThemeSelector,
  PasswordStrengthInput, PasswordStrengthMeter, AccessDenied
} from "./components.js";

export function Login(props: { onLogin: (user: User) => void; theme: ThemeMode; setTheme: (theme: ThemeMode) => void }) {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState("");
  return (
    <main className="auth-page">
      <div className="auth-nav">
        <ThemeSelector value={props.theme} onChange={props.setTheme} placement="public" />
      </div>
      <section className="auth-copy" aria-labelledby="login-title">
        <p className="eyebrow">AIBroker Admin</p>
        <h1 id="login-title">Sign in</h1>
        <p>Centralized access control, credentials, and audit records for WordPress operations.</p>
      </section>
      <section className="auth-panel">
        <form
          className="login-form"
          aria-label="Login"
          onSubmit={async (event) => {
            event.preventDefault();
            setError("");
            try {
              const body = await fetchJson<{ user: Omit<User, "session_token">; password_change_required: boolean; session_token: string }>("/auth/login", {
                method: "POST",
                body: JSON.stringify({ email, password }),
                headers: { "content-type": "application/json" }
              });
              props.onLogin({ ...body.user, password_change_required: body.password_change_required, session_token: body.session_token });
            } catch (err) {
              setError(err instanceof Error ? err.message : "Login failed");
            }
          }}
        >
          <label>
            Username
            <input value={email} autoComplete="username" onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label>
            Password
            <input type="password" value={password} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} />
          </label>
          <button className="button-primary" type="submit">Log in</button>
          {error ? <p className="error-text" role="alert">{error}</p> : null}
        </form>
      </section>
    </main>
  );
}


export function ChangePasswordForm(props: { email: string; onChanged: (user: User) => void; submitLabel?: string; helper?: string; className?: string }) {
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  return (
    <form
      className={`login-form${props.className ? ` ${props.className}` : ""}`}
      aria-label="Change password"
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        if (!currentPassword) {
          setError("Enter your current password.");
          return;
        }
        if (!newPassword) {
          setError("Enter a new password.");
          return;
        }
        if (currentPassword === newPassword) {
          setError("New password must be different from your current password.");
          return;
        }
        if (newPassword !== confirmPassword) {
          setError("Passwords do not match");
          return;
        }
        setBusy(true);
        try {
          const body = await fetchJson<{ user: Omit<User, "session_token">; session_token: string }>("/auth/change-password", {
            method: "POST",
            body: JSON.stringify({
              email: props.email,
              current_password: currentPassword,
              new_password: newPassword
            }),
            headers: { "content-type": "application/json" }
          });
          props.onChanged({ ...body.user, session_token: body.session_token });
        } catch (err) {
          setError(err instanceof Error ? err.message : "Password change failed");
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Current password
        <input type="password" value={currentPassword} autoComplete="current-password" onChange={(event) => setCurrentPassword(event.target.value)} />
      </label>
      <label>
        New password
        <input type="password" value={newPassword} autoComplete="new-password" onChange={(event) => setNewPassword(event.target.value)} />
        <PasswordStrengthMeter password={newPassword} />
        <span className="helper-text">{props.helper ?? "Use a different password from your current one."}</span>
      </label>
      <label>
        Confirm new password
        <input type="password" value={confirmPassword} autoComplete="new-password" onChange={(event) => setConfirmPassword(event.target.value)} />
      </label>
      <button className="button-primary" type="submit" disabled={busy}>{props.submitLabel ?? "Change password"}</button>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
    </form>
  );
}


export function ChangePassword(props: { user: User; onChanged: (user: User) => void; theme: ThemeMode; setTheme: (theme: ThemeMode) => void }) {
  return (
    <main className="auth-page">
      <div className="auth-nav">
        <ThemeSelector value={props.theme} onChange={props.setTheme} placement="public" />
      </div>
      <section className="auth-copy" aria-labelledby="password-title">
        <p className="eyebrow">First login</p>
        <h1 id="password-title">Change password</h1>
        <p>The temporary credential must be replaced before the workspace is available.</p>
      </section>
      <section className="auth-panel">
        <ChangePasswordForm
          email={props.user.email}
          onChanged={props.onChanged}
          helper="Use a different password from the temporary credential."
        />
      </section>
    </main>
  );
}


export function Settings(props: {
  user: User;
  onUser: (user: User) => void;
  defaultServerName: string;
  onDefaultServerName: (name: string) => void;
  run: Runner;
  api: Api;
  notify: (text: string, tone?: ToastTone) => void;
}) {
  const [profile, setProfile] = React.useState({ display_name: props.user.display_name, email: props.user.email });
  const [securityOpen, setSecurityOpen] = React.useState(false);
  const [serverName, setServerName] = React.useState(props.defaultServerName);
  React.useEffect(() => { setServerName(props.defaultServerName); }, [props.defaultServerName]);
  const serverNameValid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(serverName.trim());
  return (
    <section className="page-section">
      {props.user.role === "global_admin" ? (
        <section className="settings-card">
          <h2>Broker defaults</h2>
          <div className="settings-card-body">
            <p className="config-note">
              The default MCP server name new clients see on the Client Setup page. Each client can still
              override it on their end.
            </p>
            <form
              className="login-form settings-form"
              onSubmit={async (event) => {
                event.preventDefault();
                const next = serverName.trim();
                if (!serverNameValid) return;
                const ok = await props.run("Save broker defaults", async () => {
                  const body = await props.api<{ default_mcp_server_name: string }>("/admin/broker-defaults", {
                    method: "PUT",
                    body: JSON.stringify({ default_mcp_server_name: next })
                  });
                  props.onDefaultServerName(body.default_mcp_server_name);
                });
                if (ok) props.notify("Broker defaults saved", "success");
              }}
            >
              <label>
                Default MCP server name
                <input value={serverName} onChange={(event) => setServerName(event.target.value)} spellCheck={false} autoCapitalize="none" autoComplete="off" />
              </label>
              {serverName.trim() && !serverNameValid ? (
                <p className="client-note">Use 1-64 characters: letters, digits, hyphen, or underscore, starting with a letter or digit.</p>
              ) : null}
              <button className="button-primary" type="submit" disabled={!serverNameValid}>Save defaults</button>
            </form>
          </div>
        </section>
      ) : null}
      <section className="settings-card">
        <h2>Profile</h2>
        <div className="settings-card-body">
          <form
            className="login-form settings-form"
            onSubmit={async (event) => {
              event.preventDefault();
              const ok = await props.run("Save profile", async () => {
                const body = await props.api<{ user: User }>("/me/profile", { method: "PATCH", body: JSON.stringify(profile) });
                props.onUser(body.user);
              });
              if (ok) props.notify("Profile saved", "success");
            }}
          >
            <label>
              Display name
              <input value={profile.display_name} onChange={(event) => setProfile({ ...profile, display_name: event.target.value })} />
            </label>
            <label>
              Email
              <input value={profile.email} autoComplete="email" onChange={(event) => setProfile({ ...profile, email: event.target.value })} />
            </label>
            <button className="button-primary" type="submit">Save profile</button>
          </form>
        </div>
      </section>
      <section className="settings-card">
        <h2>Security</h2>
        <div className="settings-card-body">
          <p className="config-note">Update the password you use to sign in to AIBroker.</p>
          <button type="button" onClick={() => setSecurityOpen(true)}>Change password</button>
        </div>
      </section>
      {securityOpen ? (
        <Modal title="Change password" onClose={() => setSecurityOpen(false)}>
          <ChangePasswordForm
            className="modal-form"
            email={props.user.email}
            onChanged={(next) => { props.onUser(next); setSecurityOpen(false); props.notify("Password changed", "success"); }}
          />
        </Modal>
      ) : null}
    </section>
  );
}


export function Dashboard(props: {
  summary: Record<string, unknown>;
  user: User;
  myActivity: MyActivity | null;
  myTokens: Token[];
}) {
  const admin = ADMIN_ROLES.includes(props.user.role);
  const activity = props.myActivity;
  return (
    <section className="page-section">
      {admin ? (
        <section className="grid">
          <Panel title="Servers" value={String(props.summary.servers ?? 0)} label="Registered WordPress servers" />
          <Panel title="Users" value={String(props.summary.users ?? 0)} label="Broker accounts" />
          <Panel title="Tokens" value={String(props.summary.active_tokens ?? 0)} label="Active API tokens" />
          <Panel title="Audit" value={String(props.summary.audit_events ?? 0)} label="Recorded events" />
        </section>
      ) : null}
      <section className="dashboard-personal">
        <h2>Your activity</h2>
        <section className="grid">
          <Panel title="Last login" value={activity?.last_login_at ? new Date(activity.last_login_at).toLocaleString() : "—"} label="Your most recent sign-in" />
          <Panel title="Active tokens" value={String(activity?.active_tokens ?? 0)} label="Your unrevoked tokens" />
          <Panel title="API calls (7d)" value={String(activity?.recent_calls ?? 0)} label="MCP tool calls this week" />
        </section>
        <h3>Recent activity</h3>
        {(() => {
          const events = activity?.events ?? [];
          return events.length > 0 ? (
            <ul className="activity-list">
              {events.map((event) => (
                <li className="activity-row" key={event.id}>
                  <time>{new Date(event.created_at).toLocaleString()}</time>
                  <span>{activityLabel(event)}</span>
                  <span className={`chip ${statusTone(event.status)}`}>{event.status}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="config-note">No recent activity.</p>
          );
        })()}
      </section>
    </section>
  );
}

export function Sandbox(props: { api: Api; run: Runner }) {
  const [targets, setTargets] = React.useState<SandboxTarget[]>([]);
  const [modal, setModal] = React.useState<"create" | "teardown" | null>(null);
  const [selected, setSelected] = React.useState<SandboxTarget | null>(null);
  const [form, setForm] = React.useState({ plugin_key: "postgres", name: "Postgres sandbox", reason: "", confirmed: false });
  const load = React.useCallback(async () => {
    const body = await props.api<{ targets: SandboxTarget[] }>("/admin/sandbox"); setTargets(body.targets);
  }, [props.api]);
  React.useEffect(() => { void load(); }, [load]);
  const copyConfig = async (target: SandboxTarget) => navigator.clipboard.writeText(JSON.stringify({ ...target.connection_config, ...target.secrets }, null, 2));
  return <section className="page-section">
    <div className="inline-notice"><strong>Disposable test targets</strong><span>Nothing is registered automatically. Copy the shown config into the normal Server/Plugin flow, or use the opt-in shortcut.</span></div>
    <PageToolbar count={targets.length} actions={<button onClick={() => setModal("create")}>+ Create test target</button>} />
    {modal === "create" ? <Modal title="Create test target" onClose={() => setModal(null)}>
      <Form onCancel={() => setModal(null)} onSubmit={async () => {
        const ok = await props.run("Create sandbox", () => props.api("/admin/sandbox", { method: "POST", body: JSON.stringify({ plugin_key: form.plugin_key, name: form.name }) }));
        if (ok) { setModal(null); await load(); }
      }}>
        <label className="modal-field"><span>Plugin type</span><select value={form.plugin_key} onChange={(event) => { const plugin_key = event.target.value; setForm({ ...form, plugin_key, name: plugin_key === "postgres" ? "Postgres sandbox" : "WordPress sandbox" }); }}><option value="postgres">Postgres</option><option value="wordpress">WordPress</option></select></label>
        <label className="modal-field"><span>Name</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      </Form>
    </Modal> : null}
    {modal === "teardown" && selected ? <Modal title={`Tear down ${selected.name}`} onClose={() => setModal(null)}>
      <div className="inline-notice inline-notice-warning"><strong>This destroys the disposable resource</strong><span>The audit record and any separately registered Server remain.</span></div>
      <Form onCancel={() => setModal(null)} onSubmit={async () => {
        if (!form.confirmed || !form.reason.trim()) return;
        const ok = await props.run("Tear down sandbox", () => props.api(`/admin/sandbox/${selected.id}/teardown`, { method: "POST", body: JSON.stringify({ confirmed: true, reason: form.reason }) }));
        if (ok) { setModal(null); await load(); }
      }}>
        <textarea required placeholder="Reason (required)" value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
        <label><input type="checkbox" checked={form.confirmed} onChange={(event) => setForm({ ...form, confirmed: event.target.checked })} /> I understand this resource will be destroyed</label>
      </Form>
    </Modal> : null}
    <DataTable columns={["name", "type", "lifecycle", "connection config", "actions"]} rows={targets.map((target) => ({
      id: target.id, name: target.name, type: target.plugin_key,
      lifecycle: <span className={`chip ${statusTone(target.status)}`}>ephemeral · {target.status}</span>,
      "connection config": <pre className="config-preview">{JSON.stringify({ ...target.connection_config, ...target.secrets }, null, 2)}</pre>,
      actions: <div className="cell-actions">
        <button onClick={() => void copyConfig(target)}>Copy config</button>
        {!target.registered_server_id && target.status === "running" ? <button onClick={() => void props.run("Register test server", async () => { await props.api(`/admin/sandbox/${target.id}/register`, { method: "POST" }); await load(); })}>Register this test server</button> : null}
        {target.registered_server_id ? <span className="chip">registered</span> : null}
        {target.status === "running" ? <button className="button-danger" onClick={() => { setSelected(target); setForm({ ...form, reason: "", confirmed: false }); setModal("teardown"); }}>Teardown</button> : null}
      </div>
    }))} />
  </section>;
}


export function Users(props: {
  users: User[];
  servers: Server[];
  policies: Policy[];
  bindings: Binding[];
  memberships: GroupMembership[];
  groups: Group[];
  run: Runner;
  api: Api;
}) {
  const [selectedUserId, setSelectedUserId] = React.useState<string>("");
  const [selectedTab, setSelectedTab] = React.useState<"overview" | "bindings" | "effective">("overview");
  const [form, setForm] = React.useState({ email: "", display_name: "", password: "", role: "user", status: "active", owner_user_id: "", reason: "" });
  const [move, setMove] = React.useState({ user_id: "", new_owner_user_id: "", reason: "" });
  const [open, setOpen] = React.useState(false);
  const selectedUser = props.users.find((user) => user.id === selectedUserId);
  const movingUser = props.users.find((user) => user.id === move.user_id);
  return (
    <section className="page-section">
      {selectedUser ? (
        <UserDetailTabs
          user={selectedUser}
          servers={props.servers}
          policies={props.policies}
          bindings={props.bindings.filter((binding) => binding.subject_type === "user" && binding.subject_id === selectedUser.id)}
          memberships={props.memberships.filter((membership) => membership.user_id === selectedUser.id)}
          groups={props.groups}
          users={props.users}
          activeTab={selectedTab}
          onTabChange={setSelectedTab}
          onBack={() => setSelectedUserId("")}
          run={props.run}
          api={props.api}
        />
      ) : (
        <>
          <PageToolbar
            count={props.users.length}
            actions={
          <button
            onClick={() => {
              setForm((current) => ({ ...current, owner_user_id: "" }));
              setOpen(true);
            }}
          >
            + Add user
          </button>
        }
      />
      {open ? (
        <Modal title="Create User" onClose={() => setOpen(false)}>
          <Form
            onCancel={() => setOpen(false)}
            onSubmit={async () => {
              const ok = await props.run("Create user", async () => {
                await props.api("/admin/users", {
                  method: "POST",
                  body: JSON.stringify({ ...form, owner_user_id: form.owner_user_id || null })
                });
                setForm({ email: "", display_name: "", password: "", role: "user", status: "active", owner_user_id: "", reason: "" });
              });
              if (ok) setOpen(false);
            }}
          >
            <div className="owner-context">
              <span>Selected owner</span>
              <strong>{ownerLabel(props.users, form.owner_user_id)}</strong>
            </div>
            <input placeholder="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <input
              placeholder="display name"
              value={form.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            />
            <PasswordStrengthInput
              placeholder="password"
              value={form.password}
              onChange={(password) => setForm({ ...form, password })}
            />
            <span className="helper-text">This is a temporary password — the user must change it at first login.</span>
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              {["active", "invited", "disabled"].map((status) => (
                <option key={status}>{status}</option>
              ))}
            </select>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value, owner_user_id: e.target.value === "global_admin" ? "" : form.owner_user_id })}>
              {["user", "auditor", "team_admin", "global_admin"].map((role) => (
                <option key={role}>{role}</option>
              ))}
            </select>
            <OwnerSelect users={props.users} value={form.owner_user_id} onChange={(owner_user_id) => setForm({ ...form, owner_user_id })} label={form.role === "global_admin" ? "Root owner" : "Select owner"} targetRole={form.role} disabled={form.role === "global_admin"} allowRoot={form.role === "global_admin"} />
            <input placeholder="reason for owner assignment" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </Form>
        </Modal>
      ) : null}
      {move.user_id ? (
        <Modal title="Move User" onClose={() => setMove({ user_id: "", new_owner_user_id: "", reason: "" })}>
          <Form
            onCancel={() => setMove({ user_id: "", new_owner_user_id: "", reason: "" })}
            onSubmit={async () => {
              const ok = await props.run("Move user", () =>
                props.api(`/admin/users/${move.user_id}/move`, {
                  method: "POST",
                  body: JSON.stringify({ new_owner_user_id: move.new_owner_user_id || null, reason: move.reason })
                })
              );
              if (ok) setMove({ user_id: "", new_owner_user_id: "", reason: "" });
            }}
          >
            <div className="owner-context">
              <span>Moved user</span>
              <strong>{movingUser?.display_name ?? "Unknown user"}</strong>
            </div>
            <div className="owner-context">
              <span>Current owner</span>
              <strong>{ownerLabel(props.users, movingUser?.owner_user_id ?? "")}</strong>
            </div>
            <OwnerSelect users={props.users} value={move.new_owner_user_id} onChange={(new_owner_user_id) => setMove({ ...move, new_owner_user_id })} label={movingUser?.role === "global_admin" ? "Root owner" : "Select owner"} excludeUserId={move.user_id} targetRole={movingUser?.role ?? ""} disabled={movingUser?.role === "global_admin"} allowRoot={movingUser?.role === "global_admin"} />
            <div className="owner-context">
              <span>Proposed owner</span>
              <strong>{ownerLabel(props.users, move.new_owner_user_id)}</strong>
            </div>
            {Number(movingUser?.descendant_count ?? 0) > 0 ? <p className="modal-warning">This moves {movingUser?.descendant_count} descendant users with this subtree.</p> : null}
            <input placeholder="reason for administrative move" value={move.reason} onChange={(e) => setMove({ ...move, reason: e.target.value })} />
          </Form>
        </Modal>
      ) : null}
        <UserTree
        users={props.users}
        selectedUserId={selectedUserId}
        onSelect={(id) => {
          setSelectedUserId(id);
          setSelectedTab("overview");
        }}
        onOwnerChange={(user, newOwnerUserId) =>
          props.run("Move user", () =>
            props.api(`/admin/users/${user.id}/move`, {
              method: "POST",
              body: JSON.stringify({ new_owner_user_id: newOwnerUserId || null, reason: "Inline owner update from user list" })
            })
          )
        }
        onMove={(user) => {
          if (user.role !== "global_admin") setMove({ user_id: user.id, new_owner_user_id: user.owner_user_id ?? "", reason: "" });
        }}
        onDisable={(user) => props.run("Disable user", () => props.api(`/admin/users/${user.id}/disable`, { method: "POST" }))}
      />
        </>
      )}
    </section>
  );
}


export function Groups(props: {
  users: User[];
  groups: Group[];
  memberships: GroupMembership[];
  servers: Server[];
  policies: Policy[];
  bindings: Binding[];
  run: Runner;
  api: Api;
}) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [selectedGroupId, setSelectedGroupId] = React.useState("");
  const [selectedTab, setSelectedTab] = React.useState<"members" | "servers" | "effective">("members");
  const [modal, setModal] = React.useState<"group" | null>(null);
  const selectedGroup = props.groups.find((group) => group.id === selectedGroupId);
  const groupMembers = selectedGroup ? props.memberships.filter((membership) => membership.group_id === selectedGroup.id) : [];
  const groupBindings = selectedGroup ? props.bindings.filter((binding) => binding.subject_type === "group" && binding.subject_id === selectedGroup.id) : [];
  return (
    <section className="page-section">
      {selectedGroup ? (
        <GroupDetailTabs
          group={selectedGroup}
          users={props.users}
          memberships={groupMembers}
          servers={props.servers}
          policies={props.policies}
          bindings={groupBindings}
          activeTab={selectedTab}
          onTabChange={setSelectedTab}
          onBack={() => setSelectedGroupId("")}
          run={props.run}
          api={props.api}
        />
      ) : (
        <>
          <PageToolbar
            count={props.groups.length}
            actions={<button onClick={() => setModal("group")}>+ Add group</button>}
          />
          {modal === "group" ? (
        <Modal title="Create Group" onClose={() => setModal(null)}>
          <Form
            onCancel={() => setModal(null)}
            onSubmit={async () => {
              const ok = await props.run("Create group", () => props.api("/admin/groups", { method: "POST", body: JSON.stringify({ name, description }) }));
              if (ok) {
                setName("");
                setDescription("");
                setModal(null);
              }
            }}
          >
            <input placeholder="group name" value={name} onChange={(e) => setName(e.target.value)} />
            <input placeholder="description" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Form>
        </Modal>
      ) : null}
      <DataTable
        columns={["name", "owner_display_name", "member_count", "server_count", "description"]}
        rows={props.groups.map((group) => ({
          ...group,
          name: <button type="button" className={selectedGroupId === group.id ? "link-button active" : "link-button"} onClick={() => { setSelectedGroupId(group.id); setSelectedTab("members"); }}>{group.name}</button>
        }))}
      />
        </>
      )}
    </section>
  );
}


export function GroupDetailTabs(props: {
  group: Group;
  users: User[];
  memberships: GroupMembership[];
  servers: Server[];
  policies: Policy[];
  bindings: Binding[];
  activeTab: "members" | "servers" | "effective";
  onTabChange: (tab: "members" | "servers" | "effective") => void;
  onBack: () => void;
  run: Runner;
  api: Api;
}) {
  const tabs = [
    { id: "members" as const, label: "Members", count: props.memberships.length },
    { id: "servers" as const, label: "Servers", count: props.bindings.length },
    { id: "effective" as const, label: "Effective access" }
  ];
  const memberUsers = props.memberships.map((member) => ({
    id: member.user_id,
    display_name: member.display_name ?? member.email ?? member.user_id,
    email: member.email ?? ""
  }));
  const [editing, setEditing] = React.useState(false);
  const [editForm, setEditForm] = React.useState({ name: props.group.name, description: props.group.description ?? "" });
  return (
    <section className="user-detail">
      <header className="user-detail-header">
        <div className="detail-title">
          <button type="button" className="back-button" onClick={props.onBack} aria-label="Back to groups">←</button>
          <div>
            <h2>{props.group.name}</h2>
            <p>{props.group.description || props.group.owner_display_name || "Group"}</p>
          </div>
        </div>
        <div className="detail-header-actions">
          <span className="chip">{props.memberships.length} members</span>
          <button type="button" onClick={() => { setEditForm({ name: props.group.name, description: props.group.description ?? "" }); setEditing(true); }}>Edit</button>
        </div>
      </header>
      {editing ? (
        <Modal title="Edit Group" onClose={() => setEditing(false)}>
          <Form
            onCancel={() => setEditing(false)}
            onSubmit={async () => {
              const ok = await props.run("Save group", () =>
                props.api(`/admin/groups/${props.group.id}`, { method: "PATCH", body: JSON.stringify(editForm) })
              );
              if (ok) setEditing(false);
            }}
          >
            <input placeholder="group name" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
            <input placeholder="description" value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} />
          </Form>
        </Modal>
      ) : null}
      <div className="tab-rail" role="tablist" aria-label="Selected group sections">
        {tabs.map((tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={props.activeTab === tab.id}
            className={props.activeTab === tab.id ? "active" : ""}
            key={tab.id}
            onClick={() => props.onTabChange(tab.id)}
          >
            <span>{tab.label}</span>
          </button>
        ))}
      </div>
      <div className="tab-body">
        {props.activeTab === "members" ? (
          <GroupMembers group={props.group} users={props.users} memberships={props.memberships} run={props.run} api={props.api} />
        ) : null}
        {props.activeTab === "servers" ? (
          <GroupSites group={props.group} servers={props.servers} policies={props.policies} bindings={props.bindings} run={props.run} api={props.api} />
        ) : null}
        {props.activeTab === "effective" ? <EffectiveAccessPanel users={memberUsers} servers={props.servers} api={props.api} /> : null}
      </div>
    </section>
  );
}


export function GroupMembers(props: {
  group: Group;
  users: User[];
  memberships: GroupMembership[];
  run: Runner;
  api: Api;
}) {
  const [open, setOpen] = React.useState(false);
  const [memberUserId, setMemberUserId] = React.useState("");
  return (
    <section className="binding-tab">
      <div className="tab-actions">
        <div>
          <h3>Members</h3>
        </div>
        <button onClick={() => setOpen(true)}>+ Add member</button>
      </div>
      {open ? (
        <Modal title="Add Member" onClose={() => setOpen(false)}>
          <Form
            onCancel={() => setOpen(false)}
            onSubmit={async () => {
              const ok = await props.run("Add member", () =>
                props.api(`/admin/groups/${props.group.id}/members`, { method: "POST", body: JSON.stringify({ user_ids: [memberUserId] }) })
              );
              if (ok) {
                setMemberUserId("");
                setOpen(false);
              }
            }}
          >
            <div className="owner-context"><span>Group</span><strong>{props.group.name}</strong></div>
            <Select value={memberUserId} onChange={setMemberUserId} items={props.users} label="user" />
          </Form>
        </Modal>
      ) : null}
      <DataTable
        columns={["display_name", "email", "actions"]}
        rows={props.memberships.map((member) => ({
          ...member,
          actions: <button className="button-danger" onClick={() => props.run("Remove member", () => props.api(`/admin/groups/${props.group.id}/members/${member.user_id}`, { method: "DELETE", body: JSON.stringify({ reason: "Removed in group editor" }) }))}>Remove</button>
        }))}
      />
    </section>
  );
}


export function GroupSites(props: {
  group: Group;
  servers: Server[];
  policies: Policy[];
  bindings: Binding[];
  run: Runner;
  api: Api;
}) {
  const [open, setOpen] = React.useState(false);
  const [serverBinding, setSiteBinding] = React.useState({ server_id: "", policy_id: "" });
  return (
    <section className="binding-tab">
      <div className="tab-actions">
        <div>
          <h3>Server bindings</h3>
        </div>
        <button onClick={() => setOpen(true)}>+ Bind server</button>
      </div>
      {open ? (
        <Modal title="Bind Server" onClose={() => setOpen(false)}>
          <Form
            onCancel={() => setOpen(false)}
            onSubmit={async () => {
              const ok = await props.run("Bind server", () =>
                props.api(`/admin/groups/${props.group.id}/servers`, { method: "POST", body: JSON.stringify({ servers: [serverBinding] }) })
              );
              if (ok) {
                setSiteBinding({ server_id: "", policy_id: "" });
                setOpen(false);
              }
            }}
          >
            <div className="owner-context"><span>Group</span><strong>{props.group.name}</strong></div>
            <Select value={serverBinding.server_id} onChange={(server_id) => setSiteBinding({ ...serverBinding, server_id })} items={props.servers} label="server" />
            <Select value={serverBinding.policy_id} onChange={(policy_id) => setSiteBinding({ ...serverBinding, policy_id })} items={props.policies} label="policy" />
          </Form>
        </Modal>
      ) : null}
      <DataTable
        columns={["server_name", "policy_name", "actions"]}
        rows={props.bindings.map((binding) => ({
          ...binding,
          policy_name: (
            <Select
              value={binding.policy_id}
              onChange={(policy_id) =>
                void props.run("Update server policy", () =>
                  props.api(`/admin/groups/${props.group.id}/servers`, {
                    method: "POST",
                    body: JSON.stringify({ servers: [{ server_id: binding.server_id, policy_id }] })
                  })
                )
              }
              items={props.policies}
              label="policy"
            />
          ),
          actions: <button className="button-danger" onClick={() => props.run("Unbind server", () => props.api(`/admin/groups/${props.group.id}/servers/${binding.server_id}`, { method: "DELETE", body: JSON.stringify({ reason: "Removed in group editor" }) }))}>Remove</button>
        }))}
      />
    </section>
  );
}


// REST-credential legibility (A1): make the missing/expired credential — the gap that
// silently breaks every server tool — visible at a glance.
function credentialChip(status: Server["rest_credential_status"]): React.ReactNode {
  if (status === "active") return <span className="chip chip-success">credential</span>;
  if (status === "expired") return <span className="chip chip-danger">expired</span>;
  return <span className="chip chip-warning" title="No REST credential registered — add one under Servers → REST credential.">no credential</span>;
}

export function Servers(props: { servers: Server[]; groups: Group[]; users: User[]; policies: Policy[]; bindings: Binding[]; run: Runner; api: Api }) {
  const [server, setSite] = React.useState({
    name: "",
    address: "",
    slug: "",
    base_url: "",
    client_name: "",
    tags_text: "",
    multisite_network_slug: "",
    wordpress_path: "",
    "wp_cli_path": "wp"
  });
  const [credential, setCredential] = React.useState({ server_id: "", username: "", application_password: "" });
  const [ssh, setSsh] = React.useState({ server_id: "", mode: "typed_wp_cli", host: "", port: 22, username: "", private_key: "", passphrase: "", known_hosts_line: "", host_key_fingerprint: "", wordpress_path: "", "wp_cli_path": "wp", has_sudo: false, unrestricted_sudo: false });
  const [selectedServerId, setSelectedServerId] = React.useState("");
  const [selectedTab, setSelectedTab] = React.useState<"overview" | "plugins" | "capabilities" | "audit">("overview");
  const [modal, setModal] = React.useState<"server" | "rest" | "ssh" | "disable-server" | null>(null);
  const [dangerServer, setDangerServer] = React.useState<Server | null>(null);
  const [disableReason, setDisableReason] = React.useState("");
  const selectedServer = props.servers.find((item) => item.id === selectedServerId);
  return (
    <section className="page-section">
      {selectedServer ? (
        <ServerDetailTabs
          server={selectedServer}
          groups={props.groups}
          users={props.users}
          policies={props.policies}
          bindings={props.bindings.filter((binding) => binding.server_id === selectedServer.id)}
          activeTab={selectedTab}
          onTabChange={setSelectedTab}
          onBack={() => setSelectedServerId("")}
          run={props.run}
          api={props.api}
        />
      ) : (
        <>
          <PageToolbar
            count={props.servers.length}
            actions={
              <>
                <button onClick={() => setModal("server")}>+ Add server</button>
              </>
            }
          />
          {modal === "server" ? (
        <Modal title="Register Server" onClose={() => setModal(null)} wide>
          <Form
            onCancel={() => setModal(null)}
            onSubmit={async () => {
              const ok = await props.run("Create server", () =>
                props.api("/admin/servers", {
                  method: "POST",
                  body: JSON.stringify({
                    ...server,
                    tags: server.tags_text.split(",").map((tag) => tag.trim()).filter(Boolean)
                  })
                })
              );
              if (ok) setModal(null);
            }}
          >
            <input placeholder="name" value={server.name} onChange={(e) => setSite({ ...server, name: e.target.value })} />
            <input placeholder="IP address or hostname" value={server.address} onChange={(e) => setSite({ ...server, address: e.target.value })} />
          </Form>
        </Modal>
      ) : null}
      {modal === "rest" ? (
        <Modal title="Replace REST Credential" onClose={() => setModal(null)}>
          <Form
            onCancel={() => setModal(null)}
            onSubmit={async () => {
              const ok = await props.run("Save credential", () =>
                props.api(`/admin/servers/${credential.server_id}/rest-credential`, { method: "POST", body: JSON.stringify(credential) })
              );
              if (ok) setModal(null);
            }}
          >
            <Select value={credential.server_id} onChange={(server_id) => setCredential({ ...credential, server_id })} items={props.servers} label="server" />
            <input placeholder="WordPress username" value={credential.username} onChange={(e) => setCredential({ ...credential, username: e.target.value })} />
            <input
              placeholder="Application Password"
              type="password"
              value={credential.application_password}
              onChange={(e) => setCredential({ ...credential, application_password: e.target.value })}
            />
          </Form>
        </Modal>
      ) : null}
      {modal === "ssh" ? (
        <Modal title="Replace SSH Credential" onClose={() => setModal(null)} wide>
          <Form
            onCancel={() => setModal(null)}
            onSubmit={async () => {
              const ok = await props.run("Save SSH credential", () =>
                props.api(`/admin/servers/${ssh.server_id}/ssh-credential`, { method: "POST", body: JSON.stringify(ssh) })
              );
              if (ok) setModal(null);
            }}
          >
            <Select value={ssh.server_id} onChange={(server_id) => setSsh({ ...ssh, server_id })} items={props.servers} label="server" />
            <input placeholder="host" value={ssh.host} onChange={(e) => setSsh({ ...ssh, host: e.target.value })} />
            <input placeholder="port" type="number" value={ssh.port} onChange={(e) => setSsh({ ...ssh, port: Number(e.target.value) })} />
            <input placeholder="SSH username" value={ssh.username} onChange={(e) => setSsh({ ...ssh, username: e.target.value })} />
            <select value={ssh.mode} onChange={(e) => setSsh({ ...ssh, mode: e.target.value })}><option value="typed_wp_cli">Typed WP-CLI</option><option value="constrained_shell">Constrained shell</option><option value="full_shell">Full Shell</option><option value="root_access">Root Access</option></select>
            <textarea placeholder="private key" value={ssh.private_key} onChange={(e) => setSsh({ ...ssh, private_key: e.target.value })} />
            <input type="password" placeholder="key passphrase (optional)" value={ssh.passphrase} onChange={(e) => setSsh({ ...ssh, passphrase: e.target.value })} />
            <input placeholder="pinned SHA256 host-key fingerprint" value={ssh.host_key_fingerprint} onChange={(e) => setSsh({ ...ssh, host_key_fingerprint: e.target.value })} />
            <textarea placeholder="pinned known_hosts entry" value={ssh.known_hosts_line} onChange={(e) => setSsh({ ...ssh, known_hosts_line: e.target.value })} />
            <input placeholder="WordPress path" value={ssh.wordpress_path} onChange={(e) => setSsh({ ...ssh, wordpress_path: e.target.value })} />
            <input placeholder="WP-CLI path" value={ssh.wp_cli_path} onChange={(e) => setSsh({ ...ssh, wp_cli_path: e.target.value })} />
          </Form>
        </Modal>
      ) : null}
      {modal === "disable-server" && dangerServer ? (
        <Modal title={`Disable ${dangerServer.name}`} onClose={() => setModal(null)}>
          <p className="config-note">This immediately removes all enabled plugin tools on this server from MCP clients.</p>
          <Form onCancel={() => setModal(null)} onSubmit={async () => {
            if (!disableReason.trim()) return;
            const ok = await props.run("Disable server", () => props.api(`/admin/servers/${dangerServer.id}/disable`, { method: "POST", body: JSON.stringify({ reason: disableReason.trim() }) }));
            if (ok) { setModal(null); setDisableReason(""); }
          }}>
            <textarea required placeholder="Reason (required)" value={disableReason} onChange={(e) => setDisableReason(e.target.value)} />
          </Form>
        </Modal>
      ) : null}
      <DataTable
        columns={["name", "address", "status", "plugins", "actions"]}
        rows={props.servers.map((item) => ({
          ...item,
          name: <button type="button" className={selectedServerId === item.id ? "link-button active" : "link-button"} onClick={() => { setSelectedServerId(item.id); setSelectedTab("overview"); }}>{item.name}</button>,
          plugins: item.plugin_count ?? 0,
          actions: (
            <div className="cell-actions">
              <button className="button-danger" onClick={() => { setDangerServer(item); setModal("disable-server"); }}>Disable</button>
            </div>
          )
        }))}
      />
        </>
      )}
    </section>
  );
}

export function HostAccess(props: { api: Api; run: Runner }) {
  const [operations,setOperations]=React.useState<Array<Record<string,unknown>>>([]); const [sessions,setSessions]=React.useState<Array<Record<string,unknown>>>([]);
  const [servers,setSites]=React.useState<Array<{id:string;name:string;mode:string}>>([]);const [start,setStart]=React.useState({server_id:"",mode:"constrained_shell",reason:""});
  const load=React.useCallback(async()=>{const [o,s,h]=await Promise.all([props.api<{operations:Array<Record<string,unknown>>}>("/me/host-operations"),props.api<{sessions:Array<Record<string,unknown>>}>("/me/host-sessions"),props.api<{servers:Array<{id:string;name:string;mode:string}>}>("/me/host-servers")]);setOperations(o.operations);setSessions(s.sessions);setSites(h.servers);},[props.api]);
  React.useEffect(()=>{void load();const timer=window.setInterval(()=>void load(),3000);return()=>window.clearInterval(timer);},[load]);
  return <section className="page-section"><div className="page-header"><div><h2 className="page-header-title">Host access</h2><p className="page-header-sub">Durable typed operations and your active or recent SSH sessions.</p></div></div>
    <div className="panel"><h3>Start an authorized session</h3><select value={start.server_id} onChange={e=>setStart({...start,server_id:e.target.value})}><option value="">Select server</option>{servers.map(s=><option key={s.id} value={s.id}>{s.name} ({s.mode})</option>)}</select><select value={start.mode} onChange={e=>setStart({...start,mode:e.target.value})}><option value="read">Read-only shell</option><option value="constrained_shell">Constrained shell</option><option value="full_shell">Full Shell</option><option value="root_access">Root Access</option></select><input placeholder="Reason (optional)" value={start.reason} onChange={e=>setStart({...start,reason:e.target.value})}/><button disabled={!start.server_id} onClick={()=>props.run("Start session",()=>props.api("/me/host-sessions",{method:"POST",body:JSON.stringify(start)}))}>Start session</button></div>
    <h3>Operations</h3><DataTable columns={["tool","status","started","finished","actions"]} rows={operations.map((o)=>({id:String(o.id),tool:String(o.tool_name),status:String(o.status),started:String(o.started_at??o.created_at??"—"),finished:String(o.finished_at??"—"),actions:o.status==="queued"||o.status==="running"?<button onClick={()=>props.run("Cancel operation",()=>props.api(`/me/host-operations/${o.id}/cancel`,{method:"POST"}))}>Cancel</button>:"—"}))}/>
    <h3>Sessions</h3><DataTable columns={["mode","host","status","started","actions"]} rows={sessions.map((s)=>({id:String(s.id),mode:String(s.mode),host:`${s.username}@${s.host}`,status:String(s.status),started:String(s.started_at),actions:["starting","active","disconnected"].includes(String(s.status))?<button onClick={()=>props.run("End session",()=>props.api(`/me/host-sessions/${s.id}/end`,{method:"POST"}))}>End</button>:"—"}))}/>
  </section>;
}

interface WordPressSessionRow {
  server_plugin_id: string; instance_name: string; server_name: string;
  state: "not_connected" | "connected" | "expiring_soon" | "expired";
  expires_at: string | null; last_used_at: string | null; wp_user_name: string | null; roles: string[]; privileged: boolean;
}

const SESSION_STATE_LABELS: Record<WordPressSessionRow["state"], string> = {
  not_connected: "Not connected", connected: "Connected", expiring_soon: "Expires soon", expired: "Expired"
};

// Self-service WordPress login sessions (AB-ELEMENTOR 4.1). The password goes to the
// broker once for a background login and is never stored; only the cookies are kept.
// Two-factor codes are relayed (D6); anything else can use the live browser (D7).
type ConnectStep =
  | { kind: "password"; row: WordPressSessionRow }
  | { kind: "two_factor"; row: WordPressSessionRow; captureId: string; message: string }
  | { kind: "browser"; row: WordPressSessionRow; captureId: string; frame: CaptureFrame };

export function WordPressSessions(props: { api: Api; run: Runner }) {
  const [rows, setRows] = React.useState<WordPressSessionRow[]>([]);
  const [step, setStep] = React.useState<ConnectStep | null>(null);
  const [form, setForm] = React.useState({ username: "", password: "", code: "" });
  const [notice, setNotice] = React.useState("");
  const [problem, setProblem] = React.useState<{ message: string; browser: boolean } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const load = React.useCallback(async () => {
    const body = await props.api<{ sessions: WordPressSessionRow[] }>("/me/wordpress-sessions");
    setRows(body.sessions);
  }, [props.api]);
  React.useEffect(() => { void load(); }, [load]);
  const connected = async (body: { warning?: string }) => {
    setNotice(body.warning ?? "Connected.");
    setStep(null); setProblem(null); setForm({ username: "", password: "", code: "" });
    await load();
  };
  const attempt = async (work: () => Promise<void>) => {
    setBusy(true); setProblem(null);
    try { await work(); }
    catch (err) {
      const body = (err as { body?: { error?: string; message?: string; capture_id?: string; browser_login?: boolean } }).body ?? {};
      if (body.error === "two_factor_required" && body.capture_id && step) {
        setStep({ kind: "two_factor", row: step.row, captureId: body.capture_id, message: body.message ?? "Enter your two-factor code." });
      } else {
        setProblem({ message: err instanceof Error ? err.message : "Could not connect.", browser: body.browser_login === true });
      }
    } finally { setBusy(false); setForm((current) => ({ ...current, password: "", code: "" })); }
  };
  const submitPassword = (row: WordPressSessionRow) => attempt(async () => {
    await connected(await props.api<{ warning?: string }>("/me/wordpress-sessions", {
      method: "POST", body: JSON.stringify({ server_plugin_id: row.server_plugin_id, username: form.username, password: form.password })
    }));
  });
  const submitCode = (captureId: string) => attempt(async () => {
    await connected(await props.api<{ warning?: string }>("/me/wordpress-sessions/two-factor", { method: "POST", body: JSON.stringify({ capture_id: captureId, code: form.code }) }));
  });
  const startBrowser = (row: WordPressSessionRow) => attempt(async () => {
    const body = await props.api<{ capture_id: string; frame: CaptureFrame }>("/me/wordpress-sessions/browser", { method: "POST", body: JSON.stringify({ server_plugin_id: row.server_plugin_id }) });
    setStep({ kind: "browser", row, captureId: body.capture_id, frame: body.frame });
  });
  const disconnect = async (row: WordPressSessionRow) => {
    if (await props.run("Disconnect WordPress session", async () => { await props.api(`/me/wordpress-sessions/${row.server_plugin_id}`, { method: "DELETE" }); })) await load();
  };
  const cancel = () => { setStep(null); setProblem(null); setForm({ username: "", password: "", code: "" }); };
  return <section className="page-section">
    <div className="page-header"><div><h2 className="page-header-title">WordPress Sessions</h2>
      <p className="page-header-sub">Connect your own WordPress login so AI page-builder tools can save draft previews and refresh Elementor after edits. Your password is used to log in and is never stored.</p></div></div>
    {notice ? <div className="inline-notice inline-notice-warning"><span>{notice}</span></div> : null}
    {step ? <div className="panel">
      <h3>Log in to {step.row.server_name} ({step.row.instance_name})</h3>
      {problem ? <div className="inline-notice inline-notice-error"><span>{problem.message}</span>
        {problem.browser ? <button onClick={() => void startBrowser(step.row)}>Log in with browser</button> : null}</div> : null}
      {step.kind === "password" ? <>
        <p className="muted">Sessions last about 14 days. Two-factor codes from Two Factor, Wordfence and WP 2FA are supported; for CAPTCHAs or single sign-on use "Log in with browser".</p>
        <label className="modal-field"><span>WordPress username or email</span><input autoComplete="off" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
        <label className="modal-field"><span>Password</span><input type="password" autoComplete="off" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        <div className="cell-actions">
          <button className="button-primary" disabled={busy || !form.username || !form.password} onClick={() => void submitPassword(step.row)}>Connect</button>
          <button disabled={busy} onClick={() => void startBrowser(step.row)}>Log in with browser</button>
          <button onClick={cancel}>Cancel</button>
        </div>
      </> : null}
      {step.kind === "two_factor" ? <>
        <p className="muted">{step.message}</p>
        <label className="modal-field"><span>Verification code</span><input autoComplete="one-time-code" inputMode="numeric" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
        <div className="cell-actions">
          <button className="button-primary" disabled={busy || !form.code} onClick={() => void submitCode(step.captureId)}>Verify</button>
          <button onClick={() => { void props.api(`/me/login-captures/${step.captureId}`, { method: "DELETE" }).catch(() => undefined); cancel(); }}>Cancel</button>
        </div>
      </> : null}
      {step.kind === "browser" ? <RemoteBrowserCapture api={props.api} captureId={step.captureId} initialFrame={step.frame} mode="auto"
        onDone={(result) => void connected(result as { warning?: string })} onCancel={cancel} /> : null}
    </div> : null}
    <DataTable columns={["server", "status", "wordpress_user", "expires", "actions"]} rows={rows.map((row) => ({
      id: row.server_plugin_id,
      server: `${row.server_name} — ${row.instance_name}`,
      status: SESSION_STATE_LABELS[row.state],
      wordpress_user: row.wp_user_name ? `${row.wp_user_name}${row.roles.length ? ` (${row.roles.join(", ")})` : ""}${row.privileged ? " ⚠ administrator" : ""}` : "—",
      expires: row.expires_at && row.state !== "not_connected" ? new Date(row.expires_at).toLocaleString() : "—",
      actions: <div className="cell-actions">
        <button onClick={() => { setNotice(""); setProblem(null); setStep({ kind: "password", row }); }}>{row.state === "not_connected" ? "Connect" : "Reconnect"}</button>
        {row.state !== "not_connected" ? <button onClick={() => void disconnect(row)}>Disconnect</button> : null}
      </div>
    }))} />
  </section>;
}

export function Operations(props:{api:Api}){
  const[data,setData]=React.useState<{operations:Array<Record<string,unknown>>;backups:Array<Record<string,unknown>>;restores:Array<Record<string,unknown>>;deployments:Array<Record<string,unknown>>;providers:Array<Record<string,unknown>>}>({operations:[],backups:[],restores:[],deployments:[],providers:[]});const[networks,setNetworks]=React.useState<Array<Record<string,unknown>>>([]);const[error,setError]=React.useState("");
  React.useEffect(()=>{void Promise.all([props.api<typeof data>("/admin/recovery"),props.api<{networks:Array<Record<string,unknown>>}>("/admin/networks")]).then(([recovery,network])=>{setData(recovery);setNetworks(network.networks);}).catch(err=>setError(err instanceof Error?err.message:"Failed to load operations"));},[props.api]);
  return<section className="page-section"><div className="page-header"><div><h2 className="page-header-title">Operations & recovery</h2><p className="page-header-sub">Correlated recovery, database, deployment, and multisite activity.</p></div></div>{error?<p className="error-text">{error}</p>:null}
    <h3>Recent operations</h3><DataTable columns={["server_name","tool_name","status","progress","error_code","created_at"]} rows={data.operations.map(row=>({...row,id:String(row.id),progress:JSON.stringify(row.progress??{})}))}/>
    <h3>Backup inventory</h3><DataTable columns={["server_name","kind","status","size_bytes","verified_at","retention_until","created_at"]} rows={data.backups.map(row=>({...row,id:String(row.id)}))}/>
    <h3>Restore history</h3><DataTable columns={["server_name","status","backup_id","rollback_backup_id","created_at","finished_at"]} rows={data.restores.map(row=>({...row,id:String(row.id)}))}/>
    <h3>Deployments</h3><DataTable columns={["server_name","environment","status","provider_reference","created_at","finished_at"]} rows={data.deployments.map(row=>({...row,id:String(row.id)}))}/>
    <h3>Provider health</h3><DataTable columns={["server_name","adapter_id","base_url","api_version","status","last_discovered_at"]} rows={data.providers.map(row=>({...row,id:String(row.id)}))}/>
    <h3>Multisite networks</h3><DataTable columns={["name","domain","base_path","status","servers"]} rows={networks.map(row=>({...row,id:String(row.id),servers:Array.isArray(row.servers)?row.servers.length:0}))}/>
  </section>;
}


export function ServerDetailTabs(props: {
  server: Server;
  groups: Group[];
  users: User[];
  policies: Policy[];
  bindings: Binding[];
  activeTab: "overview" | "plugins" | "capabilities" | "audit";
  onTabChange: (tab: "overview" | "plugins" | "capabilities" | "audit") => void;
  onBack: () => void;
  run: Runner;
  api: Api;
}) {
  const tabs = [
    { id: "overview" as const, label: "Overview" },
    { id: "plugins" as const, label: "Plugins" },
    { id: "capabilities" as const, label: "Capabilities" },
    { id: "audit" as const, label: "Audit" }
  ];
  const [editing, setEditing] = React.useState(false);
  const emptyEdit = (): { name: string; address: string } => ({
    name: props.server.name,
    address: props.server.address
  });
  const [editForm, setEditForm] = React.useState(emptyEdit);
  return (
    <section className="user-detail">
      <header className="user-detail-header">
        <div className="detail-title">
          <button type="button" className="back-button" onClick={props.onBack} aria-label="Back to servers">←</button>
          <div>
            <h2>{props.server.name}</h2>
            <p>{props.server.address}</p>
          </div>
        </div>
        <div className="detail-header-actions">
          <span className={`chip ${statusTone(props.server.status)}`}>{props.server.status}</span>
          {credentialChip(props.server.rest_credential_status)}
          <button type="button" onClick={() => { setEditForm(emptyEdit()); setEditing(true); }}>Edit</button>
        </div>
      </header>
      {editing ? (
        <Modal title="Edit Server" onClose={() => setEditing(false)} wide>
          <Form
            onCancel={() => setEditing(false)}
            onSubmit={async () => {
              const ok = await props.run("Save server", () =>
                props.api(`/admin/servers/${props.server.id}`, {
                  method: "PATCH",
                  body: JSON.stringify(editForm)
                })
              );
              if (ok) setEditing(false);
            }}
          >
            <input placeholder="name" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
            <input placeholder="IP address or hostname" value={editForm.address} onChange={(e) => setEditForm({ ...editForm, address: e.target.value })} />
          </Form>
        </Modal>
      ) : null}
      <div className="tab-rail" role="tablist" aria-label="Selected server sections">
        {tabs.map((tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={props.activeTab === tab.id}
            className={props.activeTab === tab.id ? "active" : ""}
            key={tab.id}
            onClick={() => props.onTabChange(tab.id)}
          >
            <span>{tab.label}</span>
          </button>
        ))}
      </div>
      <div className="tab-body">
        {props.activeTab === "overview" ? <ServerOverview server={props.server} /> : null}
        {props.activeTab === "plugins" ? <ServerPlugins server={props.server} api={props.api} run={props.run} /> : null}
        {props.activeTab === "capabilities" ? <ServerCapabilities server={props.server} api={props.api} run={props.run} /> : null}
        {props.activeTab === "audit" ? <ServerAudit server={props.server} api={props.api} /> : null}
      </div>
    </section>
  );
}

function ServerOverview(props: { server: Server }) {
  return <section className="summary-rows" aria-label="Selected server overview">
    <div className="summary-row"><span>Address</span><strong>{props.server.address}</strong></div>
    <div className="summary-row"><span>Status</span><strong>{props.server.status}</strong></div>
    <div className="summary-row"><span>Enabled plugins</span><strong>{props.server.plugin_count ?? 0}</strong></div>
  </section>;
}

function ServerAudit(props: { server: Server; api: Api }) {
  const [events, setEvents] = React.useState<Array<Record<string, unknown>>>([]);
  React.useEffect(() => { void props.api<{ audit_events: Array<Record<string, unknown>> }>(`/admin/audit-events?server_id=${props.server.id}`)
    .then((body) => setEvents(body.audit_events)); }, [props.api, props.server.id]);
  return <DataTable columns={["event_type", "tool_name", "status", "created_at"]}
    rows={events.map((event) => ({ ...event, id: String(event.id) }))} />;
}

function PluginConfigFields(props: { type: PluginType | undefined; config: Record<string, string>; setConfig: (value: Record<string, string>) => void }) {
  return <>{Object.entries(props.type?.config_schema.properties ?? {}).map(([key, schema]) => {
    const value = props.config[key] ?? (Array.isArray(schema.default) ? schema.default.join("\n") : String(schema.default ?? ""));
    const update = (next: string) => props.setConfig({ ...props.config, [key]: next });
    if (schema.enum) return <label key={key}><span>{schema.title ?? key}</span><select value={value} onChange={(event) => update(event.target.value)}>{schema.enum.map((option) => <option key={option}>{option}</option>)}</select></label>;
    if (schema.type === "array") return <label key={key}><span>{schema.title ?? key}</span><textarea value={value} placeholder="One value per line" onChange={(event) => update(event.target.value)} /></label>;
    if (schema.type === "boolean") return <label key={key} title={schema.description}><input type="checkbox" checked={value === "true"} onChange={(event) => update(event.target.checked ? "true" : "false")} /> {schema.title ?? key}</label>;
    return <label key={key}><span>{schema.title ?? key}</span><input type={schema.type === "integer" ? "number" : key.includes("url") ? "url" : "text"} value={value} onChange={(event) => update(event.target.value)} /></label>;
  })}</>;
}

function BrowserPluginDetail(props: { server: Server; plugin: ServerPlugin; api: Api; run: Runner; onBack: () => void }) {
  const [tab, setTab] = React.useState<"overview" | "sessions" | "artifacts">("overview");
  const [sessions, setSessions] = React.useState<Array<Record<string, unknown>>>([]);
  const [artifacts, setArtifacts] = React.useState<Array<Record<string, unknown>>>([]);
  const [selectedSession, setSelectedSession] = React.useState<Record<string, unknown> | null>(null);
  const [reason, setReason] = React.useState("");
  const load = React.useCallback(async () => {
    const [artifactBody, sessionBody] = await Promise.all([
      props.api<{ artifacts: Array<Record<string, unknown>> }>(`/admin/servers/${props.server.id}/plugins/${props.plugin.id}/artifacts`),
      props.api<{ sessions: Array<Record<string, unknown>> }>(`/admin/servers/${props.server.id}/plugins/${props.plugin.id}/sessions`)
    ]);
    setArtifacts(artifactBody.artifacts); setSessions(sessionBody.sessions);
  }, [props.api, props.server.id, props.plugin.id]);
  React.useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 10000); return () => window.clearInterval(timer); }, [load]);
  const config = props.plugin.config;
  const origins = Array.isArray(config.allowed_origins) ? config.allowed_origins.map(String)
    : typeof config.allowed_origins === "string" ? String(config.allowed_origins).split(/[\n,]/).map((value) => value.trim()).filter(Boolean) : [];
  const activeSessions = sessions.filter((row) => ["opening", "active", "closing"].includes(String(row.status))).length;
  const tabs = [
    { id: "overview" as const, label: "Overview" },
    { id: "sessions" as const, label: activeSessions ? `Sessions · ${activeSessions}` : "Sessions" },
    { id: "artifacts" as const, label: "Artifacts" }
  ];
  return <section className="user-detail">
    <header className="user-detail-header">
      <div className="detail-title">
        <button type="button" className="back-button" onClick={props.onBack} aria-label="Back to plugins">←</button>
        <div><h2>{props.plugin.instance_name}</h2><p>{props.plugin.plugin_name} · {props.server.name}</p></div>
      </div>
      <div className="detail-header-actions">
        <span className={`chip ${statusTone(props.plugin.status)}`}>{props.plugin.status}</span>
        <span className={`chip ${props.plugin.has_active_credential ? "chip-success" : "chip-muted"}`}>{props.plugin.has_active_credential ? "Auth state stored" : "No auth state"}</span>
      </div>
    </header>
    <div className="tab-rail" role="tablist" aria-label="Browser plugin sections">
      {tabs.map((entry) => <button type="button" role="tab" key={entry.id} aria-selected={tab === entry.id}
        className={tab === entry.id ? "active" : ""} onClick={() => setTab(entry.id)}><span>{entry.label}</span></button>)}
    </div>
    <div className="tab-body">
      {tab === "overview" ? <section className="summary-rows" aria-label="Browser plugin overview">
        <div className="summary-row"><span>Base URL</span><strong>{String(config.base_url ?? "—")}</strong></div>
        <div className="summary-row"><span>Allowed origins</span><strong>{origins.length ? origins.join(", ") : "—"}</strong></div>
        <div className="summary-row"><span>Viewport</span><strong>{String(config.viewport_width ?? "—")} × {String(config.viewport_height ?? "—")}</strong></div>
        <div className="summary-row"><span>Artifact retention</span><strong>{config.artifact_retention_seconds ? `${Math.round(Number(config.artifact_retention_seconds) / 3600)} h` : "—"}</strong></div>
        <div className="summary-row"><span>Authentication state</span><strong>{props.plugin.has_active_credential ? "Encrypted, never displayed" : "Not configured"}</strong></div>
        <div className="summary-row"><span>Last probe</span><strong>{props.plugin.last_probe_at ? relativeTime(props.plugin.last_probe_at) : "never"}</strong></div>
      </section> : null}
      {tab === "sessions" ? <div className="plugin-activity">
        <p className="muted">Token-owned contexts expire after five idle minutes and fifteen minutes total.</p>
        <DataTable columns={["status", "current_url", "actor_name", "token_prefix", "last_activity_at", "idle_expires_at", "actions"]}
          rows={sessions.map((row) => ({ ...row, id: String(row.id),
            status: <span className={`chip ${statusTone(String(row.status))}`}>{String(row.status)}</span>,
            actions: ["opening", "active", "closing"].includes(String(row.status)) ? <div className="cell-actions"><button className="button-danger" onClick={() => {
              setSelectedSession(row); setReason(""); }}>Close</button></div> : <span className="muted">History retained</span> }))} />
      </div> : null}
      {tab === "artifacts" ? <div className="plugin-activity">
        <p className="muted">Recent target-scoped screenshots. Artifact bytes remain protected and expire automatically.</p>
        <DataTable columns={["artifact_type", "mime_type", "byte_size", "sha256", "actor_name", "status", "created_at", "expires_at"]}
          rows={artifacts.map((row) => ({ ...row, id: String(row.id), sha256: String(row.sha256).slice(0, 12) }))} />
      </div> : null}
    </div>
    {selectedSession ? <Modal title="Close browser session" onClose={() => setSelectedSession(null)}>
      <p className="config-note">The isolated browser context closes immediately. Session history and artifact metadata are retained.</p>
      <Form submitLabel="Close session" onCancel={() => setSelectedSession(null)} onSubmit={async () => {
        if (!reason.trim()) return;
        const ok = await props.run("Close browser session", () => props.api(`/admin/servers/${props.server.id}/plugins/${props.plugin.id}/sessions/${String(selectedSession.id)}/close`,
          { method: "POST", body: JSON.stringify({ reason: reason.trim() }) }));
        if (ok) { setSelectedSession(null); setReason(""); await load(); }
      }}>
        <textarea required aria-label="Reason for closing session" placeholder="Reason (required)" value={reason} onChange={(event) => setReason(event.target.value)} />
      </Form>
    </Modal> : null}
  </section>;
}

function ServerPlugins(props: { server: Server; api: Api; run: Runner }) {
  const [plugins, setPlugins] = React.useState<ServerPlugin[]>([]);
  const [types, setTypes] = React.useState<PluginType[]>([]);
  const [testingPluginId, setTestingPluginId] = React.useState<string | null>(null);
  const [modal, setModal] = React.useState<"add" | "edit" | "credential" | "disable" | "remove" | "provision" | "deprovision" | null>(null);
  const [selected, setSelected] = React.useState<ServerPlugin | null>(null);
  const [form, setForm] = React.useState({ plugin_key: "wordpress", instance_name: "WordPress", config: { base_url: "https://${server.address}", wordpress_path: "", wp_cli_path: "wp" } as Record<string, string> });
  const [credential, setCredential] = React.useState({ username: "", application_password: "", storage_state: "" });
  const [browserCapture, setBrowserCapture] = React.useState<{ captureId: string; frame: CaptureFrame } | null>(null);
  const [disableReason, setDisableReason] = React.useState("");
  const [removeConfirmed, setRemoveConfirmed] = React.useState(false);
  const [preview, setPreview] = React.useState<{ profile: { username: string; workspaceRoot: string; authorizedKeyPath: string; forceCommand: string; sudoersLines: string[] }; summary: string[] } | null>(null);
  const [bootstrap, setBootstrap] = React.useState({ host: props.server.address, port: 22, username: "root", private_key: "", known_hosts_line: "", host_key_fingerprint: "", use_sudo: false, confirmed: false, reason: "" });
  const [postgresBootstrap, setPostgresBootstrap] = React.useState({ admin_connection_string: "", confirmed: false, reason: "" });
  const [sshActivity, setSshActivity] = React.useState<{ sessions: Array<Record<string, unknown>>; operations: Array<Record<string, unknown>> }>({ sessions: [], operations: [] });
  const [browserDetailId, setBrowserDetailId] = React.useState<string | null>(null);
  const load = React.useCallback(async () => {
    const [instances, catalog] = await Promise.all([
      props.api<{ plugins: ServerPlugin[] }>(`/admin/servers/${props.server.id}/plugins`),
      props.api<{ plugins: PluginType[] }>("/admin/plugins")
    ]);
    setPlugins(instances.plugins); setTypes(catalog.plugins);
    const ssh = instances.plugins.find((plugin) => plugin.plugin_key === "ssh");
    if (ssh) {
      const activity = await props.api<{ sessions: Array<Record<string, unknown>>; operations: Array<Record<string, unknown>> }>(`/admin/servers/${props.server.id}/plugins/${ssh.id}/ssh-activity`);
      setSshActivity(activity);
    } else setSshActivity({ sessions: [], operations: [] });
  }, [props.api, props.server.id]);
  React.useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 10000); return () => window.clearInterval(timer); }, [load]);
  const closeCredential = () => {
    setCredential({ username: "", application_password: "", storage_state: "" });
    setModal(null);
  };
  const openCredential = (plugin: ServerPlugin) => {
    setSelected(plugin);
    setCredential({ username: "", application_password: "", storage_state: "" });
    setModal("credential");
  };
  const testConnection = async (plugin: ServerPlugin) => {
    if (testingPluginId !== null) return;
    setTestingPluginId(plugin.id);
    try {
      const ok = await props.run("Test connection", () => props.api(`/admin/servers/${props.server.id}/plugins/${plugin.id}/test`, { method: "POST" }));
      if (ok) await load();
    } finally {
      setTestingPluginId(null);
    }
  };
  const openProvision = async (plugin: ServerPlugin, mode: "provision" | "deprovision") => {
    setSelected(plugin);
    const body = await props.api<{ preview: typeof preview }>(`/admin/servers/${props.server.id}/plugins/${plugin.id}/provisioning-preview`);
    setPreview(body.preview);
    const host = String(plugin.config.host ?? props.server.address).replaceAll("${server.address}", props.server.address);
    setBootstrap({ host, port: Number(plugin.config.port ?? 22), username: "root", private_key: "", known_hosts_line: "", host_key_fingerprint: "", use_sudo: false, confirmed: false, reason: "" });
    setPostgresBootstrap({ admin_connection_string: "", confirmed: false, reason: "" });
    setModal(mode);
  };
  const browserDetail = plugins.find((plugin) => plugin.id === browserDetailId && plugin.plugin_key === "playwright" && plugin.status !== "removed");
  if (browserDetailId && browserDetail) {
    return <BrowserPluginDetail server={props.server} plugin={browserDetail} api={props.api} run={props.run} onBack={() => setBrowserDetailId(null)} />;
  }
  return <section className="section-stack">
    <PageToolbar count={plugins.length} actions={<button onClick={() => setModal("add")}>+ Add plugin</button>} />
    {modal === "add" ? <Modal title="Add plugin" onClose={() => setModal(null)}>
      <Form onCancel={() => setModal(null)} onSubmit={async () => {
        const ok = await props.run("Add plugin", () => props.api(`/admin/servers/${props.server.id}/plugins`, { method: "POST",
          body: JSON.stringify({ plugin_key: form.plugin_key, instance_name: form.instance_name, config: form.config }) }));
        if (ok) { setModal(null); await load(); }
      }}>
        <select value={form.plugin_key} onChange={(e) => {
          const key = e.target.value;
          setForm(key === "ssh"
            ? { plugin_key: key, instance_name: "SSH", config: { host: "${server.address}", port: "22", username: "aibroker", workspace_root: "/var/www/html" } }
            : key === "postgres"
              ? { plugin_key: key, instance_name: "Postgres", config: { host: "${server.address}", port: "5432", database: "postgres", scoped_role: "aibroker_scoped", allowed_schemas: "public", named_queries: "{}" } }
              : key === "playwright"
                ? { plugin_key: key, instance_name: "Browser", config: { base_url: `https://${props.server.address}`, allowed_origins: `https://${props.server.address}`, allowed_path_prefixes: "", viewport_width: "1440", viewport_height: "900", locale: "en-US", timezone: "UTC", color_scheme: "no-preference", artifact_retention_seconds: "86400" } }
                : { plugin_key: key, instance_name: "WordPress", config: { base_url: "https://${server.address}", wordpress_path: "", wp_cli_path: "wp" } });
        }}>
          {types.map((type) => <option key={type.key} value={type.key}>{type.name}</option>)}
        </select>
        <input placeholder="Instance name" value={form.instance_name} onChange={(e) => setForm({ ...form, instance_name: e.target.value })} />
        <PluginConfigFields type={types.find((type) => type.key === form.plugin_key)} config={form.config} setConfig={(config) => setForm({ ...form, config })} />
      </Form>
    </Modal> : null}
    {(modal === "provision" || modal === "deprovision") && selected && preview ? <Modal title={`${modal === "provision" ? "Provision" : "De-provision"} ${selected.instance_name}`} onClose={() => setModal(null)} wide>
      <div className="inline-notice inline-notice-warning">
        <strong>{modal === "provision" ? "One-time elevated access" : "Elevation is required again"}</strong>
        <span>The bootstrap {selected.plugin_key === "postgres" ? "admin connection string" : "private key"} is used only for this operation and is never stored. Review the system-defined confinement before confirming.</span>
      </div>
      <div className="panel provision-preview">
        <h3>Confinement preview</h3>
        <dl className="summary-rows">
          <div className="summary-row"><span>Dedicated user</span><strong>{preview.profile.username}</strong></div>
          <div className="summary-row"><span>Workspace / ACL root</span><strong>{preview.profile.workspaceRoot}</strong></div>
          <div className="summary-row"><span>Authorized key</span><strong>{preview.profile.authorizedKeyPath}</strong></div>
          <div className="summary-row"><span>Forced command</span><strong>{preview.profile.forceCommand}</strong></div>
          <div className="summary-row"><span>Sudo allow-list</span><strong>{preview.profile.sudoersLines.join(" · ")}</strong></div>
        </dl>
      </div>
      <Form onCancel={() => setModal(null)} onSubmit={async () => {
        const elevated = selected.plugin_key === "postgres" ? postgresBootstrap : bootstrap;
        if (!elevated.confirmed || !elevated.reason.trim()) return;
        const endpoint = modal === "provision" ? "provision" : "deprovision";
        const path = selected.plugin_key === "postgres" ? `postgres-${endpoint}` : endpoint;
        const ok = await props.run(`${modal === "provision" ? "Provision" : "De-provision"} ${selected.plugin_name}`, () =>
          props.api(`/admin/servers/${props.server.id}/plugins/${selected.id}/${path}`, { method: "POST", body: JSON.stringify(elevated) }));
        setBootstrap({ ...bootstrap, private_key: "" });
        setPostgresBootstrap({ ...postgresBootstrap, admin_connection_string: "" });
        if (ok) { setModal(null); await load(); }
      }}>
        {selected.plugin_key === "postgres" ? <>
          <input type="password" required placeholder="One-time admin connection string" value={postgresBootstrap.admin_connection_string} onChange={(e) => setPostgresBootstrap({ ...postgresBootstrap, admin_connection_string: e.target.value })} />
          <textarea required placeholder="Reason (required)" value={postgresBootstrap.reason} onChange={(e) => setPostgresBootstrap({ ...postgresBootstrap, reason: e.target.value })} />
          <label><input type="checkbox" checked={postgresBootstrap.confirmed} onChange={(e) => setPostgresBootstrap({ ...postgresBootstrap, confirmed: e.target.checked })} /> I reviewed and approve this database scope</label>
        </> : <>
        <input placeholder="Bootstrap SSH host" value={bootstrap.host} onChange={(e) => setBootstrap({ ...bootstrap, host: e.target.value })} />
        <input type="number" placeholder="Port" value={bootstrap.port} onChange={(e) => setBootstrap({ ...bootstrap, port: Number(e.target.value) })} />
        <input placeholder="Sudo-capable username" value={bootstrap.username} onChange={(e) => setBootstrap({ ...bootstrap, username: e.target.value })} />
        <textarea required placeholder="One-time bootstrap private key" value={bootstrap.private_key} onChange={(e) => setBootstrap({ ...bootstrap, private_key: e.target.value })} />
        <input required placeholder="Pinned SHA256 host-key fingerprint" value={bootstrap.host_key_fingerprint} onChange={(e) => setBootstrap({ ...bootstrap, host_key_fingerprint: e.target.value })} />
        <textarea required placeholder="Pinned known_hosts entry" value={bootstrap.known_hosts_line} onChange={(e) => setBootstrap({ ...bootstrap, known_hosts_line: e.target.value })} />
        <label><input type="checkbox" checked={bootstrap.use_sudo} onChange={(e) => setBootstrap({ ...bootstrap, use_sudo: e.target.checked })} /> Bootstrap account requires passwordless sudo</label>
        <textarea required placeholder="Reason (required)" value={bootstrap.reason} onChange={(e) => setBootstrap({ ...bootstrap, reason: e.target.value })} />
        <label><input type="checkbox" checked={bootstrap.confirmed} onChange={(e) => setBootstrap({ ...bootstrap, confirmed: e.target.checked })} /> I reviewed and approve this confinement profile</label>
        </>}
      </Form>
    </Modal> : null}
    {modal === "edit" && selected ? <Modal title={`Edit ${selected.instance_name}`} onClose={() => setModal(null)}>
      <Form onCancel={() => setModal(null)} onSubmit={async () => {
        const ok = await props.run("Save plugin", () => props.api(`/admin/servers/${props.server.id}/plugins/${selected.id}`, { method: "PATCH",
          body: JSON.stringify({ instance_name: form.instance_name, config: form.config }) }));
        if (ok) { setModal(null); await load(); }
      }}>
        <input placeholder="Instance name" value={form.instance_name} onChange={(e) => setForm({ ...form, instance_name: e.target.value })} />
        <PluginConfigFields type={types.find((type) => type.key === selected.plugin_key)} config={form.config} setConfig={(config) => setForm({ ...form, config })} />
      </Form>
    </Modal> : null}
    {modal === "credential" && selected && browserCapture ? <Modal title={`Log in · ${selected.instance_name}`} onClose={() => setBrowserCapture(null)}>
      <RemoteBrowserCapture api={props.api} captureId={browserCapture.captureId} initialFrame={browserCapture.frame} mode="manual"
        onDone={() => { setBrowserCapture(null); closeCredential(); void load(); }} onCancel={() => setBrowserCapture(null)} />
    </Modal> : null}
    {modal === "credential" && selected && !browserCapture ? <Modal title={`Credential · ${selected.instance_name}`} onClose={closeCredential}>
      {selected.plugin_key === "playwright" ? <div className="cell-actions">
        <button onClick={() => void props.run("Start browser login", async () => {
          const body = await props.api<{ capture_id: string; frame: CaptureFrame }>(`/admin/servers/${props.server.id}/plugins/${selected.id}/credential/capture`, { method: "POST", body: JSON.stringify({}) });
          setBrowserCapture({ captureId: body.capture_id, frame: body.frame });
        })}>Log in with browser instead</button>
      </div> : null}
      <Form submitLabel={selected.has_active_credential ? "Replace credential" : "Save credential"} onCancel={closeCredential} onSubmit={async () => {
        const ok = await props.run("Save credential", async () => {
          const body = selected.plugin_key === "playwright"
            ? { storage_state: JSON.parse(credential.storage_state) }
            : { username: credential.username, application_password: credential.application_password };
          await props.api(`/admin/servers/${props.server.id}/plugins/${selected.id}/credential`,
            { method: "POST", body: JSON.stringify(body) });
          await load();
        });
        if (ok) closeCredential();
      }}>
        {selected.has_active_credential ? (
          <div className="inline-notice inline-notice-success">
            <strong>Active credential stored</strong>
            <span>Saved {selected.active_credential_created_at ? relativeTime(selected.active_credential_created_at) : "previously"}. Stored credentials are encrypted and never displayed. Enter both fields below only to replace them.</span>
          </div>
        ) : (
          <div className="inline-notice inline-notice-warning">
            <strong>No credential stored</strong>
            <span>{selected.plugin_key === "playwright" ? "Paste administrator-reviewed Playwright storage state. It is encrypted and never displayed or returned to MCP clients." : "Enter a WordPress username and application password. A successful save securely stores a new active credential."}</span>
          </div>
        )}
        {selected.plugin_key === "playwright" ? <label>
          Browser storage state JSON
          <textarea required autoComplete="off" placeholder={'{"cookies":[],"origins":[]}'} value={credential.storage_state} onChange={(e) => setCredential({ ...credential, storage_state: e.target.value })} />
        </label> : <><label>
          WordPress username
          <input required autoComplete="username" placeholder="e.g. admin" value={credential.username} onChange={(e) => setCredential({ ...credential, username: e.target.value })} />
        </label><label>
          Application password
          <input required type="password" autoComplete="off" placeholder="Enter a new application password" value={credential.application_password} onChange={(e) => setCredential({ ...credential, application_password: e.target.value })} />
        </label></>}
      </Form>
    </Modal> : null}
    {modal === "disable" && selected ? <Modal title={`Disable ${selected.instance_name}`} onClose={() => setModal(null)}>
      <p className="config-note">Disabling this plugin immediately removes its tools from MCP clients. Audit history is retained.</p>
      <Form onCancel={() => setModal(null)} onSubmit={async () => {
        if (!disableReason.trim()) return;
        const ok = await props.run("Disable plugin", () => props.api(`/admin/servers/${props.server.id}/plugins/${selected.id}/disable`,
          { method: "POST", body: JSON.stringify({ reason: disableReason.trim() }) }));
        if (ok) { setModal(null); setDisableReason(""); await load(); }
      }}>
        <textarea required placeholder="Reason (required)" value={disableReason} onChange={(e) => setDisableReason(e.target.value)} />
      </Form>
    </Modal> : null}
    {modal === "remove" && selected ? <Modal title={`Remove ${selected.instance_name}`} onClose={() => setModal(null)}>
      <div className="inline-notice inline-notice-warning"><strong>Removal is a retained state, not deletion</strong><span>Tools and active credentials are disabled immediately. Capabilities and audit history remain. Provisioned identities must be de-provisioned first.</span></div>
      <Form onCancel={() => setModal(null)} onSubmit={async () => {
        if (!removeConfirmed || !disableReason.trim()) return;
        const ok = await props.run("Remove plugin", () => props.api(`/admin/servers/${props.server.id}/plugins/${selected.id}/remove`,
          { method: "POST", body: JSON.stringify({ reason: disableReason.trim(), confirmed: true }) }));
        if (ok) { setModal(null); setDisableReason(""); setRemoveConfirmed(false); await load(); }
      }}>
        <textarea required placeholder="Reason (required)" value={disableReason} onChange={(e) => setDisableReason(e.target.value)} />
        <label><input type="checkbox" checked={removeConfirmed} onChange={(e) => setRemoveConfirmed(e.target.checked)} /> I reviewed the dependent credentials, capabilities, and policy references</label>
      </Form>
    </Modal> : null}
    <DataTable columns={["type", "instance", "status", "last probe", "actions"]} rows={plugins.map((plugin) => ({
      id: plugin.id, type: plugin.plugin_name,
      instance: plugin.plugin_key === "playwright" && plugin.status !== "removed"
        ? <button type="button" className="drilldown-link" aria-label={`Open ${plugin.instance_name} browser details`} onClick={() => setBrowserDetailId(plugin.id)}>{plugin.instance_name}</button>
        : plugin.instance_name,
      status: <span className={`chip ${statusTone(plugin.provisioning_status === "provisioned" ? "provisioned" : plugin.status)}`}>{plugin.provisioning_status ?? plugin.status}</span>,
      "last probe": plugin.last_probe_at ? relativeTime(plugin.last_probe_at) : "never",
      actions: plugin.status === "removed" ? <span className="muted">History retained</span> : <div className="cell-actions">
        <button onClick={() => { setSelected(plugin); setForm({ plugin_key: plugin.plugin_key, instance_name: plugin.instance_name, config: Object.fromEntries(Object.entries(plugin.config).map(([key,value]) => [key,String(value ?? "")])) }); setModal("edit"); }}>Edit</button>
        {["wordpress", "playwright"].includes(plugin.plugin_key) ? <button onClick={() => openCredential(plugin)}>{plugin.has_active_credential ? "Replace credential" : "Add credential"}</button> : null}
        {plugin.plugin_key === "ssh" ? <button onClick={() => void openProvision(plugin, "provision")}>{plugin.provisioning_status === "provisioned" ? "Rotate key" : "Provision"}</button> : null}
        {plugin.plugin_key === "ssh" && plugin.provisioning_status === "provisioned" ? <button className="button-danger" onClick={() => void openProvision(plugin, "deprovision")}>De-provision</button> : null}
        {plugin.plugin_key === "postgres" ? <button onClick={() => void openProvision(plugin, "provision")}>{plugin.provisioning_status === "provisioned" ? "Rotate role" : "Provision"}</button> : null}
        {plugin.plugin_key === "postgres" && plugin.provisioning_status === "provisioned" ? <button className="button-danger" onClick={() => void openProvision(plugin, "deprovision")}>De-provision</button> : null}
        <button
          className="test-connection-button"
          aria-busy={testingPluginId === plugin.id}
          disabled={testingPluginId !== null}
          onClick={() => void testConnection(plugin)}
        >
          {testingPluginId === plugin.id ? <><span className="button-spinner" aria-hidden="true" />Testing…</> : "Test connection"}
        </button>
        <button className="button-danger" onClick={() => { setSelected(plugin); setModal("disable"); }}>Disable</button>
        <button className="button-danger" onClick={() => { setSelected(plugin); setDisableReason(""); setRemoveConfirmed(false); setModal("remove"); }}>Remove</button>
      </div>
    }))} />
    {plugins.some((plugin) => plugin.plugin_key === "ssh") ? <div className="plugin-activity">
      <h3>SSH activity</h3>
      <p className="muted">Active and recent confined sessions and commands. Break-glass commands are also flagged in Audit.</p>
      <DataTable columns={["tool_name", "status", "reason", "created_at", "finished_at"]}
        rows={sshActivity.operations.map((row) => ({ ...row, id: String(row.id) }))} />
      <DataTable columns={["mode", "username", "status", "reason", "started_at", "ended_at"]}
        rows={sshActivity.sessions.map((row) => ({ ...row, id: String(row.id) }))} />
    </div> : null}
  </section>;
}


export function ServerCapabilities(props: { server: Server; api: Api; run: Runner }) {
  const [capabilities, setCapabilities] = React.useState<ServerCapability[] | null>(null);
  const [loadError, setLoadError] = React.useState("");
  const [discovering, setDiscovering] = React.useState(false);
  const load = React.useCallback(async () => {
    setLoadError("");
    try {
      const body = await props.api<{ capabilities: ServerCapability[] }>(`/admin/servers/${props.server.id}/capabilities`);
      setCapabilities(body.capabilities);
    } catch (error) {
      setCapabilities([]);
      setLoadError(error instanceof Error ? error.message : "Capabilities could not be loaded.");
    }
  }, [props.server.id, props.api]);
  React.useEffect(() => { void load(); }, [load]);
  const discover = async () => {
    if (discovering) return;
    setDiscovering(true);
    try {
      await props.run("Discover capabilities", async () => {
        const body = await props.api<{ plugins: ServerPlugin[] }>(`/admin/servers/${props.server.id}/plugins`);
        const enabled = body.plugins.filter((plugin) => plugin.status === "enabled");
        if (!enabled.length) throw new Error("Enable and configure a plugin before discovering capabilities.");
        const failures: string[] = [];
        for (const plugin of enabled) {
          try { await props.api(`/admin/servers/${props.server.id}/plugins/${plugin.id}/test`, { method: "POST" }); }
          catch (error) {
            const message = error instanceof Error ? error.message : "Unknown probe error";
            failures.push(`${plugin.instance_name}: ${message}`);
          }
        }
        await load();
        if (failures.length) throw new Error(`Capability discovery failed — ${failures.join("; ")}`);
      });
    } finally {
      setDiscovering(false);
    }
  };
  const exportCapabilities = () => props.run("Export capabilities", async () => {
    if (!capabilities?.length) throw new Error("There are no discovered capabilities to export.");
    const blob = new Blob([JSON.stringify(capabilities, null, 2)], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${props.server.slug}-capabilities.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  });
  return (
    <section className="summary-rows" aria-label="Server capabilities">
      <div className="summary-row">
        <span>Address</span>
        <strong>{props.server.address}</strong>
      </div>
      <div className="server-capabilities" aria-busy={discovering}>
        <div className="server-capabilities-header">
          <div className="server-capabilities-heading"><h3>Discovered capabilities</h3><p className="muted">Probe every enabled plugin and store its current executor capabilities.</p></div>
          <div className="server-capabilities-actions">
            <button disabled={discovering || !capabilities?.length} onClick={() => void exportCapabilities()}>Export JSON</button>
            <button className="discover-capabilities-button" disabled={discovering} onClick={() => void discover()}>
              {discovering ? <><span className="button-spinner" aria-hidden="true" />Discovering…</> : "Discover capabilities"}
            </button>
          </div>
        </div>
        {discovering ? <p className="capability-discovery-status muted" role="status">Testing enabled plugins and refreshing capabilities…</p> : null}
        {capabilities === null ? (
          <p className="muted">Loading…</p>
        ) : loadError ? (
          <div className="inline-notice inline-notice-error"><strong>Capabilities could not be loaded</strong><span>{loadError}</span><button onClick={() => void load()}>Retry</button></div>
        ) : capabilities.length === 0 ? (
          <p className="muted">No capabilities have been discovered yet. Use “Discover capabilities” to probe the enabled plugins.</p>
        ) : (
          <DataTable
            columns={["plugin", "capability", "status", "executor_kind", "discovered_at"]}
            rows={capabilities.map((cap) => ({
              id: `${cap.plugin_key ?? "plugin"}:${cap.instance_name ?? "instance"}:${cap.capability}`,
              plugin: cap.instance_name ?? cap.plugin_key ?? "—",
              capability: cap.capability,
              status: <span className={`chip cap-${cap.status}`}>{cap.status}{cap.stale ? " (stale)" : ""}</span>,
              executor_kind: cap.executor_kind ?? "—",
              discovered_at: relativeTime(cap.discovered_at)
            }))}
          />
        )}
      </div>
    </section>
  );
}


export function ServerBindings(props: {
  server: Server;
  groups: Group[];
  users: User[];
  policies: Policy[];
  bindings: Binding[];
  run: Runner;
  api: Api;
}) {
  const [open, setOpen] = React.useState(false);
  const [binding, setBinding] = React.useState({ subject_type: "user" as "user" | "group", subject_id: "", policy_id: "" });
  const subjects: SelectItem[] = binding.subject_type === "user" ? props.users : props.groups;
  return (
    <section className="binding-tab">
      <div className="tab-actions">
        <div>
          <h3>Bindings</h3>
        </div>
        <button onClick={() => setOpen(true)}>+ Add binding</button>
      </div>
      {open ? (
        <Modal title="Add Binding" onClose={() => setOpen(false)}>
          <Form
            onCancel={() => setOpen(false)}
            onSubmit={async () => {
              const ok = await props.run("Add binding", () =>
                props.api("/admin/bindings", {
                  method: "POST",
                  body: JSON.stringify({
                    subject_type: binding.subject_type,
                    subject_id: binding.subject_id,
                    server_id: props.server.id,
                    policy_id: binding.policy_id
                  })
                })
              );
              if (ok) {
                setBinding({ subject_type: "user", subject_id: "", policy_id: "" });
                setOpen(false);
              }
            }}
          >
            <div className="owner-context"><span>Server</span><strong>{props.server.name}</strong></div>
            <select value={binding.subject_type} onChange={(e) => setBinding({ ...binding, subject_type: e.target.value as "user" | "group", subject_id: "" })}>
              <option value="user">user</option>
              <option value="group">group</option>
            </select>
            <Select value={binding.subject_id} onChange={(subject_id) => setBinding({ ...binding, subject_id })} items={subjects} label={binding.subject_type} />
            <Select value={binding.policy_id} onChange={(policy_id) => setBinding({ ...binding, policy_id })} items={props.policies} label="policy" />
          </Form>
        </Modal>
      ) : null}
      <DataTable
        columns={["subject_type", "subject_name", "policy_name", "actions"]}
        rows={props.bindings.map((item) => ({
          ...item,
          subject_name: item.subject_name ?? item.subject_id,
          actions: (
            <button
              className="button-danger"
              onClick={() =>
                props.run("Remove binding", () =>
                  props.api(`/admin/bindings/${item.id}`, {
                    method: "DELETE",
                    body: JSON.stringify({ reason: "Removed in server bindings" })
                  })
                )
              }
            >
              Remove
            </button>
          )
        }))}
      />
    </section>
  );
}

// Per-user, browser-local map of tokenId -> secret for tokens created in this
// browser. Lets the Client Setup tab offer "select one of your tokens" without the
// server ever returning a stored secret (it can't — secrets are hashed).

export function Tokens(props: {
  user: User;
  users: User[];
  tokens: Token[];
  myTokens: Token[];
  run: Runner;
  api: Api;
  secret: string;
  setSecret: (value: string) => void;
}) {
  const admin = ADMIN_ROLES.includes(props.user.role);
  const tokens = admin ? props.tokens : props.myTokens;
  const [form, setForm] = React.useState({ user_id: "", name: "", expires_at: nextDate() });
  const [open, setOpen] = React.useState(false);
  const createPath = admin ? "/admin/tokens" : "/me/tokens";
  const revokePath = (id: string) => (admin ? `/admin/tokens/${id}/revoke` : `/me/tokens/${id}/revoke`);
  const columns = admin
    ? ["email", "name", "token_prefix", "last_used_at", "expires_at", "revoked_at", "actions"]
    : ["name", "token_prefix", "last_used_at", "expires_at", "revoked_at", "actions"];
  return (
    <section className="page-section">
      <PageToolbar count={tokens.length} actions={<button onClick={() => setOpen(true)}>+ Add token</button>} />
      {open ? (
        <Modal title="Create Token" onClose={() => setOpen(false)}>
          <Form
            onCancel={() => setOpen(false)}
            onSubmit={async () => {
              const ok = await props.run("Create token", async () => {
                if (admin && !form.user_id) throw new Error("Select the user this token belongs to.");
                if (!form.name.trim()) throw new Error("Enter a name for the token.");
                if (!form.expires_at) throw new Error("Choose an expiration date for the token.");
                const body = await props.api<{ token: { id: string }; secret: string }>(createPath, {
                  method: "POST",
                  body: JSON.stringify(admin ? { ...form, name: form.name.trim() } : { name: form.name.trim(), expires_at: form.expires_at })
                });
                props.setSecret(body.secret);
                rememberTokenSecret(props.user.id, body.token.id, body.secret);
              });
              if (ok) setOpen(false);
            }}
          >
            {admin ? <Select value={form.user_id} onChange={(user_id) => setForm({ ...form, user_id })} items={props.users} label="user" /> : null}
            <input placeholder="token name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input type="datetime-local" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} />
          </Form>
        </Modal>
      ) : null}
      {props.secret ? <pre className="secret">New token: {props.secret}</pre> : null}
      <DataTable
        columns={columns}
        rows={tokens.map((token) => ({
          ...token,
          last_used_at: token.last_used_at ? new Date(token.last_used_at).toLocaleString() : "never",
          revoked_at: token.revoked_at ? new Date(token.revoked_at).toLocaleString() : "",
          actions: token.revoked_at
            ? <span className="muted">Revoked</span>
            : <button className="button-danger token-revoke-button" onClick={() => props.run("Revoke token", () => props.api(revokePath(token.id), { method: "POST" }))}>Revoke</button>
        }))}
      />
    </section>
  );
}


export function Policies(props: { policies: Policy[]; bindings: Binding[]; tools: ToolDefinition[]; users: User[]; servers: Server[]; run: Runner; api: Api }) {
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Policy | null>(null);
  const [cloneSource, setCloneSource] = React.useState<Policy | null>(null);
  const [form, setForm] = React.useState({ name: "", description: "" });
  const [pluginTypes, setPluginTypes] = React.useState<PluginType[]>([]);
  const [intents, setIntents] = React.useState<PolicyPluginIntent[]>([]);
  const [unreviewed, setUnreviewed] = React.useState<ToolDefinition[]>([]);
  const [reason, setReason] = React.useState("");
  const [fullConfirmed, setFullConfirmed] = React.useState(false);
  const [preview, setPreview] = React.useState({ user_id: "", server_id: "" });
  const [previewRows, setPreviewRows] = React.useState<Array<{ tool_name: string; instance_name: string; allowed: boolean; reason: string }>>([]);
  const [deleting, setDeleting] = React.useState<Policy | null>(null);
  const [deleteReason, setDeleteReason] = React.useState("");
  const readOnly = Boolean(editing?.built_in);

  const emptyIntent = (plugin: PluginType): PolicyPluginIntent => ({
    plugin_key: plugin.key, instance_name: null, mode: "simple", access_level: "none",
    risk_ceiling: null, grants: {}, denied_tools: [], constraints: {}
  });

  const openEditor = async (policy?: Policy, clone = false) => {
    setEditing(clone ? null : policy ?? null);
    setCloneSource(clone ? policy ?? null : null);
    setForm({ name: clone ? `${policy?.name ?? ""} (copy)` : policy?.name ?? "", description: policy?.description ?? "" });
    setReason("");
    setFullConfirmed(false);
    setPreviewRows([]);
    const [catalog, queue, detail] = await Promise.all([
      props.api<{ plugins: PluginType[] }>("/admin/plugins"),
      props.api<{ tools: ToolDefinition[] }>("/admin/tools/unreviewed"),
      policy ? props.api<{ intents: PolicyPluginIntent[]; permissions: PolicyPermission[] }>(`/admin/policies/${policy.id}`) : Promise.resolve({ intents: [], permissions: [] })
    ]);
    setPluginTypes(catalog.plugins);
    setUnreviewed(queue.tools);
    const baseIntents = new Map(detail.intents.filter((intent) => !intent.instance_name).map((intent) => [intent.plugin_key, intent]));
    setIntents([
      ...catalog.plugins.map((plugin) => baseIntents.get(plugin.key) ?? emptyIntent(plugin)),
      ...detail.intents.filter((intent) => Boolean(intent.instance_name))
    ]);
    setOpen(true);
  };
  const updateIntent = (index: number, update: Partial<PolicyPluginIntent>) => setIntents((current) =>
    current.map((intent, currentIndex) => currentIndex === index ? { ...intent, ...update } : intent));
  const hasFull = intents.some((intent) => intent.access_level === "full" || intent.risk_ceiling === "critical"
    || Object.values(intent.grants).some((actions) => actions.includes("operate")));

  return (
    <section className="page-section">
      <PageToolbar count={props.policies.length} actions={<button onClick={() => void openEditor()}>+ Add policy</button>} />
      {open ? (
        <Modal title={editing ? (readOnly ? `${editing.name} (built-in)` : "Edit Policy") : cloneSource ? "Clone Policy" : "Create Policy"} onClose={() => setOpen(false)} wide>
          <Form
            submitLabel={readOnly ? "Close" : "Save policy"}
            onCancel={() => setOpen(false)}
            onSubmit={async () => {
              if (readOnly) { setOpen(false); return; }
              const ok = await props.run("Save policy", async () => {
                const policy = editing ?? (await props.api<{ policy: Policy }>("/admin/policies", { method: "POST", body: JSON.stringify(form) })).policy;
                if (editing) {
                  await props.api(`/admin/policies/${policy.id}`, { method: "PATCH", body: JSON.stringify(form) });
                }
                if (hasFull && (!fullConfirmed || !reason.trim())) throw new Error("Confirm Full access and enter an audit reason.");
                await props.api(`/admin/policies/${policy.id}/intents`, {
                  method: "PUT",
                  body: JSON.stringify({ intents, ...(reason.trim() ? { reason: reason.trim() } : {}) })
                });
              });
              if (ok) setOpen(false);
            }}
          >
            {readOnly ? (
              <p className="muted">Built-in policies are read-only. Use “Clone” to create an editable copy.</p>
            ) : null}
            <label className="modal-field"><span>Policy name</span><input placeholder="e.g. Content publishers" value={form.name} disabled={readOnly} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="modal-field"><span>Description</span><input placeholder="What this policy is intended to allow" value={form.description} disabled={readOnly} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>

            {unreviewed.length ? <div className="inline-notice inline-notice-warning"><strong>Review required</strong><span>{unreviewed.map((tool) => `${tool.name} (${tool.risk})`).join(", ")} will not be included until reviewed.</span><button type="button" onClick={() => void props.run("Review new tools", async () => { await props.api("/admin/tools/review", { method: "POST", body: JSON.stringify({ tool_names: unreviewed.map((tool) => tool.name) }) }); setUnreviewed([]); })}>Review and include</button></div> : null}

            <div className="policy-personas">{pluginTypes.map((plugin) => {
              const intentIndex = intents.findIndex((item) => item.plugin_key === plugin.key && !item.instance_name);
              const intent = intentIndex >= 0 ? intents[intentIndex]! : emptyIntent(plugin);
              const overrides = intents.map((item, index) => ({ item, index })).filter(({ item }) => item.plugin_key === plugin.key && Boolean(item.instance_name));
              const pluginTools = props.tools.filter((tool) => tool.name.startsWith(`${plugin.key}.`));
              const level = plugin.access_levels?.[intent.access_level];
              return <section className="permission-domain policy-plugin" key={plugin.key}>
                <div className="policy-plugin-head"><div><strong>{plugin.name}</strong><small>{level?.description ?? plugin.description}</small></div><select aria-label={`${plugin.name} access level`} disabled={readOnly} value={intent.access_level} onChange={(event) => { const access = event.target.value as AccessLevel; updateIntent(intentIndex, { access_level: access, mode: "simple", risk_ceiling: plugin.access_levels?.[access].riskCeiling ?? null }); }}>{(["none", "read", "contribute", "manage", "full"] as AccessLevel[]).map((access) => <option value={access} key={access}>{plugin.access_levels?.[access].label ?? access}</option>)}</select>{intent.access_level === "full" ? <span className="risk-badge">critical</span> : null}<button type="button" disabled={readOnly} onClick={() => updateIntent(intentIndex, { mode: intent.mode === "advanced" ? "simple" : "advanced" })}>Advanced {intent.mode === "advanced" ? "▴" : "▾"}</button></div>
                {intent.mode === "advanced" ? <div className="policy-advanced">
                  <label className="modal-field"><span>Risk ceiling</span><select disabled={readOnly} value={intent.risk_ceiling ?? "none"} onChange={(event) => updateIntent(intentIndex, { risk_ceiling: event.target.value === "none" ? null : event.target.value as PolicyPluginIntent["risk_ceiling"] })}><option value="none">None</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label>
                  <div className="advanced-grid">{(plugin.domains ?? []).map((domain) => <div className="advanced-grid-row" key={domain.key}><strong>{domain.label}</strong>{MATRIX_ACTIONS.map((action) => { const exists = pluginTools.some((tool) => tool.domain === domain.key && tool.action === action); const checked = (intent.grants[domain.key] ?? []).includes(action); return <label key={action} className={!exists ? "muted" : ""}><input type="checkbox" disabled={readOnly || !exists} checked={checked} onChange={() => { const current = intent.grants[domain.key] ?? []; updateIntent(intentIndex, { grants: { ...intent.grants, [domain.key]: checked ? current.filter((item) => item !== action) : [...current, action] } }); }} />{ACTION_LABELS[action]}</label>; })}</div>)}</div>
                  <details><summary>Per-tool Deny overrides</summary><div className="permission-tools">{pluginTools.map((tool) => { const denied = intent.denied_tools.includes(tool.name); return <label className="permission-tool" key={tool.name}><code>{tool.name}</code><span>{tool.risk}</span><input type="checkbox" disabled={readOnly} checked={denied} onChange={() => updateIntent(intentIndex, { denied_tools: denied ? intent.denied_tools.filter((name) => name !== tool.name) : [...intent.denied_tools, tool.name] })} /></label>; })}</div></details>
                  <div className="instance-overrides"><strong>Per-instance overrides</strong>{overrides.map(({ item, index }) => <div className="instance-override" key={`${plugin.key}:${index}`}><input aria-label="Instance name" disabled={readOnly} value={item.instance_name ?? ""} placeholder="Exact instance name" onChange={(event) => updateIntent(index, { instance_name: event.target.value })} /><select disabled={readOnly} value={item.access_level} onChange={(event) => { const access = event.target.value as AccessLevel; updateIntent(index, { access_level: access, risk_ceiling: plugin.access_levels?.[access].riskCeiling ?? null }); }}>{(["none", "read", "contribute", "manage", "full"] as AccessLevel[]).map((access) => <option key={access} value={access}>{plugin.access_levels?.[access].label ?? access}</option>)}</select><button type="button" disabled={readOnly} onClick={() => setIntents((current) => current.filter((_, currentIndex) => currentIndex !== index))}>Remove</button></div>)}<button type="button" disabled={readOnly} onClick={() => setIntents((current) => [...current, { ...emptyIntent(plugin), instance_name: `Instance ${overrides.length + 1}` }])}>+ Add instance override</button></div>
                </div> : null}
              </section>;
            })}</div>

            {hasFull ? <div className="inline-notice inline-notice-warning"><strong>Full is break-glass access</strong><span>It may include Operate and critical tools. This grant is recorded as a heightened audit event.</span><label><input type="checkbox" checked={fullConfirmed} disabled={readOnly} onChange={(event) => setFullConfirmed(event.target.checked)} /> I understand the consequences</label></div> : null}

            <section className="policy-preview"><div className="policy-plugin-head"><div><strong>Test policy</strong><small>Preview the effective result for a user and server, including deny reasons.</small></div></div><div className="permission-filters"><Select value={preview.user_id} onChange={(user_id) => setPreview({ ...preview, user_id })} items={props.users} label="user" /><Select value={preview.server_id} onChange={(server_id) => setPreview({ ...preview, server_id })} items={props.servers} label="server" /><button type="button" disabled={!preview.user_id || !preview.server_id} onClick={() => void props.run("Test policy", async () => { const body = await props.api<{ decisions: typeof previewRows }>(`/admin/policy/preview?user_id=${encodeURIComponent(preview.user_id)}&server_id=${encodeURIComponent(preview.server_id)}`); setPreviewRows(body.decisions); })}>Test policy</button></div>{previewRows.length ? <DataTable columns={["instance_name", "tool_name", "allowed", "reason"]} rows={previewRows.map((row, index) => ({ ...row, id: `${row.tool_name}:${index}`, allowed: row.allowed ? "allowed" : "denied" }))} /> : null}</section>

            {!readOnly ? (
              <div className="policy-save-context">
                <span className="muted">Intent is materialized to explicit per-tool rows when saved.</span>
                <label className="modal-field policy-reason"><span className="policy-field-label"><strong>Reason</strong><small>{hasFull ? "Required for Full access" : "Optional · included in audit"}</small></span><input placeholder="Why this policy is changing" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
              </div>
            ) : null}
          </Form>
        </Modal>
      ) : null}
      {deleting ? <Modal title={`Delete ${deleting.name}`} onClose={() => setDeleting(null)}><div className="inline-notice inline-notice-warning">This permanently removes the policy intent and materialized permissions. Audit history is retained.</div><Form submitLabel="Delete policy" onCancel={() => setDeleting(null)} onSubmit={async () => { if (!deleteReason.trim()) throw new Error("Enter a reason for deleting this policy."); const ok = await props.run("Delete policy", () => props.api(`/admin/policies/${deleting.id}`, { method: "DELETE", body: JSON.stringify({ reason: deleteReason.trim() }) })); if (ok) { setDeleting(null); setDeleteReason(""); } }}><label className="modal-field"><span>Reason</span><input value={deleteReason} onChange={(event) => setDeleteReason(event.target.value)} placeholder="Why this policy is being deleted" /></label></Form></Modal> : null}
      <DataTable
        columns={["name", "description", "permission_count", "binding_count", "built_in", "actions"]}
        rows={props.policies.map((policy) => ({
          ...policy,
          built_in: policy.built_in ? "built-in" : "",
          actions: (
            <div className="cell-actions">
              <button onClick={() => void openEditor(policy)}>{policy.built_in ? "View" : "Edit"}</button>
              <button onClick={() => void openEditor(policy, true)}>Clone</button>
              <button
                className="button-danger"
                disabled={policy.built_in || Number(policy.binding_count ?? 0) > 0}
                onClick={() => { setDeleting(policy); setDeleteReason(""); }}
              >
                Delete
              </button>
            </div>
          )
        }))}
      />
    </section>
  );
}


export function UserDetailTabs(props: {
  user: User;
  servers: Server[];
  policies: Policy[];
  bindings: Binding[];
  memberships: GroupMembership[];
  groups: Group[];
  users: User[];
  activeTab: "overview" | "bindings" | "effective";
  onTabChange: (tab: "overview" | "bindings" | "effective") => void;
  onBack: () => void;
  run: Runner;
  api: Api;
}) {
  const tabs = [
    { id: "overview" as const, label: "Overview" },
    { id: "bindings" as const, label: "Bindings", count: props.bindings.length },
    { id: "effective" as const, label: "Effective access" }
  ];
  const [editing, setEditing] = React.useState(false);
  const [editForm, setEditForm] = React.useState({ display_name: props.user.display_name, email: props.user.email, status: props.user.status, role: props.user.role });
  return (
    <section className="user-detail">
      <header className="user-detail-header">
        <div className="detail-title">
          <button type="button" className="back-button" onClick={props.onBack} aria-label="Back to users">←</button>
          <div>
            <h2>{props.user.display_name}</h2>
            <p>{props.user.email}</p>
          </div>
        </div>
        <div className="detail-header-actions">
          <span className={`chip ${statusTone(props.user.status)}`}>{props.user.status}</span>
          <button type="button" onClick={() => { setEditForm({ display_name: props.user.display_name, email: props.user.email, status: props.user.status, role: props.user.role }); setEditing(true); }}>Edit</button>
        </div>
      </header>
      {editing ? (
        <Modal title="Edit User" onClose={() => setEditing(false)}>
          <Form
            onCancel={() => setEditing(false)}
            onSubmit={async () => {
              const ok = await props.run("Save user", () =>
                props.api(`/admin/users/${props.user.id}`, { method: "PATCH", body: JSON.stringify(editForm) })
              );
              if (ok) setEditing(false);
            }}
          >
            <input placeholder="display name" value={editForm.display_name} onChange={(e) => setEditForm({ ...editForm, display_name: e.target.value })} />
            <input placeholder="email" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
            <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}>
              {["active", "invited", "disabled"].map((status) => (<option key={status}>{status}</option>))}
            </select>
            <select value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}>
              {["user", "auditor", "team_admin", "global_admin"].map((role) => (<option key={role}>{role}</option>))}
            </select>
          </Form>
        </Modal>
      ) : null}
      <div className="tab-rail" role="tablist" aria-label="Selected user sections">
        {tabs.map((tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={props.activeTab === tab.id}
            className={props.activeTab === tab.id ? "active" : ""}
            key={tab.id}
            onClick={() => props.onTabChange(tab.id)}
          >
            <span>{tab.label}</span>
            {typeof tab.count === "number" ? <span className="tab-count">{tab.count}</span> : null}
          </button>
        ))}
      </div>
      <div className="tab-body">
        {props.activeTab === "overview" ? <UserOverview user={props.user} users={props.users} memberships={props.memberships} groups={props.groups} /> : null}
        {props.activeTab === "bindings" ? (
          <UserBindings
            user={props.user}
            servers={props.servers}
            policies={props.policies}
            bindings={props.bindings}
            memberships={props.memberships}
            groups={props.groups}
            run={props.run}
            api={props.api}
          />
        ) : null}
        {props.activeTab === "effective" ? <EffectiveAccessPanel users={[props.user]} servers={props.servers} api={props.api} /> : null}
      </div>
    </section>
  );
}


export function UserOverview(props: { user: User; users: User[]; memberships: GroupMembership[]; groups: Group[] }) {
  const groupNames = props.memberships
    .map((membership) => props.groups.find((group) => group.id === membership.group_id)?.name)
    .filter(Boolean)
    .join(", ");
  return (
    <section className="summary-rows" aria-label="Selected user overview">
      <div className="summary-row">
        <span>Role</span>
        <strong>{props.user.role}</strong>
      </div>
      <div className="summary-row">
        <span>Owner</span>
        <strong>{ownerLabel(props.users, props.user.owner_user_id)}</strong>
      </div>
      <div className="summary-row">
        <span>Children</span>
        <strong>{props.user.child_count ?? 0}</strong>
      </div>
      <div className="summary-row">
        <span>Groups</span>
        <strong>{groupNames || "-"}</strong>
      </div>
    </section>
  );
}


export function UserBindings(props: {
  user: User;
  servers: Server[];
  policies: Policy[];
  bindings: Binding[];
  memberships: GroupMembership[];
  groups: Group[];
  run: Runner;
  api: Api;
}) {
  const [open, setOpen] = React.useState(false);
  const [binding, setBinding] = React.useState({ server_id: "", policy_id: "" });
  const groupRows = props.memberships.map((membership) => {
    const group = props.groups.find((candidate) => candidate.id === membership.group_id);
    return {
      id: membership.group_id,
      group: group?.name ?? membership.group_id,
      owner: group?.owner_display_name ?? "-",
      members: group?.member_count ?? "-"
    };
  });
  return (
    <section className="binding-tab">
      <div className="tab-actions">
        <div>
          <h3>Direct server bindings</h3>
        </div>
        <button onClick={() => setOpen(true)}>+ Add direct binding</button>
      </div>
      {open ? (
        <Modal title="Add Direct Binding" onClose={() => setOpen(false)}>
          <Form
            onCancel={() => setOpen(false)}
            onSubmit={async () => {
              const ok = await props.run("Add direct binding", () =>
                props.api("/admin/bindings", {
                  method: "POST",
                  body: JSON.stringify({
                    subject_type: "user",
                    subject_id: props.user.id,
                    server_id: binding.server_id,
                    policy_id: binding.policy_id
                  })
                })
              );
              if (ok) setOpen(false);
            }}
          >
            <Select value={binding.server_id} onChange={(server_id) => setBinding({ ...binding, server_id })} items={props.servers} label="server" />
            <Select value={binding.policy_id} onChange={(policy_id) => setBinding({ ...binding, policy_id })} items={props.policies} label="policy" />
          </Form>
        </Modal>
      ) : null}
      <DataTable
        columns={["server_name", "policy_name", "actions"]}
        rows={props.bindings.map((item) => ({
          ...item,
          actions: (
            <button
              className="button-danger"
              onClick={() =>
                props.run("Remove binding", () =>
                  props.api(`/admin/bindings/${item.id}`, {
                    method: "DELETE",
                    body: JSON.stringify({ reason: "Removed in user bindings" })
                  })
                )
              }
            >
              Remove
            </button>
          )
        }))}
      />
      <div className="tab-actions secondary">
        <div>
          <h3>Group memberships</h3>
        </div>
      </div>
      <DataTable columns={["group", "owner", "members"]} rows={groupRows} />
    </section>
  );
}


export function EffectiveAccessPanel(props: { users: SelectItem[]; servers: Server[]; api: Api }) {
  const [query, setQuery] = React.useState({ user_id: "", server_id: "", tool_name: "wordpress.list_pages" });
  const [result, setResult] = React.useState<EffectiveAccess | null>(null);
  const [error, setError] = React.useState("");
  const users = props.users.filter((user) => user.id);

  React.useEffect(() => {
    setQuery((current) => {
      const next = {
        ...current,
        user_id: current.user_id || users[0]?.id || "",
        server_id: current.server_id || props.servers[0]?.id || ""
      };
      return next.user_id === current.user_id && next.server_id === current.server_id ? current : next;
    });
  }, [props.servers, props.users]);

  return (
    <section className="effective-access-panel">
      <div className="tab-actions">
        <div>
          <h3>Effective access</h3>
        </div>
      </div>
      <div className="effective-access-controls">
        <Select value={query.user_id} onChange={(user_id) => setQuery({ ...query, user_id })} items={users} label="user" />
        <Select value={query.server_id} onChange={(server_id) => setQuery({ ...query, server_id })} items={props.servers} label="server" />
        <select value={query.tool_name} onChange={(event) => setQuery({ ...query, tool_name: event.target.value })}>
          {toolNames.map((tool) => (
            <option key={tool}>{tool}</option>
          ))}
        </select>
        <button
          type="button"
          disabled={!query.user_id || !query.server_id || !query.tool_name}
          onClick={async () => {
            setError("");
            setResult(null);
            try {
              const params = new URLSearchParams(query);
              setResult(await props.api<EffectiveAccess>(`/admin/policy/effective?${params.toString()}`));
            } catch (err) {
              setError(err instanceof Error ? err.message : "Effective access lookup failed");
            }
          }}
        >
          Why?
        </button>
      </div>
      {error ? <p className="error-text">{error}</p> : null}
      {result ? (
        <div className="effective-access-result">
          {(() => {
            const final = result.final ?? (result.decision?.allowed ? "allowed" : result.decision?.reason ?? "denied");
            const allowed = final === "allowed";
            const label: Record<string, string> = {
              allowed: "Allowed",
              not_granted: "Not granted",
              risk_ceiling: "Above risk ceiling",
              constraint_failed: "Denied by constraints",
              policy_denied: "Denied by policy",
              constraint_denied: "Denied by constraints",
              server_disabled: "Server disabled",
              credential_missing: "Allowed by policy — credential missing",
              executor_unavailable: "Allowed by policy — executor unavailable"
            };
            return (
              <p className={`decision-banner ${allowed ? "allowed" : "denied"}`}>
                <strong>{label[final] ?? final}</strong>
                {result.decision?.reason && result.decision.reason !== final ? <span> · policy: {result.decision.reason}</span> : null}
              </p>
            );
          })()}
          {result.tool ? (
            <p className="muted effective-tool-meta">
              {result.tool.domain} / {result.tool.action}
              {result.tool.risk ? ` · risk ${result.tool.risk}` : ""}
              {result.tool.executor_kind ? ` · executor ${result.tool.executor_kind}` : ""}
            </p>
          ) : null}
          {result.connector ? (
            <ul className="connector-availability">
              {result.tool?.name === "host_session_full_shell" && result.decision?.allowed && result.connector.executor_status === "available" ? <li><strong>Full Shell granted</strong></li> : null}
              {result.tool?.name === "host_session_root" && result.decision?.allowed && result.connector.executor_status === "available" ? <li><strong>Root Access granted</strong></li> : null}
              {result.tool?.name?.startsWith("host_session_") && result.decision?.allowed && result.connector.executor_status !== "available" ? <li><strong>Allowed by policy but SSH unavailable</strong></li> : null}
              {result.tool?.name === "host_session_full_shell" && result.connector.connector_mode === "constrained_shell" ? <li><strong>SSH configured as constrained; Full Shell unavailable</strong></li> : null}
              <li>Required executor: <strong>{result.connector.required_executor ?? "—"}</strong> ({result.connector.executor_status})</li>
              <li>
                Required credentials: <strong>{result.connector.required_credentials.length ? result.connector.required_credentials.join(", ") : "none"}</strong>
                {result.connector.credential_status !== "not_required" ? ` (${result.connector.credential_status})` : ""}
              </li>
            </ul>
          ) : null}
          <h4>Bindings considered (deny wins)</h4>
          <DataTable
            columns={["policyName", "subjectType", "effect", "effectiveConstraints"]}
            rows={(result.matched_bindings ?? result.decision?.matchedBindings ?? []).map((binding, index) => ({
              id: String((binding as { bindingId?: string }).bindingId ?? index),
              ...(binding as Record<string, unknown>),
              effectiveConstraints: JSON.stringify((binding as { effectiveConstraints?: Record<string, unknown> }).effectiveConstraints ?? {})
            }))}
          />
        </div>
      ) : null}
    </section>
  );
}


export function Audit(props: { events: AuditEvent[] }) {
  return (
    <DataTable
      columns={["created_at", "event_type", "status", "tool_name", "error_code", "input_summary"]}
      rows={props.events.map((event) => ({ ...event, input_summary: <AuditInputSummary value={event.input_summary} /> }))}
    />
  );
}


export function AuditInputSummary(props: { value: unknown }) {
  const [expanded, setExpanded] = React.useState(false);
  const text = JSON.stringify(props.value, null, 2);
  const long = text.split("\n").length > 5 || text.length > 240;
  return (
    <div className={`audit-input${expanded ? " expanded" : ""}`}>
      <pre className="audit-input-text">{text}</pre>
      {long ? (
        <button type="button" className="audit-input-toggle" onClick={() => setExpanded((current) => !current)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}


// Shorten a User-Agent to a recognizable client label for dense session rows.
function shortClient(ua: string | null | undefined): string {
  if (!ua) return "unknown";
  const first = ua.split(/[\s/]/)[0] ?? ua;
  return first.length > 24 ? `${first.slice(0, 24)}…` : first || "unknown";
}

function mcpStateChip(session: McpSession): React.ReactNode {
  if (session.errors > 0) return <span className="chip chip-danger">Errors</span>;
  if (session.state === "ended") return <span className="chip chip-muted">Ended</span>;
  return <span className="chip chip-success">{session.state === "live" ? "Live" : "Active"}</span>;
}

// Admin-only MCP monitor (Fix C, Phase 1): a live/historical session list that drills
// into a per-session traffic log. Follows uxdesign.md's List → Record-detail recipe;
// composes PageToolbar, the filter card, DataTable, statusTone chips, and AuditInputSummary.
export function Mcp(props: {
  api: Api;
  servers: Server[];
  user: User;
  notify: (text: string, tone?: ToastTone) => void;
}) {
  const [selected, setSelected] = React.useState<string | null>(null);
  const [filters, setFilters] = React.useState({ q: "", tool: "", status: "", server_id: "", from: "", to: "" });
  const [draftQ, setDraftQ] = React.useState("");
  const [sessions, setSessions] = React.useState<McpSession[]>([]);
  const [bodiesCaptured, setBodiesCaptured] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState("");
  const [exporting, setExporting] = React.useState(false);

  const queryString = React.useMemo(() => {
    const params = new URLSearchParams();
    if (filters.q) params.set("q", filters.q);
    if (filters.tool) params.set("tool", filters.tool);
    if (filters.status) params.set("status", filters.status);
    if (filters.server_id) params.set("server_id", filters.server_id);
    if (filters.from) params.set("from", new Date(filters.from).toISOString());
    if (filters.to) params.set("to", new Date(filters.to).toISOString());
    return params.toString();
  }, [filters]);

  const load = React.useCallback(async () => {
    try {
      const data = await props.api<{ sessions: McpSession[]; bodies_captured?: boolean }>(
        `/admin/mcp/sessions${queryString ? `?${queryString}` : ""}`
      );
      setSessions(data.sessions ?? []);
      setBodiesCaptured(Boolean(data.bodies_captured));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      setLoaded(true);
    }
  }, [props.api, queryString]);

  // Auto-refresh the list (live/most-recent first) while it is the visible view.
  React.useEffect(() => {
    if (selected) return;
    let active = true;
    void load();
    const timer = window.setInterval(() => {
      if (active && !document.hidden) void load();
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [selected, load]);

  const download = React.useCallback(
    async (path: string, filename: string) => {
      setExporting(true);
      try {
        const response = await fetch(path, { headers: { "x-aibroker-user-id": props.user.id } });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.message || body.error || `Export failed: ${response.status}`);
        }
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(objectUrl);
        props.notify("Export downloaded", "success");
      } catch (err) {
        props.notify(err instanceof Error ? err.message : "Export failed", "error");
      } finally {
        setExporting(false);
      }
    },
    [props]
  );

  if (selected) {
    return (
      <McpSessionDetail
        api={props.api}
        sessionId={selected}
        user={props.user}
        notify={props.notify}
        download={download}
        exporting={exporting}
        onBack={() => setSelected(null)}
      />
    );
  }

  const activeFilters: Array<{ key: keyof typeof filters; label: string }> = [];
  if (filters.q) activeFilters.push({ key: "q", label: `search: ${filters.q}` });
  if (filters.tool) activeFilters.push({ key: "tool", label: `tool: ${filters.tool}` });
  if (filters.status) activeFilters.push({ key: "status", label: `status: ${filters.status}` });
  if (filters.server_id) {
    const server = props.servers.find((item) => item.id === filters.server_id);
    activeFilters.push({ key: "server_id", label: `server: ${server?.name ?? filters.server_id}` });
  }
  if (filters.from) activeFilters.push({ key: "from", label: `from: ${filters.from.replace("T", " ")}` });
  if (filters.to) activeFilters.push({ key: "to", label: `to: ${filters.to.replace("T", " ")}` });

  return (
    <section className="page-section">
      <div className="page-header">
        <div>
          <h2 className="page-header-title">MCP sessions</h2>
          <p className="page-header-sub">Live and historical MCP client sessions, most recent first.</p>
        </div>
        <span className="page-header-count">{sessions.length} shown</span>
      </div>

      <div className="filter-card">
        <div className="filter-row">
          <input
            className="filter-search"
            placeholder="Search token, owner, IP, user agent…"
            value={draftQ}
            onChange={(event) => setDraftQ(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") setFilters((current) => ({ ...current, q: draftQ.trim() }));
            }}
          />
          <Combobox
            value={filters.tool}
            onChange={(tool) => setFilters((current) => ({ ...current, tool }))}
            placeholder="Any tool"
            allowEmpty
            compact
            options={toolNames.map((name) => ({ value: name, label: name }))}
          />
          <Combobox
            value={filters.status}
            onChange={(status) => setFilters((current) => ({ ...current, status }))}
            placeholder="Any status"
            allowEmpty
            compact
            options={[
              { value: "success", label: "success" },
              { value: "failure", label: "failure" },
              { value: "denied", label: "denied" },
              { value: "errors", label: "errors (failure or denied)" }
            ]}
          />
          <Combobox
            value={filters.server_id}
            onChange={(server_id) => setFilters((current) => ({ ...current, server_id }))}
            placeholder="Any server"
            allowEmpty
            compact
            options={props.servers.map((server) => ({ value: server.id, label: server.name, detail: server.address }))}
          />
        </div>
        <div className="filter-row">
          <label className="filter-date">
            <span>From</span>
            <input type="datetime-local" value={filters.from} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} />
          </label>
          <label className="filter-date">
            <span>To</span>
            <input type="datetime-local" value={filters.to} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} />
          </label>
        </div>
        {activeFilters.length > 0 ? (
          <div className="filter-chips">
            {activeFilters.map((chip) => (
              <button
                key={chip.key}
                type="button"
                className="chip chip-muted filter-chip"
                onClick={() => {
                  if (chip.key === "q") setDraftQ("");
                  setFilters((current) => ({ ...current, [chip.key]: "" }));
                }}
              >
                {chip.label} ✕
              </button>
            ))}
            <button
              type="button"
              className="filter-clear"
              onClick={() => {
                setDraftQ("");
                setFilters({ q: "", tool: "", status: "", server_id: "", from: "", to: "" });
              }}
            >
              Clear filters
            </button>
          </div>
        ) : null}
      </div>

      <PageToolbar
        count={sessions.length}
        actions={
          <button
            type="button"
            disabled={exporting || sessions.length === 0}
            onClick={() =>
              download(
                `/admin/mcp/traffic/export${queryString ? `?${queryString}&` : "?"}format=ndjson`,
                `mcp-traffic-${new Date().toISOString().slice(0, 10)}.ndjson`
              )
            }
          >
            ⬇ Download filtered
          </button>
        }
      />

      {error ? <div className="inline-notice inline-notice-error">{error}</div> : null}
      {loaded && sessions.length === 0 && !error ? (
        <div className="empty-state">No MCP sessions yet. Drive a tool call to see one appear live.</div>
      ) : (
        <DataTable
          columns={["session", "state", "started", "duration", "calls", "error rate", "servers"]}
          rows={sessions.map((session) => ({
            id: session.session_id,
            session: (
              <button type="button" className="link-button mcp-session-link" onClick={() => setSelected(session.session_id)}>
                <span className="mcp-client">{shortClient(session.user_agent)}</span>
                <code> · {session.token_prefix ?? "—"}</code>
                {session.owner_email ? <small className="mcp-owner">{session.owner_email}</small> : null}
              </button>
            ),
            state: mcpStateChip(session),
            started: <span title={session.started_at}>{relativeTime(session.started_at)}</span>,
            duration: formatDuration(session.duration_ms),
            calls: session.calls,
            "error rate": session.calls > 0 ? `${Math.round((session.errors / session.calls) * 100)}%` : "0%",
            servers: session.servers
          }))}
        />
      )}
      {bodiesCaptured ? null : (
        <p className="mcp-capture-note">
          Full-body capture is off — sessions show redacted summaries only. Set{" "}
          <code>AIBROKER_MCP_CAPTURE_BODIES=true</code> to capture full request/response bodies.
        </p>
      )}
    </section>
  );
}


function McpSessionDetail(props: {
  api: Api;
  sessionId: string;
  user: User;
  notify: (text: string, tone?: ToastTone) => void;
  download: (path: string, filename: string) => Promise<void>;
  exporting: boolean;
  onBack: () => void;
}) {
  const [session, setSession] = React.useState<McpSession | null>(null);
  const [events, setEvents] = React.useState<McpTrafficEvent[]>([]);
  const [bodiesCaptured, setBodiesCaptured] = React.useState(false);
  const [paused, setPaused] = React.useState(false);
  const [error, setError] = React.useState("");
  const [revealed, setRevealed] = React.useState<McpTrafficEvent | null>(null);
  const [showExport, setShowExport] = React.useState(false);

  const encodedId = encodeURIComponent(props.sessionId);

  const load = React.useCallback(
    async (since?: string) => {
      try {
        const data = await props.api<{ session: McpSession; events: McpTrafficEvent[]; bodies_captured?: boolean }>(
          `/admin/mcp/sessions/${encodedId}/traffic${since ? `?since=${encodeURIComponent(since)}` : ""}`
        );
        setSession(data.session);
        setBodiesCaptured(Boolean(data.bodies_captured));
        setError("");
        if (since) {
          setEvents((current) => {
            const seen = new Set(current.map((item) => item.id));
            const fresh = (data.events ?? []).filter((item) => !seen.has(item.id));
            return fresh.length ? [...fresh, ...current] : current;
          });
        } else {
          setEvents(data.events ?? []);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load session");
      }
    },
    [props.api, encodedId]
  );

  React.useEffect(() => {
    void load();
  }, [load]);

  // Live-tail ongoing sessions (pause/resume); ended sessions are static.
  React.useEffect(() => {
    if (paused || !session || session.state === "ended") return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void load(events[0]?.created_at);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [paused, session, events, load]);

  const reveal = async (id: string) => {
    try {
      const data = await props.api<{ event: McpTrafficEvent }>(`/admin/mcp/events/${id}`);
      setRevealed(data.event);
    } catch (err) {
      props.notify(err instanceof Error ? err.message : "Reveal failed", "error");
    }
  };

  const ongoing = session ? session.state !== "ended" : false;

  return (
    <section className="user-detail">
      <header className="user-detail-header">
        <div className="detail-title">
          <button type="button" className="back-button" onClick={props.onBack} aria-label="Back to sessions">←</button>
          <div>
            <h2>MCP session</h2>
            <p><code>{session?.token_prefix ?? "—"}</code> · {shortClient(session?.user_agent)}</p>
          </div>
        </div>
        <div className="detail-header-actions">
          {session ? mcpStateChip(session) : null}
          {ongoing ? (
            <button type="button" onClick={() => setPaused((current) => !current)}>
              {paused ? "▶ Resume" : "⏸ Pause"}
            </button>
          ) : null}
          <button type="button" onClick={() => setShowExport(true)} disabled={props.exporting || !session}>⬇ Download</button>
        </div>
      </header>

      {error ? <div className="inline-notice inline-notice-error">{error}</div> : null}

      {session ? (
        <div className="info-card">
          <div className="info-grid">
            <div><span className="info-label">Client IP</span><code>{session.client_ip ?? "—"}</code></div>
            <div><span className="info-label">User agent</span><span className="info-ua">{session.user_agent ?? "—"}</span></div>
            <div><span className="info-label">Token</span><code>{session.token_prefix ?? "—"}</code> {session.owner_email ?? ""}</div>
            <div><span className="info-label">Transport</span>REST</div>
            <div><span className="info-label">Started</span><span title={session.started_at}>{relativeTime(session.started_at)}</span></div>
            <div><span className="info-label">Last seen</span><span title={session.last_seen}>{relativeTime(session.last_seen)}</span></div>
            <div><span className="info-label">Duration</span>{formatDuration(session.duration_ms)}</div>
            <div><span className="info-label">Calls</span>{session.calls} · {session.errors} err · {session.servers} servers</div>
          </div>
        </div>
      ) : null}

      <DataTable
        columns={["created_at", "tool", "status", "duration", "error_code", "payload"]}
        rows={events.map((event) => ({
          id: event.id,
          created_at: <span title={event.created_at}>{relativeTime(event.created_at)}</span>,
          tool: <code>{event.tool ?? "—"}</code>,
          status: <span className={`chip ${statusTone(event.status)}`}>{event.status}</span>,
          duration: formatDuration(event.duration_ms),
          error_code: event.error_code ? <span className="chip chip-danger">{event.error_code}</span> : <span className="cell-empty">—</span>,
          payload: (
            <div className="mcp-payload-cell">
              <AuditInputSummary value={event.input_summary ?? {}} />
              {event.has_body ? (
                <button type="button" className="mcp-reveal" onClick={() => reveal(event.id)}>Reveal full body</button>
              ) : null}
            </div>
          )
        }))}
      />

      {revealed ? (
        <Modal title="Full request / response" onClose={() => setRevealed(null)} wide>
          <div className="mcp-reveal-body">
            {revealed.body == null ? (
              <div className="inline-notice">
                No captured body for this call. Enable <code>AIBROKER_MCP_CAPTURE_BODIES</code> to capture full bodies.
              </div>
            ) : (
              <pre className="audit-input-text mcp-body-pre">{JSON.stringify(revealed.body, null, 2)}</pre>
            )}
          </div>
        </Modal>
      ) : null}

      {showExport ? (
        <McpExportModal
          bodiesCaptured={bodiesCaptured}
          onClose={() => setShowExport(false)}
          onConfirm={async (format, reason) => {
            const suffix = format === "json" ? "json" : "ndjson";
            const reasonParam = reason ? `&reason=${encodeURIComponent(reason)}` : "";
            await props.download(
              `/admin/mcp/sessions/${encodedId}/export?format=${format}${reasonParam}`,
              `mcp-session-${props.sessionId.slice(0, 12)}-${new Date().toISOString().slice(0, 10)}.${suffix}`
            );
            setShowExport(false);
          }}
        />
      ) : null}
    </section>
  );
}


// Export confirmation. A full-body export exposes secrets, so when capture is on it is
// a dangerous/security-sensitive action (uxdesign.md): required reason before download.
// Summary-only exports (capture off) skip the reason.
function McpExportModal(props: {
  bodiesCaptured: boolean;
  onClose: () => void;
  onConfirm: (format: "ndjson" | "json", reason: string) => Promise<void>;
}) {
  const [format, setFormat] = React.useState<"ndjson" | "json">("ndjson");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const needsReason = props.bodiesCaptured;

  return (
    <Modal title="Download session traffic" onClose={props.onClose}>
      <div className="modal-form">
        {props.bodiesCaptured ? (
          <div className="inline-notice inline-notice-warning">
            Full-body capture is on — this export includes request/response bodies (secret-redacted, but sensitive).
            The export is audited.
          </div>
        ) : (
          <div className="inline-notice">Capture is off — this export contains redacted summaries and metadata only.</div>
        )}
        <label className="modal-field">
          <span>Format</span>
          <Combobox
            value={format}
            onChange={(value) => setFormat(value === "json" ? "json" : "ndjson")}
            placeholder="Format"
            options={[
              { value: "ndjson", label: "NDJSON (one event per line)" },
              { value: "json", label: "JSON (header + events[])" }
            ]}
          />
        </label>
        {needsReason ? (
          <label className="modal-field">
            <span>Reason (required)</span>
            <input placeholder="Why are you exporting full bodies?" value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
        ) : null}
        <div className="modal-actions">
          <button type="button" onClick={props.onClose}>Cancel</button>
          <button
            type="button"
            className="button-primary"
            disabled={busy || (needsReason && reason.trim().length === 0)}
            onClick={async () => {
              setBusy(true);
              try {
                await props.onConfirm(format, reason.trim());
              } finally {
                setBusy(false);
              }
            }}
          >
            Download
          </button>
        </div>
      </div>
    </Modal>
  );
}


export function ClientSetup(props: { secret: string; user: User; myTokens: Token[]; defaultServerName: string }) {
  const [tab, setTab] = React.useState<"overview" | "claude-code" | "claude-desktop" | "cursor" | "vscode" | "codex" | "other">("overview");
  const [token, setToken] = React.useState(() => (typeof localStorage !== "undefined" ? localStorage.getItem("wpb:clientToken") : null) ?? props.secret ?? "");
  const [url, setUrl] = React.useState(() => (typeof localStorage !== "undefined" ? localStorage.getItem("wpb:clientUrl") : null) ?? "http://localhost:8080/mcp");
  const [serverName, setServerName] = React.useState(() => (typeof localStorage !== "undefined" ? localStorage.getItem("wpb:clientServerName") : null) ?? props.defaultServerName);

  React.useEffect(() => {
    try { localStorage.setItem("wpb:clientToken", token); } catch { /* ignore */ }
  }, [token]);
  React.useEffect(() => {
    try { localStorage.setItem("wpb:clientUrl", url); } catch { /* ignore */ }
  }, [url]);
  React.useEffect(() => {
    try { localStorage.setItem("wpb:clientServerName", serverName); } catch { /* ignore */ }
  }, [serverName]);

  // Tokens whose secret we still hold in this browser (created here or in the
  // Tokens tab). Selecting one fills the token field without copy-paste.
  const remembered = readTokenSecrets(props.user.id);
  const selectableTokens = props.myTokens.filter((item) => remembered[item.id] && !item.revoked_at);
  const tokenItems = selectableTokens.map((item) => ({ id: item.id, name: `${item.name} · ${item.token_prefix}…` }));
  // Keep the dropdown in sync with the token field: derive the selection from the
  // current token so an auto-filled or pasted secret shows its matching token,
  // and a manually typed one falls back to "select a token".
  const selectedTokenId = selectableTokens.find((item) => remembered[item.id] === token)?.id ?? "";

  const displayToken = token || "AIBROKER_TOKEN";
  const loopbackUrl = url.replace("//localhost", "//127.0.0.1");
  // The dev/smoke REST shim (POST {tool,input}) lives at /mcp/call, not the MCP endpoint.
  const smokeUrl = `${url.replace(/\/mcp(\/call)?\/?$/, "")}/mcp/call`;
  const tabs = [
    { id: "overview" as const, label: "Overview" },
    { id: "claude-code" as const, label: "Claude Code" },
    { id: "claude-desktop" as const, label: "Claude Desktop" },
    { id: "cursor" as const, label: "Cursor" },
    { id: "vscode" as const, label: "VS Code" },
    { id: "codex" as const, label: "Codex" },
    { id: "other" as const, label: "Other" }
  ];

  // The MCP server name is arbitrary and lives only in the client's config, so
  // fall back to the org default (or "aibroker") if the field is blank/invalid.
  const name = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(serverName.trim())
    ? serverName.trim()
    : (props.defaultServerName || "aibroker");
  const httpConfig = JSON.stringify({ type: "http", url, headers: { Authorization: `Bearer ${displayToken}` } }, null, 2);
  const curl = `curl -X POST ${smokeUrl} \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer ${displayToken}' \\
  -d '{"tool":"wordpress.list_sites","input":{"limit":50}}'`;
  const claudeCodeJson = JSON.stringify({
    mcpServers: { [name]: { type: "http", url, headers: { Authorization: `Bearer ${displayToken}` } } }
  }, null, 2);
  const claudeCodeCli = `claude mcp add --transport http ${name} ${url} \\
  --header "Authorization: Bearer ${displayToken}"`;
  const claudeDesktopJson = JSON.stringify({
    mcpServers: {
      [name]: {
        command: "npx",
        args: ["-y", "mcp-remote", loopbackUrl, "--transport", "http-only", "--header", `Authorization: Bearer ${displayToken}`]
      }
    }
  }, null, 2);
  // Cursor uses `mcpServers` with a bare url/headers (no `type` field) for remote servers.
  const cursorJson = JSON.stringify({
    mcpServers: { [name]: { url, headers: { Authorization: `Bearer ${displayToken}` } } }
  }, null, 2);
  // VS Code uses `servers` (not `mcpServers`) and requires `type: "http"` for remote servers.
  const vscodeJson = JSON.stringify({
    servers: { [name]: { type: "http", url, headers: { Authorization: `Bearer ${displayToken}` } } }
  }, null, 2);
  const codexToml = `[mcp_servers.${name}]
url = ${JSON.stringify(url)}
bearer_token_env_var = "AIBROKER_TOKEN"`;
  const codexDirectToml = `[mcp_servers.${name}]
url = ${JSON.stringify(url)}
http_headers = { Authorization = ${JSON.stringify(`Bearer ${displayToken}`)} }`;
  const codexCli = `codex mcp add ${name} --url ${url} --bearer-token-env-var=AIBROKER_TOKEN
export AIBROKER_TOKEN=${displayToken}`;

  return (
    <section className="page-section client-setup">
      <div className="client-setup-intro">
        <h2>Client Integration</h2>
        <p>Client machines receive only a AIBroker token. They never receive WordPress credentials, SSH keys, deploy keys, or WP-CLI config. Enter your token and broker URL, then follow the setup for your client.</p>
      </div>
      <div className="client-setup-creds">
        <label className="client-field">
          <span>Broker URL</span>
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://localhost:8080/mcp" />
        </label>
        <label className="client-field">
          <span>MCP server name</span>
          <input value={serverName} onChange={(event) => setServerName(event.target.value)} placeholder={props.defaultServerName} spellCheck={false} autoCapitalize="none" autoComplete="off" />
          {serverName.trim() && name !== serverName.trim()
            ? <p className="client-note">Invalid name — snippets fall back to “{name}”. Use letters, digits, hyphen, or underscore, starting with a letter or digit.</p>
            : <p className="client-note">The name your client uses to refer to this server. Arbitrary and local to your config.</p>}
        </label>
        <div className="client-field client-field-wide">
          <span>AIBroker token</span>
          <Select
            value={selectedTokenId}
            onChange={(id) => setToken(remembered[id] ?? "")}
            items={tokenItems}
            label="select a token"
          />
          <input value={token} onChange={(event) => setToken(event.target.value)} placeholder="or paste your token" autoComplete="off" />
          {selectableTokens.length === 0 && !token ? <p className="client-note">No token in this browser yet. Create one in the Tokens tab — it is stored only in this browser.</p> : null}
        </div>
      </div>
      <div className="tab-rail" role="tablist" aria-label="Client setup">
        {tabs.map((item) => (
          <button type="button" role="tab" key={item.id} aria-selected={tab === item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <div className="tab-body">
        {tab === "overview" ? (
          <>
            <div className="client-guidance">
              <h3>Using it in your client</h3>
              <p>Once the server is added, your client discovers the WordPress tools automatically — you don’t call them by hand, you just describe the outcome you want.</p>
              <p>A request usually needs to name two things:</p>
              <ul>
                <li><strong>The MCP server</strong> — this connection, by the name in your config (<code>{name}</code>). Only needed to disambiguate when you have more than one MCP server configured.</li>
                <li><strong>The server</strong> — which WordPress target to act on, by its registered name as shown on the <strong>Servers</strong> tab (e.g. <code>server1</code>). Needed whenever your token can reach more than one server; the client looks the name up for you.</li>
              </ul>
              <blockquote>Use the <strong>{name}</strong> MCP server to list the pages on <strong>server1</strong>, then publish the “Pricing” draft.</blockquote>
              <p><strong>Scope:</strong> the tools read server content and create, edit, and publish <strong>pages</strong>. They don’t switch themes, install plugins, or change global server appearance — phrase requests around page content the broker can actually edit.</p>
              <p>The MCP server name <code>{name}</code> is arbitrary and lives only in your client config. If you connect to more than one AIBroker instance, give each a distinct name (e.g. <code>{name}-staging</code> and <code>{name}-prod</code>) so their tools don’t collide — set it in the <strong>MCP server name</strong> field above.</p>
            </div>
            <ConfigBlock title="HTTP MCP endpoint" code={httpConfig} note="The native streamable-HTTP MCP endpoint (POST /mcp) and Bearer token every client below uses." />
            <ConfigBlock title="Smoke test" code={curl} note="A quick check via the dev-only /mcp/call REST shim (not MCP) — should return a JSON list of servers you can reach." />
            <p className="config-note">stdio-only clients (e.g. Claude Desktop) reach the same endpoint through the <code>mcp-remote</code> bridge — see the Claude Desktop tab.</p>
          </>
        ) : null}
        {tab === "claude-code" ? (
          <>
            <ConfigBlock title="Add with the CLI" code={claudeCodeCli} note="Scope defaults to local (~/.claude.json). Use -s user for all projects, or -s project to commit a .mcp.json to a repo." />
            <ConfigBlock title="…or edit the config directly" code={claudeCodeJson} note="Place in ~/.claude.json (local/user) or .mcp.json (project). The type field is required for HTTP servers." />
            <p className="config-note">Verify with `claude mcp list`, or run `/mcp` inside Claude Code. Project-scoped servers need a one-time approval.</p>
          </>
        ) : null}
        {tab === "claude-desktop" ? (
          <>
            <ConfigBlock title="mcp-remote bridge (claude_desktop_config.json)" code={claudeDesktopJson} note="Claude Desktop's config is stdio-only — it cannot take a url/headers directly. This wraps the HTTP endpoint with the mcp-remote bridge." />
            <p className="config-note">Requires Node.js/npx. Edit the config via Settings → Developer → Edit Config, then restart Claude Desktop. Use 127.0.0.1 (not localhost) so the bridge connects to the loopback.</p>
          </>
        ) : null}
        {tab === "cursor" ? (
          <>
            <ConfigBlock title="mcp.json" code={cursorJson} note="Place in ~/.cursor/mcp.json (global) or .cursor/mcp.json in a project. Cursor uses a bare url + headers for remote servers — no type field. Enable it under Cursor Settings → MCP." />
            <p className="config-note">A committed .cursor/mcp.json ships the token to anyone with the repo — prefer the global ~/.cursor/mcp.json, or reference an env var: <code>{"\"Authorization\": \"Bearer ${env:AIBROKER_TOKEN}\""}</code>.</p>
          </>
        ) : null}
        {tab === "vscode" ? (
          <>
            <ConfigBlock title=".vscode/mcp.json" code={vscodeJson} note="Place in .vscode/mcp.json (workspace) or your user config (Command Palette → “MCP: Open User Configuration”). VS Code uses the servers key and requires type: http. Then set Copilot Chat to Agent mode." />
            <p className="config-note">To avoid committing the token, replace it with <code>{"${input:aibroker-token}"}</code> and add an <code>inputs</code> prompt — VS Code asks for the value when the server starts.</p>
          </>
        ) : null}
        {tab === "codex" ? (
          <>
            <ConfigBlock title="Option 1: Store the token directly in ~/.codex/config.toml" code={codexDirectToml} note="Uses a fixed Authorization header, so no environment variable is needed. Replace this server's existing config block and remove bearer_token_env_var if present. The token is stored in plaintext; keep it in your personal config rather than a committed project file." />
            <ConfigBlock title="Option 2: Use an environment variable — CLI setup" code={codexCli} note="Export AIBROKER_TOKEN in the same terminal before starting Codex. An export in another terminal does not update an already-running CLI, desktop app, or IDE." />
            <ConfigBlock title="Environment variable option — ~/.codex/config.toml" code={codexToml} note="Alternative to the CLI setup above. Remove a fixed Authorization header if switching to this option. Codex must inherit AIBROKER_TOKEN when it starts; a plain bearer_token field is not supported." />
            <p className="config-note">Choose one authentication option, restart Codex, then run <code>/mcp</code> to check that the server connected and tools are available.</p>
          </>
        ) : null}
        {tab === "other" ? (
          <>
            <ConfigBlock title="Generic HTTP config" code={httpConfig} note="Any MCP streamable-HTTP client can connect to POST /mcp with the endpoint URL and an Authorization: Bearer header." />
            <ConfigBlock title="Smoke test" code={curl} note="Dev-only /mcp/call REST shim (not MCP) — handy for a quick curl check." />
          </>
        ) : null}
      </div>
    </section>
  );
}


export function ConfigBlock(props: { title: string; code: string; note?: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="config-block">
      <div className="config-block-head">
        <h3>{props.title}</h3>
        <button
          type="button"
          className="copy-button"
          onClick={() => {
            try { navigator.clipboard?.writeText(props.code); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {props.note ? <p className="config-note">{props.note}</p> : null}
      <pre>{props.code}</pre>
    </div>
  );
}


export function UserTree(props: {
  users: User[];
  selectedUserId: string;
  onSelect: (userId: string) => void;
  onOwnerChange: (user: User, ownerUserId: string) => void;
  onMove: (user: User) => void;
  onDisable: (user: User) => void;
}) {
  const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set());
  const rows = flattenUserTree(props.users, collapsed);

  return (
    <section className="user-tree panel-surface">
      <header className="user-tree-header">
        <span>User</span>
        <span>Owner</span>
        <span>Status</span>
        <span>Role</span>
        <span>Children</span>
        <span>Actions</span>
      </header>
      {rows.length === 0 ? (
        <div className="empty-state">No users</div>
      ) : (
        rows.map(({ user, depth }) => {
          const hasChildren = Number(user.child_count ?? 0) > 0;
          const isCollapsed = collapsed.has(user.id);
          return (
            <article className={`user-tree-row ${props.selectedUserId === user.id ? "selected" : ""}`} key={user.id} style={{ "--depth": depth } as React.CSSProperties}>
              <div className="tree-user-cell">
                <button
                  className="tree-toggle"
                  type="button"
                  aria-label={hasChildren ? `${isCollapsed ? "Expand" : "Collapse"} ${user.display_name}` : "No children"}
                  disabled={!hasChildren}
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(user.id)) next.delete(user.id);
                      else next.add(user.id);
                      return next;
                    })
                  }
                >
                  {hasChildren ? (isCollapsed ? "+" : "-") : ""}
                </button>
                <button className="tree-identity" type="button" onClick={() => props.onSelect(user.id)}>
                  <strong>{user.display_name}</strong>
                  <span>{user.email}</span>
                  <small>{ownerPath(props.users, user)}</small>
                </button>
              </div>
              <OwnerSelect
                users={props.users}
                value={user.owner_user_id ?? ""}
                onChange={(ownerUserId) => props.onOwnerChange(user, ownerUserId)}
                label={user.role === "global_admin" ? "Root owner" : "Select owner"}
                excludeUserId={user.id}
                targetRole={user.role}
                disabled={user.role === "global_admin"}
                allowRoot={user.role === "global_admin"}
                compact
              />
              <span>{renderCell(user.status, "status")}</span>
              <span>{renderCell(user.role, "role")}</span>
              <span>{user.child_count ?? 0}</span>
              <span className="row-actions">
                <button disabled={user.role === "global_admin"} onClick={() => props.onMove(user)}>Move</button>
                <button className="button-danger" onClick={() => props.onDisable(user)}>Disable</button>
              </span>
            </article>
          );
        })
      )}
    </section>
  );
}


export function OwnerSelect(props: {
  users: User[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  excludeUserId?: string;
  targetRole?: string;
  disabled?: boolean;
  allowRoot?: boolean;
  compact?: boolean;
}) {
  const options = flattenUserTree(props.users, new Set())
    .filter(({ user }) => user.id !== props.excludeUserId)
    .filter(({ user }) => !props.targetRole || canOwnRoleUi(user.role, props.targetRole))
    .map(({ user, depth }) => ({
      value: user.id,
      label: user.display_name,
      detail: `${user.email} · ${ownerPath(props.users, user)} · ${user.role} · ${user.status}`,
      depth
    }));
  return <Combobox value={props.value} onChange={props.onChange} placeholder={props.label} options={options} compact={Boolean(props.compact)} disabled={Boolean(props.disabled)} allowEmpty={Boolean(props.allowRoot)} />;
}
