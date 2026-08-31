/**
 * Configuration, and the two questions `lethe doctor` has to answer about it:
 * which config file won, and whether git agrees with the scope it set.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { SCOPE_NAMES, claimSharing, configSources, ignoreInGit, isScope, staleRootIgnore } from "./config.js";

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

test("the rules go inside .lethe, never in the repository root", () => {
  withRepo((root) => {
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    ignoreInGit(root, true);
    // Appending to a file the user owns is what lethe used to do, and it is how
    // a dead `.lethe/episodes/` line ended up in other people's repositories.
    assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "node_modules/\n");
    assert.ok(existsSync(join(root, ".lethe", ".gitignore")));
  });
});

test("it never mentions an episodes directory", () => {
  withRepo((root) => {
    ignoreInGit(root, true);
    const ignore = readFileSync(join(root, ".lethe", ".gitignore"), "utf8");
    // Episodes live in ~/.lethe regardless of scope. A line here protected
    // nothing and told the reader their raw notes were in the repo.
    assert.equal(ignore.includes("episodes"), false);
  });
});

test("it is a whitelist, so a future artifact cannot be committed by accident", () => {
  withRepo((root) => {
    ignoreInGit(root, true);
    const lines = readFileSync(join(root, ".lethe", ".gitignore"), "utf8").split("\n");
    assert.ok(lines.includes("*"), "must start from ignoring everything");
    assert.ok(lines.includes("!.gitignore"));
    assert.ok(lines.includes("!config.json"));
  });
});

test("sharing leaves the claim lines active, private comments them out", () => {
  withRepo((root) => {
    assert.equal(ignoreInGit(root, true), "added");
    const shared = readFileSync(join(root, ".lethe", ".gitignore"), "utf8");
    assert.match(shared, /^!memory\/$/m);
    assert.match(shared, /^!memory\/\*\.md$/m);
  });
  withRepo((root) => {
    assert.equal(ignoreInGit(root, false), "added");
    const priv = readFileSync(join(root, ".lethe", ".gitignore"), "utf8");
    assert.match(priv, /^# !memory\/$/m);
    assert.doesNotMatch(priv, /^!memory\//m);
  });
});

test("re-running with the same choice changes nothing", () => {
  withRepo((root) => {
    ignoreInGit(root, true);
    const before = readFileSync(join(root, ".lethe", ".gitignore"), "utf8");
    assert.equal(ignoreInGit(root, true), "present");
    assert.equal(readFileSync(join(root, ".lethe", ".gitignore"), "utf8"), before);
  });
});

test("flipping the choice toggles in place and keeps hand-added lines", () => {
  withRepo((root) => {
    ignoreInGit(root, true);
    const path = join(root, ".lethe", ".gitignore");
    writeFileSync(path, readFileSync(path, "utf8") + "scratch/\n");

    assert.equal(ignoreInGit(root, false), "updated");
    let now = readFileSync(path, "utf8");
    assert.match(now, /^# !memory\/$/m);
    assert.match(now, /^scratch\/$/m, "a hand-added line must survive");

    assert.equal(ignoreInGit(root, true), "updated");
    now = readFileSync(path, "utf8");
    assert.match(now, /^!memory\/$/m);
    assert.match(now, /^scratch\/$/m);
  });
});

test("a .gitignore lethe did not write is left alone", () => {
  withRepo((root) => {
    const path = join(root, ".lethe", ".gitignore");
    mkdirSync(join(root, ".lethe"), { recursive: true });
    writeFileSync(path, "# mine\n*.tmp\n");
    assert.equal(ignoreInGit(root, false), "foreign");
    assert.equal(readFileSync(path, "utf8"), "# mine\n*.tmp\n");
  });
});

test("the nested rules override a stale .lethe line left in the root", () => {
  withRepo((root) => {
    // What an older `lethe init` wrote. Git resolves the deeper file last, so
    // sharing still works without anyone having to clean the root up.
    writeFileSync(join(root, ".gitignore"), ".lethe/memory/\n");
    ignoreInGit(root, true);
    writeClaim(root, "a-one.md");
    assert.equal(claimSharing(root).state, "untracked");
  });
});

test("staleRootIgnore reports old root rules, active or commented", () => {
  withRepo((root) => {
    assert.deepEqual(staleRootIgnore(root), []);
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.lethe/memory/\n# .lethe/index.db\n");
    assert.deepEqual(staleRootIgnore(root), [".lethe/memory/", "# .lethe/index.db"]);
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

// -------------------------------------------------------------- isScope

test("isScope accepts the three scopes and nothing else", () => {
  for (const s of SCOPE_NAMES) assert.ok(isScope(s), `${s} must be a scope`);
  assert.equal(SCOPE_NAMES.length, 3);
  // `lethe init --scope=banana` used to write this to config.json, report
  // success, and then quietly resolve to local.
  for (const bad of ["banana", "Team", "team ", "", "team --private", undefined, null, 3]) {
    assert.equal(isScope(bad), false, `${String(bad)} must not be a scope`);
  }
});

test("an unreadable scope in a config file falls back rather than throwing", () => {
  const home = mkdtempSync(join(tmpdir(), "lethe-test-home-"));
  const previous = process.env.LETHE_HOME;
  process.env.LETHE_HOME = home;
  try {
    withRepo((root) => {
      mkdirSync(join(root, ".lethe"), { recursive: true });
      writeFileSync(join(root, ".lethe", "config.json"), JSON.stringify({ scope: "banana" }));
      // configSources reports it verbatim so doctor can point at the file;
      // deciding it is junk is the caller's job.
      const sources = configSources(root);
      assert.equal(sources[1]!.scope, "banana");
      assert.equal(isScope(sources[1]!.scope), false);
    });
  } finally {
    if (previous === undefined) delete process.env.LETHE_HOME;
    else process.env.LETHE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
