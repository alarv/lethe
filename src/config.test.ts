/**
 * Configuration, and the two questions `lethe doctor` has to answer about it:
 * which config file won, and whether git agrees with the scope it set.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { claimSharing, configSources, ignoreInGit } from "./config.js";

/** A real repository, because claimSharing asks git rather than parsing .gitignore. */
function withRepo(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "lethe-test-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeClaim(root: string, name: string): void {
  const dir = join(root, ".lethe", "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "---\nkind: claim\n---\n\nsomething true\n");
}

// ------------------------------------------------------------- ignoreInGit

test("ignoreInGit never mentions an episodes directory", () => {
  withRepo((root) => {
    ignoreInGit(root, true);
    const ignore = readFileSync(join(root, ".gitignore"), "utf8");
    // Episodes live in ~/.lethe regardless of scope. A line here protected
    // nothing and told the reader their raw notes were in the repo.
    assert.equal(ignore.includes("episodes"), false);
  });
});

test("sharing leaves the claims line commented out, private leaves it active", () => {
  withRepo((root) => {
    ignoreInGit(root, true);
    assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^# \.lethe\/memory\/$/m);
  });
  withRepo((root) => {
    ignoreInGit(root, false);
    assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^\.lethe\/memory\/$/m);
  });
});

test("an existing lethe section is left alone", () => {
  withRepo((root) => {
    writeFileSync(join(root, ".gitignore"), "# lethe: mine, hand-edited\n.lethe/memory/\n");
    assert.equal(ignoreInGit(root, true), "present");
    assert.equal(
      readFileSync(join(root, ".gitignore"), "utf8"),
      "# lethe: mine, hand-edited\n.lethe/memory/\n",
    );
  });
});

// ------------------------------------------------------------ claimSharing

test("no claims yet reads as empty, not as a problem", () => {
  withRepo((root) => {
    assert.equal(claimSharing(root).state, "empty");
    mkdirSync(join(root, ".lethe", "memory"), { recursive: true });
    assert.equal(claimSharing(root).state, "empty");
  });
});

test("claims written but not ignored are untracked, and countable", () => {
  withRepo((root) => {
    writeClaim(root, "a-one.md");
    writeClaim(root, "b-two.md");
    const s = claimSharing(root);
    assert.equal(s.state, "untracked");
    assert.equal(s.files, 2);
    assert.equal(s.tracked, 0);
  });
});

test("team scope plus a .gitignore line is the trap doctor has to catch", () => {
  withRepo((root) => {
    writeFileSync(join(root, ".gitignore"), ".lethe/memory/\n");
    writeClaim(root, "a-one.md");
    const s = claimSharing(root);
    // The files exist, in the repo, and nobody but this machine will see them.
    assert.equal(s.state, "ignored");
    assert.equal(s.files, 1);
  });
});

test("committed claims read as shared", () => {
  withRepo((root) => {
    writeClaim(root, "a-one.md");
    execFileSync("git", ["add", ".lethe/memory"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-qm", "claims"], { cwd: root, stdio: "ignore" });
    const s = claimSharing(root);
    assert.equal(s.state, "shared");
    assert.equal(s.tracked, 1);
  });
});

test("staged but uncommitted claims already count as shared", () => {
  withRepo((root) => {
    writeClaim(root, "a-one.md");
    execFileSync("git", ["add", ".lethe/memory"], { cwd: root, stdio: "ignore" });
    // ls-files reports the index, which is the point the decision was made.
    assert.equal(claimSharing(root).state, "shared");
  });
});

test("a directory git cannot answer for is unknown rather than wrong", () => {
  const root = mkdtempSync(join(tmpdir(), "lethe-test-norepo-"));
  try {
    writeClaim(root, "a-one.md");
    assert.equal(claimSharing(root).state, "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------- configSources

test("configSources reports both files, project last so the winner is last", () => {
  const home = mkdtempSync(join(tmpdir(), "lethe-test-home-"));
  const previous = process.env.LETHE_HOME;
  process.env.LETHE_HOME = home;
  try {
    withRepo((root) => {
      writeFileSync(join(home, "config.json"), JSON.stringify({ scope: "personal" }));
      mkdirSync(join(root, ".lethe"), { recursive: true });
      writeFileSync(join(root, ".lethe", "config.json"), JSON.stringify({ scope: "team" }));

      const sources = configSources(root);
      assert.equal(sources.length, 2);
      assert.equal(sources[0]!.path, join(home, "config.json"));
      assert.equal(sources[0]!.scope, "personal");
      assert.equal(sources[1]!.path, join(root, ".lethe", "config.json"));
      assert.equal(sources[1]!.scope, "team");
      assert.ok(sources.every((s) => s.exists));
    });
  } finally {
    if (previous === undefined) delete process.env.LETHE_HOME;
    else process.env.LETHE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a config file that does not exist is reported, not hidden", () => {
  const home = mkdtempSync(join(tmpdir(), "lethe-test-home-"));
  const previous = process.env.LETHE_HOME;
  process.env.LETHE_HOME = home;
  try {
    withRepo((root) => {
      // Neither file written. Doctor still needs to be able to say where it
      // looked, otherwise "I set the scope" and "nothing took" cannot be told
      // apart from "you set it somewhere I do not read".
      const sources = configSources(root);
      assert.equal(sources.length, 2);
      assert.ok(sources.every((s) => !s.exists));
      assert.ok(sources.every((s) => s.scope === undefined));
    });
  } finally {
    if (previous === undefined) delete process.env.LETHE_HOME;
    else process.env.LETHE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
