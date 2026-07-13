import type { ToolDefinition } from "./definitions.js";

export interface RestAdapterCompatibility {
  minimumVersion?: string;
  maximumVersion?: string;
}

export interface RestAdapterDefinition {
  id: string;
  namespace: string;
  compatibility: RestAdapterCompatibility;
  tools: ToolDefinition[];
  redactedInputFields: string[];
  redactedOutputFields: string[];
  discover(namespaces: readonly string[], pluginVersion?: string): "available" | "unavailable" | "unknown";
}

export function validateRestAdapter(adapter: RestAdapterDefinition): string[] {
  const problems: string[] = [];
  if (!/^[a-z][a-z0-9_-]*$/.test(adapter.id)) problems.push("adapter id must be a stable identifier");
  if (!/^[a-z0-9_-]+\/v\d+$/.test(adapter.namespace)) problems.push("namespace must be explicit and versioned");
  if (adapter.tools.length === 0) problems.push("adapter must define at least one typed tool");
  for (const tool of adapter.tools) {
    if (tool.executorKind !== "rest") problems.push(`${tool.name} must use the REST executor`);
    if (!tool.name.startsWith(`wp_${adapter.id}_`)) problems.push(`${tool.name} must be namespaced to the adapter`);
  }
  return problems;
}
