// Central navigation access-control map, shared by the app shell (main.tsx) and tests.
//
// Nav visibility mirrors what the API enforces on the backing /admin/* routes, so a tab
// is never shown to a role that would only be denied. Every admin surface currently
// requires an active team_admin or global_admin; adjust a tab's roles here to change both
// the sidebar and which content can render.
export const navItems = [
  "Dashboard",
  "Users",
  "Groups",
  "Servers",
  "Sandbox",
  "Tokens",
  "Policies",
  "Audit Logs",
  "Host Access",
  "Operations",
  "MCP",
  "Client Setup",
  "Settings"
];

export const ADMIN_ROLES = ["team_admin", "global_admin"];

// Every authenticated role, including regular users and auditors, can reach
// self-service surfaces. Client Setup is self-service: it only shows a token the
// operator already holds and per-client setup instructions.
export const ALL_ROLES = ["user", "auditor", "team_admin", "global_admin"];

export const navAccess: Record<string, string[]> = {
  Dashboard: ALL_ROLES,
  Users: ADMIN_ROLES,
  Groups: ADMIN_ROLES,
  Servers: ADMIN_ROLES,
  Sandbox: ADMIN_ROLES,
  Tokens: ALL_ROLES,
  Policies: ADMIN_ROLES,
  "Audit Logs": ADMIN_ROLES,
  "Host Access": ALL_ROLES,
  Operations: ADMIN_ROLES,
  MCP: ADMIN_ROLES,
  "Client Setup": ALL_ROLES,
  Settings: ALL_ROLES
};

export function canAccessNav(item: string | undefined, role: string | undefined): boolean {
  if (!item || !role) return false;
  return (navAccess[item] ?? []).includes(role);
}
