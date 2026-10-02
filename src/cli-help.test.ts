import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(fileURLToPath(new URL(".", import.meta.url)), "cli.js");

// `lethe init --help` ran init. Every command that writes must treat a request
// for help as nothing more than that.
for (const cmd of ["init", "note", "forget", "compact", "gc", "learn", "telemetry", "rules"]) {
  for (const flag of ["--help", "-h"]) {
    test(`lethe ${cmd} ${flag} prints usage and touches nothing`, () => {
      const home = mkdtempSync(join(tmpdir(), "lethe-help-home-"));
      const repo = mkdtempSync(join(tmpdir(), "lethe-help-repo-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        const out = execFileSync(process.execPath, [cli, cmd, flag], {
          cwd: repo, env: { ...process.env, LETHE_HOME: home, NO_COLOR: "1" }, encoding: "utf8",
        });
        assert.match(out, new RegExp(`lethe ${cmd}`));
        assert.deepEqual(readdirSync(home), [], "nothing written to the lethe home");
        assert.ok(!existsSync(join(repo, ".lethe")), "nothing written to the repo");
        assert.ok(!existsSync(join(repo, "AGENTS.md")), "rules did not run");
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(repo, { recursive: true, force: true });
      }
    });
  }
}

test("lethe --help and -h print the whole usage", () => {
  for (const flag of ["--help", "-h"]) {
    const out = execFileSync(process.execPath, [cli, flag], { encoding: "utf8" });
    assert.match(out, /lethe init/);
    assert.match(out, /lethe recall/);
  }
});
