import { PluginRegistry, type BrokerPlugin } from "@aibroker/plugin-sdk";
import { wordpressPlugin } from "@aibroker/plugin-wordpress";
import { sshPlugin } from "@aibroker/plugin-ssh";
import { postgresPlugin } from "@aibroker/plugin-postgres";
import { playwrightPlugin } from "@aibroker/plugin-playwright";

export const BUILT_IN_PLUGINS: readonly BrokerPlugin[] = [wordpressPlugin, sshPlugin, postgresPlugin, playwrightPlugin];

export function createBuiltInPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  for (const plugin of BUILT_IN_PLUGINS) registry.register(plugin);
  return registry;
}

export { wordpressPlugin, sshPlugin, postgresPlugin, playwrightPlugin };
