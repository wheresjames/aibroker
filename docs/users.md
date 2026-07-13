# User Ownership Tree

This document describes the user ownership tree and the UI behavior for creating,
editing, and moving users under an owner. It avoids real user data and uses generic terms
only.

## Conceptual Model

The user ownership model is a directed tree.

Each user can have:

- One direct owner, also called the parent user.
- Zero or more directly owned users, also called child users.
- Any number of indirect descendants through their child users.

The top of the tree is a root owner. A root owner has no parent. A tenant, account, or
workspace may have one or more root owners depending on product policy, but each connected
ownership tree must remain acyclic.

Ownership is not the same as authentication. A user signs in as themselves. Ownership
defines who can organize, supervise, administer, or act on a user record within the
allowed permission model.

Ownership is also not the same as a role. Roles define what actions a user can perform.
Ownership defines where the user sits in the hierarchy and which users are in their
scope.

## Owner Eligibility And Page Access

Ownership is restricted to administrative roles:

- Only `team_admin` and `global_admin` users may own users. A `user` or `auditor` can
  never appear as the direct owner of another user, so every non-root branch of the tree
  is anchored by a team admin or global admin.
- `global_admin` users are the only root owners. They have no parent (`owner_user_id` is
  null). See [Ownership Tree Rules](#ownership-tree-rules).
- Only `team_admin` and `global_admin` users can see the users page and the ownership
  tree. All `/admin/users` endpoints require an active team admin or global admin; other
  roles receive an authorization error and never load user records.

An owner must therefore always outrank or equal the user it owns, and must itself be an
administrative role. A team admin may own users, auditors, and other team admins within
its scope; a global admin may own any non-root user.

## Ownership Tree Rules

The tree must follow these rules:

- A user cannot own themselves.
- A user cannot be moved under one of their descendants.
- Only `team_admin` and `global_admin` users can be owners. A move or create that would
  place a user under a non-admin owner must be rejected.
- A user can have only one direct owner at a time.
- Moving a user moves the user's entire subtree with them.
- Moving a user must not change that user's authentication credentials.
- Moving a user must not silently grant new roles.
- Removing an owner should require an explicit replacement owner or a deliberate move to
  root, depending on product policy.
- Disabled users should remain visible in the tree when they still own active
  descendants.
- Deleted users should not leave orphaned active descendants. Reassign descendants before
  deletion or convert the deleted user into a retained tombstone node.

The system should validate ownership changes on the server even when the UI prevents
invalid moves.

## Scope And Permissions

Permissions should be evaluated from both role and ownership scope.

A user can manage another user only when all of these are true:

- The acting user has a role that allows user management.
- The target user is inside the acting user's allowed ownership scope, or the acting user
  has global user-management permission.
- The requested change is allowed for the target user's current and new owner.
- The action does not violate tree rules.

Common ownership-aware permissions:

| Permission | Meaning |
|---|---|
| View users | See users in the allowed tree scope. Restricted to team admins and global admins. |
| Create users | Add users under an owner in the allowed tree scope. |
| Edit users | Change profile and administrative fields for users in scope. |
| Move users | Reassign a user's owner within allowed tree scope. |
| Disable users | Disable users in scope without deleting the ownership record. |
| Manage roles | Change role assignments for users in scope. |
| Global manage users | Manage users across all ownership roots. |

Role changes should be treated separately from ownership moves. Moving a user under a new
owner should update the tree position only. If the move also requires role changes, the UI
should show those changes explicitly before saving.

## Policies, Groups, And Bindings

Tool access is granted through policies and bindings, not through user ownership.

- A policy defines allowed and denied tools.
- A group collects users for operational access.
- A server binding attaches one policy to one group or direct user for one server.

The normal operator flow is: create or choose a policy, create or choose a group, add users to the group, bind the group to a server, and choose the policy for that server. Direct user bindings are available for exceptions but should not replace group-based administration.

Ownership still governs who may administer users, groups, and bindings. A team admin can manage users and bindings inside their ownership subtree; a global admin can manage the full model.

## Data Model

At minimum, user ownership needs these fields:

- `id`: stable user identifier.
- `owner_user_id`: nullable parent user identifier.
- `display_name`: user-facing name.
- `email`: normalized unique email or login identifier.
- `status`: active, invited, disabled, or deleted.
- `created_at`: creation timestamp.
- `updated_at`: last update timestamp.

For stronger auditability, ownership should be tracked in a history table:

- `user_id`: moved user.
- `previous_owner_user_id`: owner before the change.
- `new_owner_user_id`: owner after the change.
- `changed_by_user_id`: actor who made the change.
- `reason`: required for administrative moves.
- `created_at`: timestamp.

The current owner can be stored directly on the user record for fast reads. The history
table preserves who moved the user, when, and why.

## Tree Display

The primary user-management screen should include a tree view.

Tree rows should show:

- Expand/collapse control when the user has children.
- User name and email.
- Status chip.
- Role or permission summary.
- Direct child count.
- Warning indicators for disabled owners, pending invites, or policy conflicts.
- Row actions such as view, edit, move, disable, or remove.

The tree should support:

- Expanding and collapsing branches.
- Search by name or email.
- Filtering by status, role, or owner.
- Highlighting the selected user.
- Showing breadcrumbs from the root to the selected user.
- Loading large trees incrementally.

Search results should preserve ownership context. If a matching user is nested several
levels deep, show enough ancestors to explain where the user lives in the tree.

## Creating Users In The Tree

The UI should create users under a selected owner.

Recommended flow:

1. The operator selects an owner row in the tree.
2. The operator clicks `Add user`.
3. A modal opens with the selected owner shown at the top.
4. The operator enters the user's identity fields and initial role.
5. The operator confirms the owner assignment.
6. The system creates the user with `owner_user_id` set to the selected owner.
7. The new user appears as a child under that owner.

The create modal should include:

- Name.
- Email or login identifier.
- Initial status or invite option.
- Initial roles.
- Owner field.
- Reason field when required by policy.

The owner field should not be hidden. Even when opened from an owner row, show the owner
as a visible selector so the operator understands where the user will be created.

If the operator changes the owner before saving, the owner selector should use the same
validation as the move flow. The UI should prevent selecting owners outside the operator's
allowed scope.

After creation, the tree should expand the owner branch, select the new user, and show a
success toast or inline confirmation.

## Editing Users

Editing a user should happen from the selected user's detail panel or edit modal.

Editable fields can include:

- Name.
- Email or login identifier.
- Status.
- Roles.
- Owner.
- Notes or reason, when required.

Ownership should be visually separated from profile fields. The owner field changes the
tree position and should be treated as a structural change.

When the owner is changed from the edit modal:

- Show the current owner.
- Show the proposed new owner.
- Warn that the user's subtree will move with the user.
- Require confirmation for users with child users.
- Require a reason for administrative reassignment.
- Save through the same endpoint and validation as the dedicated move action.

If the selected user has descendants, the edit UI should show the descendant count near
the owner field. This prevents accidental movement of a large subtree.

## Moving Users Under An Owner

The primary ownership-editing interaction is moving a user under a different owner in the
tree.

Supported UI patterns:

- Drag a user row onto an owner row.
- Use a row action named `Move`.
- Use the owner selector in the edit modal.

Drag and drop is efficient for experienced operators, but it must not be the only way to
move a user. Keyboard and screen-reader users need the `Move` action and owner selector.

### Drag And Drop Move Flow

Recommended drag flow:

1. The operator starts dragging a user row.
2. The dragged row shows a compact preview with the user's name and subtree count.
3. Valid owner targets are highlighted.
4. Invalid targets are visibly disabled.
5. Dropping on a valid owner opens a confirmation popover or modal.
6. The confirmation shows the user, current owner, new owner, and descendant count.
7. The operator confirms the move.
8. The server validates the move and saves it.
9. The tree updates the user's position under the new owner.

Invalid drop targets include:

- The dragged user.
- Any descendant of the dragged user.
- Any user that is not a team admin or global admin, since only those roles can own users.
- Users outside the operator's allowed scope.
- Disabled users that cannot own active users.
- Any owner that would violate policy limits.

Dropping on an invalid target should not change data. Show a clear inline message or
toast explaining why the move is unavailable.

### Move Action Flow

The row action flow should be available from every user row.

Recommended flow:

1. The operator clicks `Move`.
2. A modal opens with the selected user locked as the moved user.
3. The operator searches for a new owner.
4. The modal shows eligible owners only, or clearly marks ineligible owners.
5. The operator selects a new owner.
6. The modal shows a before-and-after summary.
7. The operator enters a reason when required.
8. The operator confirms the move.

The move modal should include:

- Moved user.
- Current owner.
- New owner.
- Descendant count.
- Policy warnings.
- Reason field.
- Cancel button.
- Confirm move button.

The confirm button should remain disabled until a valid new owner is selected.

### Owner Selector Behavior

The owner selector should support:

- Search by name or email.
- Browsing the tree.
- Showing owner path, such as root owner → team owner → direct owner.
- Excluding invalid owners, including any candidate that is not a team admin or global
  admin.
- Showing status and role context for each candidate owner.

When possible, prefer a tree-aware combobox over a flat select. A flat list makes it too
easy to choose the wrong owner when names are similar.

## Server-Side Move Validation

The server must validate every move.

Required checks:

- Acting user is authenticated.
- Acting user has permission to move users.
- Moved user exists.
- New owner exists, unless moving to root is explicitly allowed.
- New owner is a `team_admin` or `global_admin`. Non-admin owners are rejected.
- Moved user and new owner are in the acting user's allowed scope.
- New owner is not the moved user.
- New owner is not a descendant of the moved user.
- Moving the subtree does not exceed depth, size, or policy limits.
- Required reason is present.

The server should perform the move in a transaction:

1. Lock the moved user row.
2. Lock or validate the new owner row.
3. Check for cycles.
4. Update `owner_user_id`.
5. Insert an ownership-history row.
6. Insert an audit event.
7. Commit.

If validation fails, return an error that the UI can show near the owner field or move
confirmation.

## Audit And History

Ownership changes should always be auditable.

Record:

- Moved user.
- Previous owner.
- New owner.
- Acting user.
- Reason.
- Timestamp.
- Request metadata when available.

The user detail page should include an ownership history section showing recent moves.
Each row should show when the move happened, who performed it, the previous owner, the new
owner, and the reason.

Do not rely on toast history for ownership history. Toasts are temporary session feedback.
Ownership history is durable operational data.

## Edge Cases

Self move:

- Block the action.
- Explain that a user cannot own themselves.

Cycle creation:

- Block the action.
- Explain that a user cannot be moved under one of their own descendants.

Moving a root owner:

- Require elevated permission.
- Warn that the entire root subtree will move.

Moving a user with descendants:

- Show descendant count.
- Confirm that the subtree will move.

Deleting an owner:

- Require reassignment of child users first, or convert the deleted owner to a retained
  inactive node.

Disabling an owner:

- Keep the owner visible if active children remain.
- Warn operators that child users are still below the disabled owner.

Concurrent moves:

- Use transactions and row locks.
- If the tree changed while a modal was open, ask the operator to review the latest owner
  path before confirming.

## UI Safety Rules

The ownership UI should follow these rules:

- Always show the current owner before editing ownership.
- Always show the new owner before saving ownership.
- Make subtree movement explicit.
- Provide drag-and-drop and non-drag alternatives.
- Disable invalid drop targets.
- Require confirmation for moves with descendants.
- Require a reason for administrative ownership changes.
- Never infer role changes from tree moves unless the UI shows them explicitly.
- Validate all moves on the server.
- Write ownership history and audit records for every successful move.
