import React from "react";
import { createPortal } from "react-dom";
import type {
  User, Server, Group, GroupMembership, Token, ToolDefinition, Policy, PolicyPermission, Binding,
  EffectiveAccess, AuditEvent, MyActivity, ThemeMode, ToastTone, ToastItem, SelectItem, ComboboxOption, ZxcvbnModule, Api, Runner
} from "./types.js";
import {
  themeOptions, renderCell, statusTone, isStatusColumn, formatToastTime,
  scorePassword, fallbackPasswordScore, clampScore
} from "./helpers.js";

export function AccessDenied() {
  return (
    <section className="page-section">
      <div className="empty-state">
        You do not have access to this area. Ask a team admin or global admin if you need it.
      </div>
    </section>
  );
}


export function Panel(props: { title: string; value: string; label: string }) {
  return (
    <article className="panel metric-panel">
      <h2>{props.title}</h2>
      <strong>{props.value}</strong>
      <p>{props.label}</p>
    </article>
  );
}


export function PageToolbar(props: { count: number; actions?: React.ReactNode }) {
  return (
    <div className="page-toolbar">
      <span>{props.count} shown</span>
      <div className="page-actions">{props.actions}</div>
    </div>
  );
}


export function Modal(props: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props]);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className={`modal-panel ${props.wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header className="modal-header">
          <h2 id="modal-title">{props.title}</h2>
          <button className="modal-close" type="button" aria-label="Close" onClick={props.onClose}>x</button>
        </header>
        <div className="modal-body">{props.children}</div>
      </section>
    </div>
  );
}


export function Form(props: { children: React.ReactNode; onSubmit: () => void | Promise<void>; onCancel: () => void; submitLabel?: string }) {
  return (
    <form
      className="modal-form"
      onSubmit={(event) => {
        event.preventDefault();
        void props.onSubmit();
      }}
    >
      {props.children}
      <div className="modal-actions">
        <button type="button" onClick={props.onCancel}>Cancel</button>
        <button className="button-primary" type="submit">{props.submitLabel ?? "Save"}</button>
      </div>
    </form>
  );
}


export function Select<T extends SelectItem>(props: {
  value: string;
  onChange: (value: string) => void;
  items: T[];
  label: string;
}) {
  const options = props.items.map((item) => ({
    value: item.id,
    label: item.name ?? item.display_name ?? item.email ?? item.id,
    detail: [item.email, item.id].filter((part) => part && part !== item.email).join(" · ")
  }));
  return <Combobox value={props.value} onChange={props.onChange} placeholder={props.label} options={options} />;
}


export function Combobox(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  options: ComboboxOption[];
  compact?: boolean;
  disabled?: boolean;
  allowEmpty?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const ref = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [coords, setCoords] = React.useState<{ top: number; left: number; width: number; up: boolean; optionsMaxHeight: number } | null>(null);
  const selected = props.options.find((option) => option.value === props.value);
  const filtered = props.options.filter((option) =>
    `${option.label} ${option.detail ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())
  );

  // Recompute the portaled menu position from the trigger's rect. Portaling to
  // document.body lets the dropdown escape the modal's overflow:hidden / overflow:auto
  // containers, which would otherwise clip it.
  const updateCoords = React.useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 6;
    const searchChrome = 52; // search input + menu padding allowance
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const up = spaceBelow < 160 && spaceAbove > spaceBelow;
    const available = up ? spaceAbove : spaceBelow;
    const optionsMaxHeight = Math.max(120, Math.min(260, available - searchChrome));
    setCoords({ top: up ? rect.top - gap : rect.bottom + gap, left: rect.left, width: rect.width, up, optionsMaxHeight });
  }, []);

  React.useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    updateCoords();
    const onScroll = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      // If the trigger scrolled out of view, close instead of stranding the menu.
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        setOpen(false);
        return;
      }
      updateCoords();
    };
    const onResize = () => updateCoords();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, updateCoords]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  React.useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  const choose = (value: string) => {
    props.onChange(value);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className={`combobox ${props.compact ? "compact" : ""}`} ref={ref}>
      <button
        type="button"
        className="combobox-trigger"
        ref={triggerRef}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={props.disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((current) => {
              const direction = event.key === "ArrowDown" ? 1 : -1;
              return Math.max(0, Math.min(filtered.length - 1, current + direction));
            });
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (open && filtered[activeIndex]) choose(filtered[activeIndex].value);
            else setOpen(true);
          }
          if (event.key === "Escape") setOpen(false);
        }}
      >
        <span>{selected?.label ?? props.placeholder}</span>
        <span aria-hidden="true">v</span>
      </button>
      {open && coords
        ? createPortal(
            <div
              className={`combobox-menu${coords.up ? " up" : ""}`}
              ref={menuRef}
              style={{
                position: "fixed",
                top: coords.top,
                left: coords.left,
                width: Math.min(coords.width, window.innerWidth - coords.left - 16),
                transform: coords.up ? "translateY(-100%)" : undefined,
              }}
            >
              <input
                className="combobox-search"
                autoFocus
                placeholder="Search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveIndex((current) => {
                      const direction = event.key === "ArrowDown" ? 1 : -1;
                      return Math.max(0, Math.min(filtered.length - 1, current + direction));
                    });
                  }
                  if (event.key === "Enter" && filtered[activeIndex]) {
                    event.preventDefault();
                    choose(filtered[activeIndex].value);
                  }
                  if (event.key === "Escape") setOpen(false);
                }}
              />
              <div className="combobox-options" role="listbox" style={{ maxHeight: coords.optionsMaxHeight }}>
                {props.allowEmpty ? (
                  <button type="button" role="option" aria-selected={!props.value} onClick={() => choose("")}>
                    <span>{props.placeholder}</span>
                  </button>
                ) : null}
                {filtered.length === 0 ? (
                  <div className="combobox-empty">No matches</div>
                ) : (
                  filtered.map((option, index) => (
                    <button
                      type="button"
                      className={index === activeIndex ? "active" : ""}
                      key={option.value}
                      role="option"
                      aria-selected={option.value === props.value}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => choose(option.value)}
                    >
                      <span className="combobox-option-label" style={{ "--depth": option.depth ?? 0 } as React.CSSProperties}>{option.label}</span>
                      {option.detail ? <small>{option.detail}</small> : null}
                    </button>
                  ))
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}


export function PasswordStrengthInput(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
}) {
  return (
    <div className="password-strength-control">
      <input
        placeholder={props.placeholder}
        type="password"
        value={props.value}
        autoComplete={props.autoComplete ?? "new-password"}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <PasswordStrengthMeter password={props.value} />
    </div>
  );
}


export function PasswordStrengthMeter(props: { password: string }) {
  const [score, setScore] = React.useState<number | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    if (!props.password) {
      setScore(null);
      return;
    }

    scorePassword(props.password).then((nextScore) => {
      if (!cancelled) setScore(nextScore);
    });

    return () => {
      cancelled = true;
    };
  }, [props.password]);

  const filled = score == null ? 0 : Math.min(score + 1, 4);
  const label = score == null ? "" : ["Very weak", "Weak", "Fair", "Strong", "Very strong"][score];

  return (
    <div className="password-strength">
      <div className="password-strength-bar" aria-hidden="true">
        {[0, 1, 2, 3].map((segment) => (
          <span
            className={segment < filled ? `filled strength-${score}` : ""}
            key={segment}
          />
        ))}
      </div>
      <span className="password-strength-label">{label}</span>
    </div>
  );
}


export function ThemeSelector(props: { value: ThemeMode; onChange: (value: ThemeMode) => void; placement: "public" | "sidebar" }) {
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(() => themeOptions.findIndex((option) => option.value === props.value));
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setActiveIndex(themeOptions.findIndex((option) => option.value === props.value));
  }, [props.value]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const selected = themeOptions.find((option) => option.value === props.value) ?? themeOptions.find((option) => option.value === "auto")!;
  const menuId = `theme-menu-${props.placement}`;

  const select = (value: ThemeMode) => {
    props.onChange(value);
    setOpen(false);
  };

  return (
    <div className={`theme-selector theme-placement-${props.placement}`} ref={ref}>
      <button
        type="button"
        className="theme-trigger"
        aria-label="Theme"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((current) => {
              const direction = event.key === "ArrowDown" ? 1 : -1;
              return (current + direction + themeOptions.length) % themeOptions.length;
            });
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (open) select(themeOptions[activeIndex]?.value ?? props.value);
            else setOpen(true);
          }
          if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      >
        <span className="theme-icon" aria-hidden="true">{selected.icon}</span>
        <span className="theme-value">{selected.label}</span>
        <span className="theme-chevron" aria-hidden="true">v</span>
      </button>
      {open ? (
        <div className="theme-menu" id={menuId} role="listbox" aria-label="Theme">
          {themeOptions.map((option, index) => (
            <button
              type="button"
              className={index === activeIndex ? "active" : ""}
              key={option.value}
              role="option"
              aria-selected={option.value === props.value}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => select(option.value)}
            >
              <span aria-hidden="true">{option.icon}</span>
              <span>{option.label}</span>
              <span className="theme-check" aria-hidden="true">{option.value === props.value ? "✓" : ""}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}


export function ToastFooter(props: { activeToast: ToastItem | null; history: ToastItem[] }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <footer className="toast-footer" ref={ref}>
      <div className="toast-track" aria-live="polite">
        {props.activeToast ? (
          <div className={`toast-card toast-${props.activeToast.tone}`} key={props.activeToast.id}>
            {props.activeToast.text}
          </div>
        ) : null}
      </div>
      <div className="toast-history-wrap">
        {open ? <ToastHistoryPanel history={props.history} /> : null}
        <button
          className="toast-history-button"
          type="button"
          aria-label="Show recent activity"
          title="Show recent activity"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span aria-hidden="true">◷</span>
          {props.history.length > 0 ? <span className="toast-count">{props.history.length}</span> : null}
        </button>
      </div>
    </footer>
  );
}


export function formatToastForClipboard(toast: ToastItem): string {
  return `[${toast.createdAt.toISOString()}] ${toast.tone.toUpperCase()} ${toast.text}`;
}

export function formatToastHistoryForClipboard(history: ToastItem[]): string {
  return history.map(formatToastForClipboard).join("\n");
}

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard copy failed");
}


export function ToastHistoryPanel(props: { history: ToastItem[] }) {
  const [expandedIds, setExpandedIds] = React.useState<Set<number>>(() => new Set());
  const [copied, setCopied] = React.useState<number | "all" | null>(null);

  const copy = async (value: string, id: number | "all") => {
    try {
      await copyToClipboard(value);
      setCopied(id);
      window.setTimeout(() => setCopied((current) => current === id ? null : current), 1500);
    } catch {
      setCopied(null);
    }
  };

  const toggleExpanded = (id: number) => setExpandedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <section className="toast-history-panel" aria-label="Recent activity">
      <header className="toast-history-header">
        <h2>Recent activity</h2>
        <button type="button" disabled={props.history.length === 0} onClick={() => void copy(formatToastHistoryForClipboard(props.history), "all")}>
          {copied === "all" ? "Copied all" : "Copy all"}
        </button>
      </header>
      {props.history.length === 0 ? (
        <p>No activity yet.</p>
      ) : (
        <div className="toast-history-list">
          {props.history.map((toast) => {
            const expanded = expandedIds.has(toast.id);
            return <article className={`toast-history-row toast-${toast.tone}${expanded ? " expanded" : ""}`} key={toast.id}>
              <time>{formatToastTime(toast.createdAt)}</time>
              <button
                type="button"
                className="toast-history-message"
                aria-expanded={expanded}
                title={expanded ? "Collapse message" : "Expand message"}
                onClick={() => toggleExpanded(toast.id)}
              >
                {toast.text}
              </button>
              <button
                type="button"
                className="toast-copy-button"
                aria-label={`Copy message: ${toast.text}`}
                onClick={() => void copy(formatToastForClipboard(toast), toast.id)}
              >
                {copied === toast.id ? "Copied" : "Copy"}
              </button>
            </article>;
          })}
        </div>
      )}
    </section>
  );
}


export function DataTable(props: { columns: string[]; rows: Record<string, unknown>[] }) {
  return (
    <section className="table-section">
      <table>
        <thead>
          <tr>
            {props.columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.length === 0 ? (
            <tr>
              <td className="empty-state" colSpan={props.columns.length}>No records</td>
            </tr>
          ) : (
            props.rows.map((row, index) => (
              <tr key={String(row.id ?? index)}>
                {props.columns.map((column) => (
                  <td key={column}>{renderCell(row[column], column)}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}
