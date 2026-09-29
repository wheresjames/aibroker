import { describe, expect, it } from "vitest";
import { applyOperations, canonicalize, ElementorOperationError, hashTree, outline, parseElementorData, type ElementNode } from "./tree.js";

const doc = (): ElementNode[] => [
  { id: "c0000001", elType: "container", settings: [], elements: [
    { id: "164e6f4c", elType: "widget", widgetType: "heading", settings: { title: "Accessibility Philosophy", title_color: "#ff0000" }, elements: [] },
    { id: "5e6f7a8", elType: "widget", widgetType: "text-editor", settings: { editor: "<p>Body</p>" }, elements: [] }
  ] },
  { id: "s0000001", elType: "section", settings: {}, elements: [
    { id: "c0100001", elType: "column", settings: {}, elements: [
      { id: "h0000001", elType: "widget", widgetType: "html", settings: { html: "<b>raw</b>" }, elements: [] }
    ] }
  ] }
];

let seq = 0;
const newId = () => `a${String(++seq).padStart(6, "0")}`;
const apply = (operations: unknown[], tree = doc()) => applyOperations(tree, operations, { newId });
const code = (fn: () => unknown) => { try { fn(); } catch (err) { return (err as ElementorOperationError).code; } return "no error"; };

describe("canonical form", () => {
  it("strips editor-only htmlCache so REST and session reads hash the same", () => {
    const withCache = doc();
    (withCache[0]!.elements[0] as ElementNode).htmlCache = "<h2>x</h2>";
    expect(hashTree(canonicalize(withCache))).toBe(hashTree(doc()));
  });

  it("parses stored JSON and rejects garbage", () => {
    expect(parseElementorData(JSON.stringify(doc()))).toEqual(doc());
    expect(parseElementorData("")).toEqual([]);
    expect(code(() => parseElementorData("{nope"))).toBe("invalid_document");
  });
});

describe("applyOperations", () => {
  it("merges settings and deletes keys set to null", () => {
    const { tree } = apply([{ action: "update_settings", element_id: "164e6f4c", settings: { title: "Philosophy", title_color: null } }]);
    expect(tree[0]!.elements[0]!.settings).toEqual({ title: "Philosophy" });
  });

  it("never mutates the source tree", () => {
    const source = doc();
    apply([{ action: "remove", element_id: "164e6f4c" }], source);
    expect(source).toEqual(doc());
  });

  it("inserts, moves, duplicates and replaces with fresh unique ids", () => {
    const { tree, createdIds } = apply([
      { action: "insert", parent_id: "c0000001", index: 0, element: { elType: "widget", widgetType: "button", settings: { text: "Go" } } },
      { action: "move", element_id: "5e6f7a8", parent_id: "c0100001", index: 0 },
      { action: "duplicate", element_id: "164e6f4c" },
      { action: "replace", element_id: "164e6f4c", element: { elType: "widget", widgetType: "heading", settings: { title: "New" } } }
    ]);
    const container = tree[0]!.elements.map((node) => node.widgetType);
    expect(container).toEqual(["button", "heading", "heading"]);
    expect(tree[0]!.elements[1]!.id).toBe("164e6f4c");
    expect(tree[0]!.elements[1]!.settings).toEqual({ title: "New" });
    expect(tree[1]!.elements[0]!.elements[0]!.id).toBe("5e6f7a8");
    expect(createdIds).toHaveLength(2);
    expect(new Set(createdIds).size).toBe(2);
  });

  it("marks nested sections/containers as inner, and clears it at the top level", () => {
    const { tree } = apply([
      { action: "insert", parent_id: "c0100001", element: { elType: "container", elements: [{ elType: "widget", widgetType: "spacer" }] } },
      { action: "insert", parent_id: null, element: { elType: "container" } }
    ]);
    expect(tree[1]!.elements[0]!.elements.at(-1)!.isInner).toBe(true);
    expect(tree.at(-1)!.isInner).toBeUndefined();
  });

  it("enforces classic and container structure rules", () => {
    expect(code(() => apply([{ action: "insert", parent_id: null, element: { elType: "widget", widgetType: "heading" } }]))).toBe("invalid_structure");
    expect(code(() => apply([{ action: "insert", parent_id: "s0000001", element: { elType: "widget", widgetType: "heading" } }]))).toBe("invalid_structure");
    expect(code(() => apply([{ action: "insert", parent_id: "c0000001", element: { elType: "column" } }]))).toBe("invalid_structure");
    expect(code(() => apply([{ action: "insert", parent_id: "164e6f4c", element: { elType: "widget", widgetType: "heading" } }]))).toBe("invalid_structure");
    expect(code(() => apply([{ action: "move", element_id: "c0000001", parent_id: "164e6f4c" }]))).toBe("invalid_structure");
    expect(code(() => apply([{ action: "move", element_id: "s0000001", parent_id: "c0100001" }]))).toBe("invalid_structure");
  });

  it("rejects bad ids, duplicates, unknown elements and bad indexes", () => {
    expect(code(() => apply([{ action: "insert", parent_id: "c0000001", element: { id: "NOTHEX!", elType: "widget", widgetType: "heading" } }]))).toBe("invalid_element");
    expect(code(() => apply([{ action: "insert", parent_id: "c0000001", element: { id: "164e6f4c", elType: "widget", widgetType: "heading" } }]))).toBe("duplicate_id");
    expect(code(() => apply([{ action: "remove", element_id: "missing" }]))).toBe("element_not_found");
    expect(code(() => apply([{ action: "insert", parent_id: "c0000001", index: 9, element: { elType: "widget", widgetType: "heading" } }]))).toBe("invalid_index");
    expect(code(() => apply([{ action: "explode" }]))).toBe("invalid_operation");
    expect(code(() => apply([]))).toBe("invalid_operation");
    expect(code(() => apply(Array.from({ length: 51 }, () => ({ action: "remove", element_id: "x" }))))).toBe("too_many_operations");
  });

  it("is all-or-nothing: a late failure reports its index", () => {
    try {
      apply([{ action: "update_settings", element_id: "164e6f4c", settings: { title: "ok" } }, { action: "remove", element_id: "missing" }]);
      throw new Error("expected failure");
    } catch (err) {
      expect(err).toBeInstanceOf(ElementorOperationError);
      expect((err as ElementorOperationError).operationIndex).toBe(1);
    }
  });

  it("checks widget types against the site's registered list when one is known", () => {
    const known = new Set(["heading"]);
    expect(code(() => applyOperations(doc(), [{ action: "insert", parent_id: "c0000001", element: { elType: "widget", widgetType: "form" } }], { knownWidgetTypes: known }))).toBe("unknown_widget_type");
    const { warnings } = apply([{ action: "insert", parent_id: "c0000001", element: { elType: "widget", widgetType: "form" } }]);
    expect(warnings).toEqual(["widget_type_unverified:form"]);
  });
});

describe("high-risk content (D10)", () => {
  it("blocks creating raw HTML/shortcode widgets and unsafe settings", () => {
    expect(code(() => apply([{ action: "insert", parent_id: "c0000001", element: { elType: "widget", widgetType: "html", settings: { html: "hi" } } }]))).toBe("unsafe_content");
    expect(code(() => apply([{ action: "update_settings", element_id: "164e6f4c", settings: { custom_css: "selector{}" } }]))).toBe("unsafe_content");
    expect(code(() => apply([{ action: "update_settings", element_id: "164e6f4c", settings: { _attributes: "onclick|x" } }]))).toBe("unsafe_content");
    expect(code(() => apply([{ action: "update_settings", element_id: "5e6f7a8", settings: { editor: "<p onclick=\"x()\">a</p>" } }]))).toBe("unsafe_content");
    expect(code(() => apply([{ action: "update_settings", element_id: "5e6f7a8", settings: { editor: "<script>alert(1)</script>" } }]))).toBe("unsafe_content");
    expect(code(() => apply([{ action: "update_settings", element_id: "164e6f4c", settings: { link: { url: "javascript:alert(1)" } } }]))).toBe("unsafe_content");
    expect(code(() => apply([{ action: "update_settings", element_id: "164e6f4c", settings: { __dynamic__: { title: '[elementor-tag id="1" name="shortcode" settings="{}"]' } } }]))).toBe("unsafe_content");
  });

  it("blocks modifying or duplicating an existing HTML widget but allows moving and removing it", () => {
    expect(code(() => apply([{ action: "update_settings", element_id: "h0000001", settings: { html: "<b>x</b>" } }]))).toBe("unsafe_content");
    expect(code(() => apply([{ action: "duplicate", element_id: "h0000001" }]))).toBe("unsafe_content");
    expect(code(() => apply([{ action: "move", element_id: "h0000001", parent_id: "c0000001" }]))).toBe("no error");
    expect(code(() => apply([{ action: "remove", element_id: "h0000001" }]))).toBe("no error");
  });

  it("allows ordinary markup and the unsafe path when explicitly enabled", () => {
    expect(code(() => apply([{ action: "update_settings", element_id: "5e6f7a8", settings: { editor: '<p>Hi <a href="https://x.test">link</a></p>' } }]))).toBe("no error");
    expect(code(() => applyOperations(doc(), [{ action: "update_settings", element_id: "h0000001", settings: { html: "<script></script>" } }], { allowUnsafe: true }))).toBe("no error");
  });
});

describe("outline", () => {
  it("summarizes text and nests children", () => {
    const [first] = outline(doc());
    expect(first).toMatchObject({ id: "c0000001", elType: "container", children: [
      { id: "164e6f4c", widgetType: "heading", label: "Accessibility Philosophy" },
      { id: "5e6f7a8", widgetType: "text-editor", label: "Body" }
    ] });
  });
});
