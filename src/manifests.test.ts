/**
 * The files that describe a release to other machines.
 *
 * The MCP Registry, the Claude Code plugin marketplace and npm each carry their
 * own copy of the version, and nothing at publish time checks that they agree.
 * The directory reviewer does: a plugin whose launcher follows `@latest` is
 * blocked during validation, and a plugin pinned to a version that npm never
 * published installs nothing. Both failures are silent wherever we would notice
 * them, so they get a test.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>;
}

const pkg = json("package.json");
const server = json("server.json");
const plugin = json(".claude-plugin/plugin.json");
const marketplace = json(".claude-plugin/marketplace.json");
const version = pkg.version as string;

test("every release manifest carries the same version", () => {
  assert.equal(server.version, version);
  assert.equal(plugin.version, version);
  const packages = server.packages as { identifier: string; version: string }[];
  assert.equal(packages[0]?.identifier, pkg.name);
  assert.equal(packages[0]?.version, version);
});

test("the registry server name is the one package.json advertises", () => {
  // The registry refuses an npm package whose mcpName does not match the
  // server name, and it does so only at publish time.
  assert.equal(pkg.mcpName, server.name);
});

test("the plugin launches the version it was released with, not @latest", () => {
  // Anthropic's plugin validation blocks an unpinned npx launcher. Pinning also
  // means this line must change with every release, which the version test above
  // and this one between them enforce.
  const servers = plugin.mcpServers as Record<string, { args: string[] }>;
  const args = servers.lethe?.args ?? [];
  assert.ok(
    args.includes(`@alarv/lethe@${version}`),
    `plugin.json must launch @alarv/lethe@${version}, got: ${args.join(" ")}`,
  );
  assert.ok(!args.includes("@alarv/lethe@latest"));
});

test("the repository is its own marketplace", () => {
  const plugins = marketplace.plugins as { name: string; source: string }[];
  assert.deepEqual(
    plugins.map((p) => ({ name: p.name, source: p.source })),
    [{ name: "lethe", source: "./" }],
  );
  assert.equal(marketplace.name, "lethe");
});
