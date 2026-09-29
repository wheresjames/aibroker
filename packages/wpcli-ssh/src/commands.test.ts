import { describe, expect, it } from "vitest";
import { buildNetworkCommand, buildWpCliCommand, parseWpCliJson } from "./commands.js";

describe("WP-CLI command allowlist", () => {
  it("builds only narrow diagnostic commands", () => {
    expect(buildWpCliCommand({ tool: "wordpress.list_plugins", wordpressPath: "/var/www/html" })).toEqual([
      "wp",
      "--path=/var/www/html",
      "plugin",
      "list",
      "--format=json"
    ]);
  });

  it("rejects suspicious binary paths", () => {
    expect(() => buildWpCliCommand({ tool: "wordpress.list_plugins", wpCliPath: "wp; rm -rf /" })).toThrow(
      "Invalid WP-CLI binary path"
    );
  });

  it("keeps user-controlled plugin names as one validated argument", () => {
    expect(buildWpCliCommand({ tool: "wordpress.install_plugin", input: { name: "akismet", activate: true } })).toEqual(["wp","plugin","install","akismet","--activate"]);
    expect(() => buildWpCliCommand({ tool: "wordpress.install_plugin", input: { name: "akismet;id" } })).toThrow("Invalid name");
  });

  it("rejects flag injection and non-slug plugin sources", () => {
    expect(() => buildWpCliCommand({ tool: "wordpress.remove_plugin", input: { name: "--all" } })).toThrow("Invalid name");
    expect(() => buildWpCliCommand({ tool: "wordpress.install_plugin", input: { name: "https://evil.example/x.zip" } })).toThrow("Invalid name");
    expect(() => buildWpCliCommand({ tool: "wordpress.install_plugin", input: { name: "/tmp/x.zip" } })).toThrow("Invalid name");
    expect(() => buildWpCliCommand({ tool: "wordpress.delete_cron_event", input: { hook: "--all" } })).toThrow("Invalid hook");
    expect(() => buildNetworkCommand("network_migrate_domain", "wp", null, { old_url: "--export=/var/www/html/dump.sql", new_url: "https://new.example" })).toThrow("Invalid old_url");
    expect(buildNetworkCommand("network_migrate_domain", "wp", null, { old_url: "https://old.example", new_url: "https://new.example" }).slice(1, 4))
      .toEqual(["search-replace", "https://old.example", "https://new.example"]);
  });

  it("does not expose arbitrary eval, shell, database query, or argument tools", () => {
    expect(() => buildWpCliCommand({ tool: "wordpress.eval" as never, input: {} })).toThrow("Unsupported WP-CLI tool");
  });

  it("parses json output", () => {
    expect(parseWpCliJson('[{"name":"akismet"}]')).toEqual([{ name: "akismet" }]);
  });
});
