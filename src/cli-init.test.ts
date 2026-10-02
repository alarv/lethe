import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(fileURLToPath(new URL(".", import.meta.url)), "cli.js");

function inRepo(fn: (run: (...args: string[]) => string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "lethe-init-home-"));
  const repo = mkdtempSync(join(tmpdir(), "lethe-init-repo-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    fn((...args) => execFileSync(process.execPath, [cli, ...args], {
      cwd: repo, encoding: "utf8",
      env: { ...process.env, LETHE_HOME: home, NO_COLOR: "1", LETHE_TELEMETRY: "0" },
    }));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}

// init reported "memory empty" in a project holding eight notes, because it
// counted only claims seeded by `learn`.
test("init counts memories that were not seeded", () => {
  inRepo((run) => {
    run("note", "Tests need docker compose up first");
    const out = run("init", "--private");
    assert.match(out, /memory\s+1 memory recorded, none seeded/);
    assert.doesNotMatch(out, /memory\s+empty/);
  });
});

test("init still calls an empty store empty", () => {
  inRepo((run) => {
    assert.match(run("init", "--private"), /memory\s+empty/);
  });
});
