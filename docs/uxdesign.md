# UI Design Guide

This guide describes the reusable design rules for building a compatible application UI. It is intentionally product-agnostic: use these patterns for portals, dashboards, admin tools, account areas, and other dense operational interfaces.

## Design Character

The interface should feel quiet, precise, and work-focused. It is not a marketing server. Prioritize scanability, stable layouts, readable tables, clear actions, and predictable navigation over decorative composition.

Use compact spacing, restrained color, rectangular panels, and direct labels. The UI should make repeated operational work fast: filtering, reviewing status, drilling into details, editing records, and confirming risky actions.

## Color System

Use a dark-first theme with a light theme alternative. Define colors as semantic tokens rather than one-off values.

Core tokens:

- `background`: page background.
- `body-gradient`: subtle top wash over the page background.
- `foreground`: primary text.
- `muted`: secondary text, labels, descriptions, timestamps, inactive navigation.
- `panel`: card, modal, table, and sidebar surfaces.
- `input`: input and textarea backgrounds.
- `line`: default borders and separators.
- `line-strong`: emphasized borders and hover borders.
- `accent`: primary brand/action color.
- `accent-strong`: stronger accent for secondary action text.
- `accent-fg`: text on accent-filled controls.
- `focus-ring`: translucent accent ring for focused controls.
- `nav-bg`: sticky or prominent navigation background.
- `hover-overlay`: low-contrast hover fill.

Recommended dark palette:

- Background: near-black blue, around `#080c14`.
- Panel: slightly lighter navy, around `#0f1520`.
- Foreground: pale blue-gray, around `#ddeaf2`.
- Muted: desaturated blue-gray, around `#7890a8`.
- Borders: dark blue-gray, around `#1c2c44`.
- Accent: dark cool blue, around `#2b6cb0`.

Recommended light palette:

- Background: pale blue-gray, around `#eef3fa`.
- Panel and input: white.
- Foreground: dark blue, around `#0f1e30`.
- Muted: medium blue-gray, around `#4a6882`.
- Borders: pale blue-gray, around `#c8d8ea`.
- Accent: deep cool blue, around `#1e4f8a`.

Status colors:

- Success/ok: green, used for active, verified, completed, provisioned, resolved, succeeded.
- Warning: amber, used for pending, open, waiting, admin attention, unverified.
- Failure/danger: red, used for failed, rejected, canceled, unpaid, disabled, destructive actions.
- Muted: neutral, used for unknown, empty, none, draft, informational states.

Avoid large saturated fields. Accent color should guide attention, not dominate the page.

## Typography

Use a system sans-serif stack such as Arial, Helvetica, sans-serif. Keep letter spacing at `0` for normal headings and body text.

Sizing:

- Page hero headings: about `42px`, only on public/login/signup style pages.
- Admin/account page headings: about `22px`.
- Section/card headings: `14px` to `16px`, semibold.
- Table body and account rows: `14px`.
- Metadata, timestamps, helper text: `12px` to `13px`.
- Table headers and sidebar labels: `11px`, uppercase, semibold, with slight positive letter spacing.

Body text uses generous line height around `1.6` on public pages and tighter metadata line heights in dense admin views.

## Layout

Use two main layout modes.

### Public And Authentication Pages

Use a centered main container with max width around `1120px`, responsive horizontal padding, and generous vertical padding.

For login, signup, password reset, checkout, and similar flows:

- Use a two-column hero layout on desktop.
- Left column contains a clear page title and short explanatory copy.
- Right column contains a bordered panel with the form.
- Collapse to one column on small screens.
- Keep form fields stacked with consistent spacing.
- Put secondary links below the form.

The form panel is a practical card, not a decorative hero card. Border radius should be modest, about `8px`.

### Application Pages

Use a persistent sidebar plus a main content area.

Sidebar:

- Fixed width around `196px`.
- Left side of the viewport.
- Right border separator.
- Small uppercase section label at the top.
- Vertical nav links with active state.
- Theme selector or global preference controls at the bottom.
- Account actions at the bottom: the "Sign out" button below the theme selector,
  separated by a top border. Profile and password changes live on a dedicated Settings
  page (see Account And Settings Screens), not in the sidebar.
- On narrow screens (below the tablet breakpoint) the sidebar collapses off-canvas and a
  hamburger button in the topbar toggles it as an overlay drawer with a dimmed backdrop;
  selecting a nav item or clicking the backdrop closes it. See Responsive Behavior.

Nav visibility is role-scoped: regular users and auditors see only self-service surfaces
(Dashboard, Tokens, Client Setup); admin areas (Users, Groups, Servers, Policies,
Audit Logs) are hidden from roles that the backing API would deny.

Theme selector:

- The current theme modes are `auto`, `light`, and `dark`.
- `auto` is the default and follows the browser or OS `prefers-color-scheme` value.
- Explicit `light` and `dark` selections are saved in `localStorage` under `zetsec:theme`.
- Choosing `auto` removes the stored override.
- The active mode is applied to `html[data-theme]` as `auto`, `light`, or `dark`.
- A small boot script should set `html[data-theme]` before the app renders so the page
  does not flash the wrong theme.
- The selector appears in the public top navigation for signed-out users and at the
  bottom of account/admin sidebars for signed-in users.
- In sidebars, place it below the navigation stack with a top border and compact padding.
- In the public nav, keep it inline with the other nav controls on desktop and full-width
  on mobile when the nav wraps.

Theme selector combobox:

- Prefer a compact combobox with an icon, label, selected value, and chevron over a plain
  native select when custom controls are available.
- The collapsed trigger should show a leading mode icon, the text value, and a trailing
  chevron. Use "Auto", "Light", and "Dark" as the visible values.
- Recommended icons are monitor or spark/screen for `auto`, sun for `light`, and moon for
  `dark`. Use the project's icon system; do not draw custom SVGs by hand when a matching
  library icon exists.
- The trigger should visually match small form controls: about `34px` high, `6px` radius,
  `line` border, `panel` background, muted text by default, and foreground text on hover.
- Keep the label "Theme" visible when the selector has room, especially in sidebars. If
  space is tight, keep the accessible name as `aria-label="Theme"` and let the icon/value
  carry the visible control.
- Opening the combobox shows the three modes as a compact menu. Each option includes the
  same icon used in the trigger, the mode name, and a check mark for the selected mode.
- The menu should align to the trigger edge, use `panel` background, `line` border, `6px`
  radius, and enough shadow or contrast to separate it from the page without looking like
  a large modal.
- Hover and active option states use `hover-overlay`; focus uses the standard accent
  border and `focus-ring`.
- Keyboard behavior should match normal combobox expectations: `Enter` or `Space` opens,
  arrow keys move through options, `Enter` selects, and `Escape` closes without changing
  the value.
- Selection should update `html[data-theme]` immediately and persist or clear
  `localStorage` using the rules above.
- Do not add explanatory copy beside the control. The selector should feel like a small
  global preference, not a settings panel.

Content:

- Main content uses `32px` vertical padding and responsive horizontal padding clamped
  between `20px` and `40px` on desktop.
- Content should allow horizontal overflow for wide tables.
- Keep page headers, tabs, filters, cards, and tables aligned to the same content column.
- Avoid nested cards. A table panel may have a header; cards may contain rows; do not put decorative cards inside decorative cards.
- Let the nearest layout container own spacing. A page stack, tab body, panel body, or
  modal body supplies the gap between its children; children should not add compensating
  top or bottom margins.

On mobile, public pages collapse first. For dense application pages, preserve content usability with horizontal scrolling where tables cannot be simplified safely.

## Navigation

Use three levels of navigation:

1. Sidebar for major product areas.
2. Tabs for queues or subsections inside a major area.
3. Row links or action buttons for record-level movement and actions.

Sidebar links:

- Muted by default.
- Foreground text on hover/active.
- Accent-colored left border for hover/active.
- Subtle hover overlay.

Tabs:

- Use a horizontal tab rail with a bottom border.
- Active tab uses accent text and accent bottom border.
- Tabs may include small count pills.
- If there are many tabs, make the rail horizontally scrollable with scroll buttons.
- Use tabs for sibling views of the same object or queue, not for unrelated app areas.

Logout button:

- In this app the logout control lives in the sidebar footer below the theme selector.
  Profile and password changes live on a dedicated Settings page, not in the sidebar.
  A global top-nav placement is an acceptable alternative where the shell has a signed-in
  user area.
- Use the visible label "Sign out".
- Style it as a compact secondary button: about `32px` minimum height, `13px` text, and
  horizontal padding around `12px`.
- For admin sessions, show the muted uppercase "Admin" user label immediately before the
  sign-out form so the user can tell they are leaving the admin surface.
- Customer sessions do not need a user label in the top nav unless the design later adds
  identity display; keep the sign-out button compact.
- Signed-out users should not see a logout button. They should see the public navigation
  and theme selector instead.
- The button submits a `POST`, never a link-style `GET`.
- Customer logout posts to `/api/auth/logout`; admin logout posts to `/api/admin/logout`.
- Include the CSRF hidden field in the form.
- On success, customer logout redirects to `/login`; admin logout redirects to
  `/admin/login`.
- Logout clears the active session and records an audit event when a signed-in actor is
  available.
- Do not ask for confirmation for single-session logout. It is reversible by signing in
  again.
- Use confirmation only for "Sign out all sessions", which belongs in the Security area
  as a dangerous account action.

Change password:

- Available to every signed-in user as a self-service action on the Settings page
  (Security section). It is not admin-gated.
- The form takes current password, new password, and confirm, with a strength meter, and
  posts to `/auth/change-password` which verifies the current credential, enforces the
  password policy, and rejects a new password equal to the current one.
- The same form is reused for the forced first-login change (full page) and the Settings
  page; only the surrounding chrome differs.
- On create, an admin sets a temporary password; the new user row is marked
  `password_change_required = true` so the first login forces the change page before the
  workspace is reachable. Surface a helper note on the create form that the password is
  temporary and must be changed at first login.
- Record a `admin_password_change` audit event for every change, success or failure.

Drill-down rules:

- Drill down from a list when the item has multiple related datasets, a timeline, history, notes, or several action groups.
- Prefer a drill-down page over an inline master-detail panel: clicking a list row
  replaces the list with the record's detail page rather than updating a section beneath
  the list. This keeps the list focused on triage and the detail focused on one record.
- Keep the list page focused on identifying, filtering, and triaging records.
- Put complete record inspection, timelines, and cross-related tables on detail pages.
- Provide a clear "Back to list" secondary action in the detail page header — a back
  arrow button at the left of the detail header is the established pattern.
- Reset the detail's sub-tabs to their default when navigating to a new record.
- Use tabs within detail pages when the record has distinct categories such as profile, billing, usage, support, compliance, email, audit, or timeline.

Inline list controls:

- Use an inline dropdown or combobox in the list itself when the value is a common,
  low-context operational assignment and changing it is the user's main task on that
  screen.
- Good examples include user owner, assignee, priority, status, queue, reviewer, or other
  finite routing fields.
- The user owner field should be editable from the list when operators are primarily
  organizing users under owners and do not need the full user detail page to decide.
- Inline owner controls should show the current owner, allow search when the owner list is
  long, and save without navigating away from the list.
- Prefer a combobox over a plain select when options include people, ownership paths, or
  many similarly named choices.
- Show a short success or error toast after save, and keep the row in place unless the
  active filter means the row no longer belongs in the current view.
- Use optimistic UI only when failure is rare and the row can clearly roll back to the
  previous value. Otherwise, show a saving state in the control.
- Keep inline controls compact and row-height stable; opening the menu should overlay the
  table rather than resizing the row.
- Do not require drill-down just to change a single routing field.
- Do require drill-down or a modal when changing the value requires audit history, a
  reason, confirmation, multiple related fields, permission review, or security-sensitive
  context.

## Page Headers

Each application page should start with a compact header:

- Title on the left.
- Optional subtitle beneath or beside it for context.
- Optional count such as "50 shown".
- Optional page-level action on the right.

Keep page headers short. Do not use hero-scale typography inside the application shell.

## Cards And Rows

Use cards for grouped details and settings.

Card rules:

- Background is `panel`.
- Border is `line`.
- Border radius is `8px`.
- Header has compact padding and a bottom border.
- Body is made of rows, forms, or small tables.
- Card titles are short nouns: "Account", "Billing", "Active sessions".

Row rules:

- Rows are horizontal.
- Left label column has fixed width around `130px`.
- Value area flexes and may contain chips, links, and muted details.
- Optional action area sits at the far right.
- Each row has a bottom border except the last row.
- Use muted text for absent values and secondary details.

Use rows when values are few and structured. Use tables when there are many records or repeated columns.

## Tables And Lists

Use tables for operational lists. Tables are the primary list component.

Table panel:

- Wrap tables in a bordered `panel`.
- Use horizontal overflow for wide tables.
- Table headers are uppercase, muted, small, and semibold.
- Row cells use compact vertical padding.
- Row hover uses `hover-overlay`.
- Empty states are centered, muted, and padded.

Column rules:

- First column should identify the record and often links to the detail page.
- Status columns should use status chips.
- Timestamps should be muted and compact.
- Actions should be in the last column.
- Keep long metadata muted and smaller.
- Use monospace only for ids, tokens, slugs, or technical identifiers.
- Action button groups must not wrap: wrap row actions in a non-wrapping inline-flex
  container so Edit/Delete (and similar) stay on one line. Let the row scroll
  horizontally rather than stack actions.
- Cells that can hold very long single values (JSON payloads, audit input summaries,
  stack traces) should be height-capped with `overflow: hidden` and a "Show more"/"Show
  less" toggle; when expanded, cap with a scrollable max-height so the list is never
  scroll-bombed. Show the toggle only when the content actually overflows.

List icon rules:

- Do not use icons as decoration in dense data tables.
- Use status chips instead of icons for state when text matters.
- Use icons in list rows only when the icon adds fast recognition: external link, warning, lock/security, edit, delete, download, retry, or expand.
- Pair unfamiliar icons with text or accessible labels.
- Do not replace critical action text with icon-only controls unless the meaning is universally clear and a tooltip or `aria-label` is present.

## Filters

Put filters above the table in a compact bordered panel or card.

Use:

- Text input for search.
- Selects for finite status/type/category filters.
- Date inputs for date ranges.
- A secondary button for applying filters.
- Filter chips below the filter panel to show active filters.
- A clear filters link when any filter is active.

Filters should be URL-addressable so refresh, sharing, and back navigation preserve state.

## Buttons And Actions

Use three primary button styles.

Primary button:

- Filled accent background.
- Accent foreground text.
- Used for the main submit action in a modal/form.

Secondary button:

- Transparent background.
- Strong border.
- Muted text, foreground on hover.
- Used for navigation, cancel, edit, view, retry, filter, and ordinary actions.

Danger button:

- Red-tinted border and background.
- Red text.
- Used for destructive or access-changing actions.

Action placement:

- Page-level create actions belong in the page header or a small toolbar above the list.
- Row-level actions belong in the last column or row action area.
- Form submit actions belong at the end of the form.
- Modal actions are right-aligned, with Cancel first and the primary/danger submit last.

Creation actions:

- Use "+ Add ..." for creating a new item from a list.
- A plus button may be text-based in this UI style, such as "+ Add request".
- Use a standalone icon-only `+` only in very dense toolbars where the surrounding context is obvious.
- Creation and editing generally open a modal over the current list/detail page.

## Modals

Use modals for focused create/edit flows and confirmations that should preserve the underlying page context.

Modal rules:

- Full-screen fixed backdrop with dark translucent overlay.
- Center the modal panel.
- Panel width defaults to about `460px`; explicitly wide provisioning or policy dialogs
  may grow to about `1040px`.
- Max height should fit within the viewport and scroll internally.
- Header contains title and close button.
- Header has a bottom border.
- Close button is a small bordered square with an "x".
- The modal body owns its padding, vertical gap, and scrolling. Notices, explanatory
  copy, forms, and previews are siblings inside this body and must not add outer margins.
- Form content is a vertical grid. The form owns field-to-field gaps but does not add a
  second layer of body padding.
- Actions are right-aligned at the bottom.
- On narrow screens, use nearly the full available width, reduce horizontal body padding,
  align the panel toward the bottom edge, and keep at least `8px` of viewport clearance.
- Wide-dialog actions may remain sticky at the bottom of the scrolling modal body.
- Modal panels clip their content (`overflow: hidden`) so they scroll internally, which
  also clips absolutely-positioned dropdowns. Any custom combobox, menu, or popover opened
  inside a modal must portal to `document.body` and position with `fixed` coordinates from
  the trigger's rect so it escapes the modal's overflow containers. Reposition on
  scroll/resize and close if the trigger scrolls out of view. Native `<select>` elements
  are not affected and may stay inline.

Prefer URL-addressable modals using query state when possible. Closing a modal should return to the parent page URL.

Use modals for:

- Creating records.
- Editing records.
- Short forms.
- Changing account preferences.
- Confirmation flows that require a reason or typed confirmation.

Do not use modals for:

- Large multi-section workflows.
- Full record inspection.
- Data-heavy comparisons.
- Pages that require deep linking to multiple subsections.

## Popover And Confirmation Patterns

Use lightweight popovers only for small, reversible, local actions such as opening toast history, choosing a quick option, or showing a compact menu.

Use confirmation modals for risky actions:

- Deleting or disabling something.
- Revoking sessions or access.
- Resetting credentials.
- Changing security-sensitive data.
- Actions requiring audit history.

Danger confirmation modals should include:

- A precise title.
- A notice-style description of the consequence.
- Hidden context fields as needed.
- A required reason field for auditability.
- A typed confirmation field for high-impact actions.
- Cancel as a secondary action.
- Submit styled as danger unless the action is recoverable or operationally neutral.

Never hide destructive actions behind only a browser confirm dialog.

## Forms

Form fields are stacked by default.

Field rules:

- Label text sits above the control.
- Controls have minimum height around `36px`; ordinary buttons are about `34px` high.
- Border radius is `6px`.
- Border uses `line`; focus uses accent border and `focus-ring`.
- Inputs and textareas use `input` background.
- Textareas are vertically resizable.
- Selects are used for finite options.
- Checkboxes and radios use inline labels, align to the first line of wrapping copy, and
  retain their intrinsic size rather than stretching to the form width.

Use inline forms inside rows only for very small updates, such as a short reason plus a submit button. Larger edits should use a modal.

Password fields should include a compact strength meter when password quality matters.
Use the existing `PasswordStrengthInput` pattern for signup, password reset, customer
password change, admin password change, and admin-user creation flows.

Password strength behavior:

- The current meter uses `zxcvbn` on the client and server.
- Client scoring is loaded lazily after the password field renders.
- Empty fields show no score, no label, and an unfilled neutral meter.
- `zxcvbn` scores are `0` through `4`: very weak, weak, fair, strong, very strong.
- A password is acceptable when `zxcvbn` returns score `3` or `4`.
- Scores `0`, `1`, and `2` are blocking when strength enforcement is enabled.
- Password fields should still set `minLength={8}` where a new password is collected.
- Signup also enforces at least 8 characters server-side before account creation.
- Strength enforcement is disabled in local Stripe mode, but the visual meter still
  appears and should still report the score.
- Server validation must remain the source of truth. Client validation is only an
  immediate usability aid.

Password strength copy:

- Score `0`: "Very weak".
- Score `1`: "Weak".
- Score `2`: "Fair".
- Score `3`: "Strong".
- Score `4`: "Very strong".
- When enforcement is enabled and the score is below `3`, append " - too weak".
- Blocking server errors should use: "Password is too weak. Please choose a stronger password."
- Do not expose zxcvbn internals, guesses, crack-time estimates, or detailed advice in
  the default UI.

Password strength visual design:

- Place the meter directly below the password input, inside the same label/control group.
- Use a four-segment horizontal bar, `3px` high, with `3px` gaps and `2px` segment radius.
- The wrapper uses a compact grid gap around `4px`.
- Fill `score + 1` segments, capped at four filled segments.
- Unfilled segments use `line`.
- Scores `0` and `1` use soft red, currently `#e87070`.
- Score `2` uses amber, currently `#e6b450`.
- Score `3` uses the product accent color.
- Score `4` uses green, currently `#38b885`.
- Put the text hint below the bar at `12px`, with a reserved `16px` minimum height so
  form layout does not jump as the user types.
- The bar is decorative and should be hidden from assistive technology; the text hint
  carries the readable state.
- Keep the meter quiet and utilitarian. It should not introduce icons, badges, large
  explanatory panels, or animated feedback beyond a subtle color transition.

## Status, Chips, And Metadata

Use chips for states, roles, tags, counts, and compact categorical values.

Chip rules:

- Small uppercase text.
- Semibold.
- Border radius around `4px`.
- Border color matches tone.
- Use `white-space: nowrap`.

Tone mapping:

- Ok: active, approved, completed, fulfilled, processed, provisioned, resolved, succeeded, verified.
- Warning: admin, open, pending, unverified, waiting.
- Fail: canceled, dead, failed, incomplete, past due, rejected, unpaid.
- Muted: unknown, none, neutral, empty, default.

Use `-` for truly absent values in tables. Use muted explanatory text for absent values in cards and rows when context helps.

Use relative time such as "3h ago" or "12d ago" in dense lists. Use absolute dates when the exact date matters.

## Notices, Toasts, And Feedback

Inline notices:

- Use bordered, lightly tinted panels.
- Use error styling for blocking failures.
- Use ok styling for success confirmations.
- Place notices near the form or section they affect.
- Use a small internal grid gap so the title, explanatory text, and optional action are
  distinct. The notice itself should not add outer bottom margin when its parent already
  supplies section spacing.

Toasts:

- Use a fixed footer toast area rather than floating over primary content.
- Keep messages single-line with ellipsis.
- Provide a history panel for recent messages when useful.
- Tone toast colors by success, warning, error, and info.

Toast footer behavior:

- The toast system lives in the global app shell so it is available across public,
  customer, and admin pages.
- The footer is fixed to the bottom edge of the viewport and spans the full width.
- Current footer height is `44px`; reserve enough bottom space in dense pages so
  important controls are not hidden behind it.
- Use a translucent `panel` background with blur and a top `line` border so the footer
  feels persistent but secondary.
- The active toast appears in the left track. The history button sits on the right.
- Only one active toast is shown at a time. A new toast replaces the current active toast.
- Toast messages enter from the left, remain visible, then exit to the right.
- Current timing is about `8s` visible, with short enter and exit transitions.
- Do not stack multiple visible toast cards. Use the history panel for prior messages.
- Keep active toast width capped, currently around `520px`, and truncate overflow with
  ellipsis.
- Toast text should be concise enough to scan in one line. Put detail, forms, and
  remediation steps in the page body or modal, not in the toast.

Toast history:

- Keep recent activity in memory for the current browser session.
- Current history limit is `60` items, newest first.
- Every toast added through `notify` should also be added to history.
- The history button uses a compact clock/history icon and an optional count badge.
- The badge shows the current number of stored history items when the count is above `0`.
- The button should use `aria-label="Show recent activity"` and a matching tooltip/title.
- Clicking the history button toggles the panel.
- Clicking outside the panel closes it.
- The history panel opens above the footer, aligned to the right edge of the viewport.
- Current panel dimensions are about `380px` wide with `300px` max height and vertical
  scrolling.
- The panel header reads "Recent activity" and remains sticky while the list scrolls.
- An empty history shows a muted "No activity yet." message.
- Each row shows a timestamp and the toast text.
- Timestamps use local time with hours, minutes, and seconds, with tabular numerals.
- Rows use the toast tone color so error, warning, success, and info events remain
  distinguishable after the active toast disappears.
- The history panel is not a durable audit log. Use audit tables, timelines, or record
  history for compliance, security, and support traceability.

Toast tones:

- Success: completed actions, saved changes, request submission, or background action
  completion. Use accent text and a lightly tinted accent background.
- Warning: recoverable risk, pending states, partial completion, or action that needs
  follow-up.
- Error: failed actions after a user attempt. Pair with inline error state when the user
  must fix a specific form field.
- Info: neutral navigation-triggered confirmations, background status, or low-priority
  updates.

Toast sources:

- Client components should call `useToast().notify(text, type)`.
- Server redirects that need a toast should pass `?toast=<type>&msg=<message>` and render
  `PageToastBridge` on the destination page.
- After firing a redirect-sourced toast, remove the `toast` and `msg` query params with
  history replacement so refresh does not repeat the message.

Prefer inline validation for form issues and toast feedback for completed background or navigation-triggered actions.

## Authentication And Onboarding Screens

Login and signup screens should be visually consistent with public pages:

- Centered main container.
- Two-column hero layout on desktop.
- Short title and explanatory text.
- Form in a bordered panel.
- Work email and password fields first.
- Primary submit button spans the natural form width.
- Secondary links below the form, such as forgot password or create account.
- Error notices appear above the form.

Signup-style flows may include:

- Password strength meter.
- Organization or account name field.
- Plan or selected option summary.
- Required checkboxes for legal or policy acceptance.

Keep onboarding copy direct and operational. Avoid sales language inside the app UI.

## Account And Settings Screens

Use account cards and rows for settings, profile, billing, security, preferences, usage summaries, and request history.

Patterns:

- Overview pages should show a few grouped cards with current status and next actions.
- Security pages should show password, email, sessions, and dangerous request areas in separate cards.
- Billing pages should show current plan, provider, payment state, terms, subscription state, and history.
- Preferences should use checkbox rows in a card body.
- Support and request lists should use tables with "+ Add ...", View, and Edit actions.

Self-service surfaces (visible to every role, including regular users and auditors):

- A personal dashboard: the signed-in user's own recent activity (logins, token use, API
  calls), a last-login tile, an active-tokens count, and a recent-calls count. Admins see
  the global summary panels above their personal section; other roles see only their own.
- A Tokens tab scoped to the user's own tokens: create and revoke their own tokens, with
  the secret shown once at creation. Do not offer hard delete — revocation preserves the
  audit trail that ties tool calls to the token (the token row is retained; deleting it
  would orphan that link).
- A Client Setup tab with per-CLI instructions as sub-tabs (e.g. Claude Code, Claude
  Desktop, Codex, Other) and a token selector. Because the full token secret is shown only
  once and then stored hashed, "select a token" works by remembering freshly-created
  secrets in the browser (per-user, `localStorage`) and offering a "Create new token"
  action inline; manual paste remains a fallback.
- A Settings page with a Profile section (display name, email — self-service, posts to a
  `/me/profile` endpoint that enforces email uniqueness) and a Security section reusing
  the change-password form. Reachable from the sidebar by every role.

Admin editing of records (admin roles only):

- Each record detail page (Users, Groups, Servers) has an Edit button in its header that
  opens a modal over the detail page. Policies editing opens from the list's Edit button
  into the policy editor modal (name/description + plugin persona ladder; the permission grid
  is progressively disclosed under Advanced).
- Edits PATCH the record and audit a `*_update` event with before/after. Email changes
  enforce uniqueness. Role changes on a user clear the owner when the role becomes
  `global_admin`; otherwise the existing owner is retained. Owner reassignment stays on
  the dedicated Move flow.

Risky account actions should be visually separated in a danger-zone card.

## Admin And Operator Screens

Admin screens should be optimized for triage.

Patterns:

- Use sidebar navigation for major admin areas.
- Use tabs for queues and subsections.
- Use filter panels above tables.
- Use detail pages for records with many related datasets.
- Put timelines first when they help operators understand state changes.
- Use mini tables to show related records inside detail tabs.
- Use reason fields for auditable operator changes.
- Gate unavailable actions by permission and show a muted "No permission" or equivalent state.

Admin list rows should expose enough status to triage without entering the detail page.

## Detail Pages

Detail pages should answer: "What is this record, what is its current state, what happened recently, and what can I safely do next?"

Use:

- Header with primary identifier and contextual subtitle.
- Back link to the list.
- An Edit button in the header (admin roles) opening a modal to edit the record's core
  fields without leaving the detail page.
- Tabs for record categories.
- Timeline tab when multiple systems or event streams affect the record.
- Cards for summary and actions.
- Mini tables for related records.
- Confirmation modals for sensitive actions.

Do not overload the list page with all detail data. Drill down when the user needs history, related records, notes, audit events, or security-sensitive actions.

## Spacing, Borders, And Radius

Use a compact spacing scale rather than one-off values:

- `space-1`: `4px` for tight internal alignment.
- `space-2`: `8px` for inline actions, checkbox labels, and compact control groups.
- `space-3`: `12px` for panel content and closely related subsections.
- `space-4`: `16px` for page stacks, tab bodies, forms, cards, and major sibling sections.
- `space-5`: `20px` between the application topbar and page content.
- `space-6`: `24px` for occasional larger structural separation.

Applied dimensions:

- Page content padding: `32px` vertically, with horizontal padding clamped from `20px`
  to `40px`.
- Public main vertical padding: `48px` top, larger bottom.
- Page, tab-body, and form gap: `16px`.
- Card/panel padding: `16px`.
- Modal body padding: `18px`; modal header padding: around `14px 18px`.
- Row padding: around `11px 18px`.
- Table cell padding: around `10px` vertical and `12px` horizontal.
- Inline action gap: `8px`.

Spacing ownership rules:

- Reset default heading and paragraph margins inside the application.
- Use `page-section` for top-level page rhythm and `section-stack` for nested feature
  sections such as plugin management.
- Do not combine a parent `gap` with child `margin-top` or `margin-bottom` for the same
  boundary.
- A modal has one padded, scrollable body. Forms and notices inside it use zero outer
  margin.
- Metric typography belongs only to metric-card variants; generic panels must not restyle
  nested values or summary rows.
- Preformatted configuration and secret blocks use internal padding but zero outer margin
  when placed in a stack.

Radius:

- Panels, cards, modals, table panels: `8px`.
- Buttons, inputs, and notices: `6px`.
- Status chips use a pill radius and remain single-line.

Use borders heavily but softly. Borders define the structure; shadows are reserved mainly for modals and overlays.

## Accessibility And Interaction

Baseline rules:

- All interactive controls need visible focus states.
- Focus is shown as a glow, not a hard outline ring: on `:focus-visible`, remove the
  outline, tint the element border to the accent, and apply a layered accent box-shadow —
  a tight inner ring plus a diffuse outer halo. Derive the halo color from the theme
  accent (e.g. `color-mix(in srgb, var(--accent) 45%, transparent)`) so it follows the
  active theme. `:focus-visible` keeps the glow off mouse clicks and on for keyboard
  navigation and text inputs.
- Links and buttons must be distinguishable by behavior.
- Icon-only controls require `aria-label`.
- Close buttons require accessible labels.
- Inputs should use appropriate types and autocomplete values.
- Required fields should use native validation where possible.
- Tables should use real `table`, `thead`, `tbody`, `th`, and `td` elements.
- Do not rely on color alone; pair status color with text labels.

Hover states should be subtle and should not shift layout.

## Responsive Behavior

Public hero layouts collapse to one column below tablet width.

For application pages:

- Preserve the sidebar/content model on desktop.
- Below the tablet breakpoint, collapse the sidebar into an off-canvas drawer: hide it
  translated off-screen, add a hamburger button to the topbar, and slide the drawer in
  over a dimmed backdrop when toggled. Selecting a nav item or clicking the backdrop
  closes it. The desktop sidebar and its account footer are unchanged above the
  breakpoint.
- Allow horizontal scrolling for dense tables.
- Let tab rails scroll horizontally.
- Keep button text from wrapping awkwardly by using compact labels.
- Avoid viewport-based font scaling.
- Avoid layouts where text can overlap adjacent actions on narrow screens.

When a table becomes too dense for mobile, prefer horizontal scrolling over hiding important operational columns unless there is a deliberate mobile-specific design.

## Implementation Principles

Use shared primitives for:

- Shells and sidebars.
- Page headers.
- Tabs.
- Account/detail cards.
- Rows.
- Modals.
- Tables.
- Status chips.
- Dangerous action confirmations.
- Toasts.
- Comboboxes with menus portaled to `document.body` (so they work inside modals and
  overflow-clipped panels).
- Reusable self-service forms, e.g. the change-password form shared by the first-login
  page and the self-service modal.

Prefer URL state for navigation, filters, tabs, pagination, and modals. This keeps the app bookmarkable, refresh-safe, and predictable.

Keep one-off inline styles rare and limited to small spacing or width adjustments. New screens should first try to compose existing primitives.

## Common Recipes

List with create/edit:

1. Page shell with active sidebar item.
2. Compact page header with title, count, and "+ Add item" secondary button.
3. Optional tabs for queues.
4. Optional filter card and active filter chips.
5. Table panel with linked first column, status chips, timestamps, and actions.
6. Create/edit modal opened by URL query state.

Record detail:

1. Page shell with active parent sidebar item.
2. Header with record identifier, subtitle, and Back action.
3. Tabs for categories.
4. Timeline as the first tab when history matters.
5. Cards and mini tables per tab.
6. Confirmation modals for sensitive actions.

Dangerous action:

1. Trigger from row, card, or detail action.
2. Open URL-addressable confirmation modal.
3. Explain consequence in a notice.
4. Require audit reason.
5. Require typed confirmation for high-impact changes.
6. Cancel with secondary button; submit with danger button.

Authentication flow:

1. Public main container.
2. Two-column hero.
3. Form panel on the right.
4. Inline error notice above form.
5. Stacked labels and fields.
6. Primary submit.
7. Secondary account recovery or alternate-flow links.

First-login password change:

1. Detect `password_change_required` on login and route to a full-page change form
   before the workspace.
2. Current password, new password, confirm, and a strength meter.
3. Validate client-side (non-empty, new differs from current, passwords match).
4. Submit to the password-change endpoint; on success clear the flag and enter the
   workspace.
5. Reuse the same form (without the full-page chrome) on the Settings page's Security
   section so users can change it again at any time.

Personal dashboard:

1. Page shell with the Dashboard sidebar item.
2. For admins: global summary tiles (servers, users, tokens, audit) at the top.
3. For every role: a "Your activity" section with last-login, active-tokens, and
   recent-calls tiles, then a recent-activity list (logins, token use, API calls) with
   status chips.
4. Source from a self-scoped activity endpoint that returns only the signed-in user's
   own audit events and counts; never expose other users' data to non-admin roles.

Self-service client setup:

1. Broker URL and token inputs at the top, persisted in the browser.
2. A token selector fed by remembered created-token secrets (per-user localStorage) plus
   a "Create new token" action that creates one and auto-selects it.
3. Sub-tabs per CLI client (Claude Code, Claude Desktop, Codex, Other), each with
   copy-able config snippets that interpolate the current URL and token.
4. Note where a client's config is stdio-only and requires a remote-to-stdio bridge.
5. Manual paste remains available as a fallback.

Account settings:

1. Page shell with the Settings sidebar item (all roles).
2. Profile section: display name and email, posted to a `/me/profile` endpoint that
   enforces email uniqueness; on success update the signed-in user in place.
3. Security section: reuse the change-password form (current/new/confirm + strength
   meter) posting to `/auth/change-password`.
4. Keep the two sections as separate bordered blocks; do not mix profile and password
   fields in one form.

Record edit from detail:

1. Detail page header has an Edit button (admin roles).
2. Edit opens a modal over the detail page with the record's core fields.
3. PATCH the record; audit a `*_update` event with before/after.
4. On success, refresh and keep the user on the detail page (do not navigate away).
5. Keep owner reassignment on the dedicated Move flow, not the edit modal.
