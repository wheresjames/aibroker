import { createHash, randomBytes } from "node:crypto";

// Pure Elementor layout logic: the element tree stored in _elementor_data, broker-side
// operations over it, and the validation that runs before anything is saved
// (AB-ELEMENTOR 5.2–5.4). No I/O here, so every rule is unit-testable.

export interface ElementNode {
  id: string;
  elType: string;
  widgetType?: string;
  isInner?: boolean;
  // PHP serializes an empty settings array as [], so both shapes occur in stored data.
  settings: Record<string, unknown> | unknown[];
  elements: ElementNode[];
  [key: string]: unknown;
}

export interface ElementInput {
  id?: string;
  elType: string;
  widgetType?: string;
  isInner?: boolean;
  settings?: Record<string, unknown>;
  elements?: ElementInput[];
}

export type Operation =
  | { action: "update_settings"; element_id: string; settings: Record<string, unknown> }
  | { action: "insert"; parent_id: string | null; index?: number; element: ElementInput }
  | { action: "remove"; element_id: string }
  | { action: "move"; element_id: string; parent_id: string | null; index?: number }
  | { action: "duplicate"; element_id: string; parent_id?: string | null; index?: number }
  | { action: "replace"; element_id: string; element: ElementInput }
  // Elementor Pro global widgets are references to a widget template; unlinking copies
  // the template's widget into the page as a normal, editable element.
  | { action: "unlink_global"; element_id: string }
  // Copy a saved template's elements into the page with fresh ids.
  | { action: "insert_template"; template_id: number; parent_id: string | null; index?: number };

export const GLOBAL_WIDGET_TYPE = "global";

// Template ids that operations need resolved before applyOperations runs (the tree logic
// itself does no I/O).
export function referencedTemplateIds(tree: ElementNode[], operations: unknown): number[] {
  if (!Array.isArray(operations)) return [];
  const ids = new Set<number>();
  for (const raw of operations) {
    const op = raw as Record<string, unknown> | null;
    if (op?.action === "insert_template" && Number.isSafeInteger(op.template_id)) ids.add(op.template_id as number);
    if (op?.action === "unlink_global" && typeof op.element_id === "string") {
      const id = globalTemplateId(findElement(tree, op.element_id));
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

export function globalTemplateId(node: ElementNode | null): number | null {
  if (!node || node.widgetType !== GLOBAL_WIDGET_TYPE) return null;
  const id = Number(node.templateID);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export const LIMITS = { operations: 50, nodes: 5000, depth: 24, bytes: 4 * 1024 * 1024 };

export class ElementorOperationError extends Error {
  constructor(readonly code: string, message: string, readonly operationIndex?: number) {
    super(operationIndex === undefined ? message : `Operation ${operationIndex}: ${message}`);
    this.name = "ElementorOperationError";
  }
}

// ---- canonical form & hashing ---------------------------------------------------------

// The editor config adds rendered htmlCache to each element; it is derived output, not
// layout, and must not leak into saves or make the REST and session views hash apart.
export function canonicalize(tree: unknown): ElementNode[] {
  if (!Array.isArray(tree)) throw new ElementorOperationError("invalid_document", "Elementor data is not an element array");
  const strip = (node: ElementNode): ElementNode => {
    const { htmlCache: _html, ...rest } = node;
    return { ...rest, elements: Array.isArray(node.elements) ? node.elements.map(strip) : [] } as ElementNode;
  };
  return (tree as ElementNode[]).map(strip);
}

export function parseElementorData(raw: unknown): ElementNode[] {
  if (Array.isArray(raw)) return canonicalize(raw);
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    return canonicalize(JSON.parse(raw));
  } catch (err) {
    if (err instanceof ElementorOperationError) throw err;
    throw new ElementorOperationError("invalid_document", "Stored Elementor data is not valid JSON");
  }
}

export function hashTree(tree: ElementNode[]): string {
  return createHash("sha256").update(JSON.stringify(tree)).digest("hex");
}

// ---- traversal ------------------------------------------------------------------------

interface Located { node: ElementNode; parent: ElementNode | null; siblings: ElementNode[]; index: number; depth: number }

function walk(tree: ElementNode[], visit: (entry: Located) => void, parent: ElementNode | null = null, depth = 1): void {
  tree.forEach((node, index) => {
    visit({ node, parent, siblings: tree, index, depth });
    walk(node.elements ?? [], visit, node, depth + 1);
  });
}

function locate(tree: ElementNode[], id: string): Located | null {
  let found: Located | null = null;
  walk(tree, (entry) => { if (!found && entry.node.id === id) found = entry; });
  return found;
}

export function findElement(tree: ElementNode[], id: string): ElementNode | null {
  return locate(tree, id)?.node ?? null;
}

function collectIds(tree: ElementNode[]): Set<string> {
  const ids = new Set<string>();
  walk(tree, ({ node }) => ids.add(node.id));
  return ids;
}

// ---- outline --------------------------------------------------------------------------

export interface OutlineNode {
  id: string;
  elType: string;
  widgetType?: string;
  label?: string;
  children?: OutlineNode[];
}

const LABEL_KEYS = ["title", "editor", "text", "heading", "button_text", "description_text", "title_text", "caption", "tab_title", "html"];

function plainLabel(settings: ElementNode["settings"]): string | undefined {
  if (Array.isArray(settings)) return undefined;
  for (const key of LABEL_KEYS) {
    const value = settings[key];
    if (typeof value === "string" && value.trim()) {
      const text = value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
      if (text) return text.length > 80 ? `${text.slice(0, 77)}...` : text;
    }
  }
  return undefined;
}

export function outline(tree: ElementNode[]): OutlineNode[] {
  return tree.map((node) => {
    const templateId = globalTemplateId(node);
    const label = templateId ? `global widget (template ${templateId}, read-only)` : plainLabel(node.settings);
    return {
      id: node.id, elType: node.elType,
      ...(node.widgetType ? { widgetType: node.widgetType } : {}),
      ...(label ? { label } : {}),
      ...(node.elements?.length ? { children: outline(node.elements) } : {})
    };
  });
}

export function countNodes(tree: ElementNode[]): number {
  let count = 0;
  walk(tree, () => count++);
  return count;
}

// ---- high-risk content (D10) ----------------------------------------------------------

// Widgets and settings that can place arbitrary HTML/JS/CSS on the page. Writing them is
// effectively a stored-XSS path, so the medium-risk tool refuses to create or modify
// them; moving or removing existing ones stays allowed.
export const UNSAFE_WIDGET_TYPES = new Set(["html", "shortcode", "wp-widget-custom_html"]);
export const UNSAFE_SETTING_KEYS = new Set(["custom_css", "_attributes", "custom_attributes"]);
const UNSAFE_MARKUP = /<\s*(script|iframe|object|embed|style|link|meta)\b|javascript\s*:|<[^>]+\son[a-z]+\s*=/i;
const UNSAFE_DYNAMIC_TAG = /name=\\?["'](shortcode|html)/i;

function unsafeValue(value: unknown, key: string): string | null {
  if (UNSAFE_SETTING_KEYS.has(key)) return `setting "${key}"`;
  if (typeof value === "string") {
    if (UNSAFE_MARKUP.test(value)) return `markup in "${key}"`;
    if (key === "__dynamic__" && UNSAFE_DYNAMIC_TAG.test(value)) return "a shortcode/HTML dynamic tag";
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = unsafeValue(item, key); if (found) return found; }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      const found = unsafeValue(child, key === "__dynamic__" ? "__dynamic__" : childKey);
      if (found) return found;
    }
  }
  return null;
}

export function assertSafeSettings(settings: Record<string, unknown>, index: number): void {
  for (const [key, value] of Object.entries(settings)) {
    if (value === null) continue;
    const found = unsafeValue(value, key);
    if (found) throw unsafe(index, found);
  }
}

function assertSafeElement(element: ElementInput | ElementNode, index: number): void {
  if (element.widgetType && UNSAFE_WIDGET_TYPES.has(element.widgetType)) throw unsafe(index, `widget type "${element.widgetType}"`);
  if (element.settings && !Array.isArray(element.settings)) assertSafeSettings(element.settings, index);
  for (const child of element.elements ?? []) assertSafeElement(child as ElementInput, index);
}

function unsafe(index: number, what: string): ElementorOperationError {
  return new ElementorOperationError("unsafe_content", `${what} can inject raw HTML/JS/CSS and needs the separately granted unsafe-operations tool`, index);
}

// ---- structure rules (5.3) ------------------------------------------------------------

const ID_PATTERN = /^[0-9a-f]{7,8}$/;
const TYPE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,99}$/;
const NESTING_WIDGET = /^nested-|^mega-menu$|^e-/;

function allowedChild(parent: ElementNode | ElementInput | null, child: ElementInput | ElementNode): string | null {
  const type = child.elType;
  if (parent === null) return type === "widget" || type === "column" ? `a ${type} cannot be placed at the top level` : null;
  switch (parent.elType) {
    case "section": return type === "column" ? null : "sections may only contain columns";
    case "column": return ["widget", "section", "container"].includes(type) ? null : "columns may contain widgets, inner sections or containers";
    case "container": return type === "section" || type === "column" ? "containers cannot contain sections or columns" : null;
    case "widget":
      if (!NESTING_WIDGET.test(parent.widgetType ?? "")) return `widget "${parent.widgetType ?? "?"}" cannot contain elements`;
      return type === "section" || type === "column" ? "nested widgets cannot contain sections or columns" : null;
    default:
      // Atomic (v4) element types: permissive, but never legacy section/column children.
      return type === "section" || type === "column" ? `${parent.elType} cannot contain sections or columns` : null;
  }
}

export interface ApplyOptions {
  // Layouts of templates referenced by insert_template / unlink_global, loaded by the
  // caller beforehand (see referencedTemplateIds).
  templates?: Map<number, ElementNode[]>;
  // Widget types registered on the site, when the transport can list them. Without a
  // list, unknown types only produce a warning because they cannot be verified.
  knownWidgetTypes?: Set<string>;
  allowUnsafe?: boolean;
  newId?: (taken: Set<string>) => string;
}

export interface ApplyResult {
  tree: ElementNode[];
  createdIds: string[];
  warnings: string[];
}

function defaultNewId(taken: Set<string>): string {
  for (;;) {
    const id = randomBytes(4).toString("hex").slice(0, 7);
    if (!taken.has(id)) return id;
  }
}

// Materialize an ElementInput into a stored node, validating its whole subtree.
function build(input: ElementInput, parent: ElementNode | null, index: number, taken: Set<string>, created: string[], options: ApplyOptions, warnings: string[]): ElementNode {
  if (!input || typeof input !== "object") throw new ElementorOperationError("invalid_element", "element must be an object", index);
  if (typeof input.elType !== "string" || !TYPE_PATTERN.test(input.elType)) throw new ElementorOperationError("invalid_element", "elType is missing or invalid", index);
  if (input.elType === "widget") {
    if (typeof input.widgetType !== "string" || !TYPE_PATTERN.test(input.widgetType)) throw new ElementorOperationError("invalid_element", "widgets need a valid widgetType", index);
    if (options.knownWidgetTypes && !options.knownWidgetTypes.has(input.widgetType)) {
      throw new ElementorOperationError("unknown_widget_type", `widget type "${input.widgetType}" is not registered on this site`, index);
    }
    if (!options.knownWidgetTypes) warnings.push(`widget_type_unverified:${input.widgetType}`);
  } else if (input.widgetType !== undefined) {
    throw new ElementorOperationError("invalid_element", "only widgets may set widgetType", index);
  }
  const placement = allowedChild(parent, input);
  if (placement) throw new ElementorOperationError("invalid_structure", placement, index);
  if (input.settings !== undefined && (typeof input.settings !== "object" || input.settings === null || Array.isArray(input.settings))) {
    throw new ElementorOperationError("invalid_element", "settings must be an object", index);
  }
  let id = input.id;
  if (id !== undefined) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new ElementorOperationError("invalid_element", `id "${String(id)}" must be 7–8 lowercase hex characters`, index);
    if (taken.has(id)) throw new ElementorOperationError("duplicate_id", `id "${id}" is already used in this document`, index);
  } else {
    id = (options.newId ?? defaultNewId)(taken);
  }
  taken.add(id);
  created.push(id);
  const node: ElementNode = {
    id, elType: input.elType,
    ...(input.widgetType ? { widgetType: input.widgetType } : {}),
    ...(input.isInner !== undefined ? { isInner: input.isInner === true } : {}),
    settings: input.settings ?? {},
    elements: []
  };
  // Inner sections/containers are flagged the way the editor flags them.
  if (parent && (node.elType === "section" || node.elType === "container") && node.isInner === undefined) node.isInner = true;
  node.elements = (input.elements ?? []).map((child) => build(child, node, index, taken, created, options, warnings));
  return node;
}

function cloneWithFreshIds(node: ElementNode, taken: Set<string>, created: string[], options: ApplyOptions): ElementNode {
  const id = (options.newId ?? defaultNewId)(taken);
  taken.add(id);
  created.push(id);
  return { ...structuredClone(node), id, elements: node.elements.map((child) => cloneWithFreshIds(child, taken, created, options)) };
}

function assertNotGlobal(node: ElementNode, index: number): void {
  const templateId = globalTemplateId(node);
  if (templateId) {
    throw new ElementorOperationError("global_widget_read_only",
      `element "${node.id}" is a global widget shared with other pages; edit template ${templateId} instead, or unlink it first (unlink_global)`, index);
  }
}

function insertAt(siblings: ElementNode[], node: ElementNode, index: number | undefined, opIndex: number): void {
  const at = index === undefined ? siblings.length : index;
  if (!Number.isInteger(at) || at < 0 || at > siblings.length) {
    throw new ElementorOperationError("invalid_index", `index ${String(index)} is outside 0–${siblings.length}`, opIndex);
  }
  siblings.splice(at, 0, node);
}

function childrenOf(tree: ElementNode[], parentId: string | null, opIndex: number): { parent: ElementNode | null; siblings: ElementNode[] } {
  if (parentId === null) return { parent: null, siblings: tree };
  const parent = findElement(tree, parentId);
  if (!parent) throw new ElementorOperationError("element_not_found", `parent "${parentId}" does not exist`, opIndex);
  parent.elements ??= [];
  return { parent, siblings: parent.elements };
}

function isWithin(node: ElementNode, id: string): boolean {
  return node.id === id || node.elements.some((child) => isWithin(child, id));
}

function requireId(value: unknown, field: string, index: number): string {
  if (typeof value !== "string" || !value) throw new ElementorOperationError("invalid_operation", `${field} is required`, index);
  return value;
}

// Apply a batch all-or-nothing to a copy of the tree. Any failure throws and the caller
// saves nothing (5.2 "all or nothing").
export function applyOperations(source: ElementNode[], operations: unknown, options: ApplyOptions = {}): ApplyResult {
  if (!Array.isArray(operations) || operations.length === 0) throw new ElementorOperationError("invalid_operation", "operations must be a non-empty array");
  if (operations.length > LIMITS.operations) throw new ElementorOperationError("too_many_operations", `at most ${LIMITS.operations} operations per call`);
  const tree = structuredClone(source);
  const taken = collectIds(tree);
  const createdIds: string[] = [];
  const warnings: string[] = [];

  operations.forEach((raw, index) => {
    const op = raw as Record<string, unknown>;
    if (!op || typeof op !== "object") throw new ElementorOperationError("invalid_operation", "operation must be an object", index);
    switch (op.action) {
      case "update_settings": {
        const id = requireId(op.element_id, "element_id", index);
        const found = locate(tree, id);
        if (!found) throw new ElementorOperationError("element_not_found", `element "${id}" does not exist`, index);
        const patch = op.settings;
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new ElementorOperationError("invalid_operation", "settings must be an object", index);
        assertNotGlobal(found.node, index);
        if (!options.allowUnsafe) {
          if (found.node.widgetType && UNSAFE_WIDGET_TYPES.has(found.node.widgetType)) throw unsafe(index, `widget type "${found.node.widgetType}"`);
          assertSafeSettings(patch as Record<string, unknown>, index);
        }
        const settings: Record<string, unknown> = Array.isArray(found.node.settings) ? {} : { ...found.node.settings };
        for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
          if (value === null) delete settings[key];
          else settings[key] = value;
        }
        found.node.settings = settings;
        break;
      }
      case "insert": {
        const element = op.element as ElementInput;
        if (!options.allowUnsafe && element) assertSafeElement(element, index);
        const parentId = op.parent_id === undefined ? null : (op.parent_id as string | null);
        const { parent, siblings } = childrenOf(tree, parentId, index);
        insertAt(siblings, build(element, parent, index, taken, createdIds, options, warnings), op.index as number | undefined, index);
        break;
      }
      case "remove": {
        const id = requireId(op.element_id, "element_id", index);
        const found = locate(tree, id);
        if (!found) throw new ElementorOperationError("element_not_found", `element "${id}" does not exist`, index);
        found.siblings.splice(found.index, 1);
        walk([found.node], ({ node }) => taken.delete(node.id));
        break;
      }
      case "move": {
        const id = requireId(op.element_id, "element_id", index);
        const found = locate(tree, id);
        if (!found) throw new ElementorOperationError("element_not_found", `element "${id}" does not exist`, index);
        const parentId = op.parent_id === undefined ? null : (op.parent_id as string | null);
        if (parentId !== null && isWithin(found.node, parentId)) throw new ElementorOperationError("invalid_structure", "an element cannot be moved into itself", index);
        found.siblings.splice(found.index, 1);
        const { parent, siblings } = childrenOf(tree, parentId, index);
        const placement = allowedChild(parent, found.node);
        if (placement) throw new ElementorOperationError("invalid_structure", placement, index);
        if (found.node.elType === "section" || found.node.elType === "container") {
          if (parent) found.node.isInner = true; else if (found.node.isInner) found.node.isInner = false;
        }
        insertAt(siblings, found.node, op.index as number | undefined, index);
        break;
      }
      case "duplicate": {
        const id = requireId(op.element_id, "element_id", index);
        const found = locate(tree, id);
        if (!found) throw new ElementorOperationError("element_not_found", `element "${id}" does not exist`, index);
        if (!options.allowUnsafe) assertSafeElement(found.node, index);
        const copy = cloneWithFreshIds(found.node, taken, createdIds, options);
        if (op.parent_id === undefined) {
          insertAt(found.siblings, copy, op.index === undefined ? found.index + 1 : (op.index as number), index);
        } else {
          const { parent, siblings } = childrenOf(tree, op.parent_id as string | null, index);
          const placement = allowedChild(parent, copy);
          if (placement) throw new ElementorOperationError("invalid_structure", placement, index);
          insertAt(siblings, copy, op.index as number | undefined, index);
        }
        break;
      }
      case "replace": {
        const id = requireId(op.element_id, "element_id", index);
        const found = locate(tree, id);
        if (!found) throw new ElementorOperationError("element_not_found", `element "${id}" does not exist`, index);
        assertNotGlobal(found.node, index);
        const element = op.element as ElementInput;
        if (!options.allowUnsafe && element) assertSafeElement(element, index);
        walk([found.node], ({ node }) => taken.delete(node.id));
        // Keep the original id unless the replacement names its own, so references hold.
        const replacement = build({ ...element, id: element?.id ?? id }, found.parent, index, taken, createdIds, options, warnings);
        if (replacement.id === id) createdIds.splice(createdIds.indexOf(id), 1);
        found.siblings[found.index] = replacement;
        break;
      }
      case "unlink_global": {
        const id = requireId(op.element_id, "element_id", index);
        const found = locate(tree, id);
        if (!found) throw new ElementorOperationError("element_not_found", `element "${id}" does not exist`, index);
        const templateId = globalTemplateId(found.node);
        if (!templateId) throw new ElementorOperationError("invalid_operation", `element "${id}" is not a global widget`, index);
        const source = options.templates?.get(templateId)?.[0];
        if (!source) throw new ElementorOperationError("template_not_found", `global widget template ${templateId} could not be loaded`, index);
        if (!options.allowUnsafe) assertSafeElement(source, index);
        const copy = cloneWithFreshIds(source, taken, createdIds, options);
        const placement = allowedChild(found.parent, copy);
        if (placement) throw new ElementorOperationError("invalid_structure", placement, index);
        found.siblings[found.index] = copy;
        taken.delete(id);
        break;
      }
      case "insert_template": {
        const templateId = op.template_id;
        if (!Number.isSafeInteger(templateId)) throw new ElementorOperationError("invalid_operation", "template_id must be an integer", index);
        const elements = options.templates?.get(templateId as number);
        if (!elements) throw new ElementorOperationError("template_not_found", `template ${String(templateId)} could not be loaded`, index);
        if (!elements.length) throw new ElementorOperationError("invalid_operation", `template ${String(templateId)} is empty`, index);
        const parentId = op.parent_id === undefined ? null : (op.parent_id as string | null);
        const { parent, siblings } = childrenOf(tree, parentId, index);
        let at = op.index === undefined ? siblings.length : (op.index as number);
        for (const source of elements) {
          if (!options.allowUnsafe) assertSafeElement(source, index);
          const copy = cloneWithFreshIds(source, taken, createdIds, options);
          const placement = allowedChild(parent, copy);
          if (placement) throw new ElementorOperationError("invalid_structure", placement, index);
          if (copy.elType === "section" || copy.elType === "container") copy.isInner = parent !== null;
          insertAt(siblings, copy, at, index);
          at++;
        }
        break;
      }
      default:
        throw new ElementorOperationError("invalid_operation", `unknown action "${String(op.action)}"`, index);
    }
  });

  assertWithinLimits(tree);
  return { tree, createdIds, warnings: [...new Set(warnings)] };
}

export function assertWithinLimits(tree: ElementNode[]): void {
  let nodes = 0, depth = 0;
  walk(tree, (entry) => { nodes++; depth = Math.max(depth, entry.depth); });
  if (nodes > LIMITS.nodes) throw new ElementorOperationError("document_too_large", `documents are limited to ${LIMITS.nodes} elements`);
  if (depth > LIMITS.depth) throw new ElementorOperationError("document_too_deep", `documents are limited to ${LIMITS.depth} levels of nesting`);
  if (Buffer.byteLength(JSON.stringify(tree)) > LIMITS.bytes) throw new ElementorOperationError("document_too_large", `documents are limited to ${LIMITS.bytes} bytes`);
}
