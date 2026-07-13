import { describe, expect, it } from "vitest";
import { buildWpCliCommand, parseWpCliJson } from "./commands.js";

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

  it("does not expose arbitrary eval, shell, database query, or argument tools", () => {
    expect(() => buildWpCliCommand({ tool: "wordpress.eval" as never, input: {} })).toThrow("Unsupported WP-CLI tool");
  });

  it("parses json output", () => {
    expect(parseWpCliJson('[{"name":"akismet"}]')).toEqual([{ name: "akismet" }]);
  });
});
