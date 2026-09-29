import type { PageBuilderAdapter, PageBuilderToolHandler } from "./adapter.js";
import { elementorAdapter } from "./elementor/adapter.js";

export * from "./adapter.js";
export * from "./elementor/tree.js";
export { elementorAdapter, CORE_WIDGET_TYPES } from "./elementor/adapter.js";
export { detectElementor, versionStatus, TESTED_ELEMENTOR } from "./elementor/service.js";

export const PAGE_BUILDER_ADAPTERS: PageBuilderAdapter[] = [elementorAdapter];

export const PAGE_BUILDER_TOOL_HANDLERS: Record<string, PageBuilderToolHandler> = Object.assign(
  {}, ...PAGE_BUILDER_ADAPTERS.map((adapter) => adapter.handlers)
);
