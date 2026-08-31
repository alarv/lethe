/**
 * Configuration, and the questions `lethe doctor` has to answer about it: what
 * git actually does with the claims in a repository, and whether any config file
 * still sets the `scope` setting that no longer exists.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { claimSharing, ignoreInGit, shareDefault, staleConfig, staleRootIgnore } from "./config.js";

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
    // No !config.json: there is no project config file any more. The one
    // setting left is global, and .lethe/.gitignore is the project's answer.
    assert.equal(lines.includes("!config.json"), false);
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

test("claims in the repo that git ignores read as ignored, which is now an answer", () => {
  withRepo((root) => {
    writeFileSync(join(root, ".gitignore"), ".lethe/memory/\n");
    writeClaim(root, "a-one.md");
    const s = claimSharing(root);
    // This used to be doctor's one FAIL: `team` scope claimed sharing that a
    // .gitignore line revoked. Claims live in the repo either way now, so
    // ignored means private -- exactly what `lethe init --private` asks for.
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

// ----------------------------------------------------------- staleConfig

/** Both config paths, with LETHE_HOME pointed somewhere disposable. */
function withHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "lethe-test-home-"));
  const previous = process.env.LETHE_HOME;
  process.env.LETHE_HOME = home;
  try {
    fn(home);
  } finally {
    if (previous === undefined) delete process.env.LETHE_HOME;
    else process.env.LETHE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

test("staleConfig names every file still setting the removed `scope`", () => {
  withHome((home) => {
    withRepo((root) => {
      writeFileSync(join(home, "config.json"), JSON.stringify({ scope: "personal" }));
      mkdirSync(join(root, ".lethe"), { recursive: true });
      writeFileSync(join(root, ".lethe", "config.json"), JSON.stringify({ scope: "team" }));

      // Silence here would reproduce the failure the setting used to cause:
      // believing memory is somewhere it is not.
      assert.deepEqual(staleConfig(root), [
        join(home, "config.json"),
        join(root, ".lethe", "config.json"),
      ]);
    });
  });
});

test("staleConfig says nothing about files that do not set it", () => {
  withHome((home) => {
    withRepo((root) => {
      writeFileSync(join(home, "config.json"), JSON.stringify({ share: true }));
      assert.deepEqual(staleConfig(root), []);
    });
  });
});

test("staleConfig ignores a file it cannot parse rather than throwing", () => {
  withHome((home) => {
    withRepo((root) => {
      writeFileSync(join(home, "config.json"), "{ not json");
      assert.deepEqual(staleConfig(root), []);
    });
  });
});

// ---------------------------------------------------------- shareDefault

test("sharing is off unless it was asked for", () => {
  withHome(() => {
    // Writing memories into a repository is one thing; publishing them to
    // everyone who clones it is another, and must never follow from silence.
    assert.equal(shareDefault(), false);
  });
});

test("shareDefault reads only the global file, and only `share`", () => {
  withHome((home) => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ share: true }));
    assert.equal(shareDefault(), true);

    writeFileSync(join(home, "config.json"), JSON.stringify({ share: false }));
    assert.equal(shareDefault(), false);

    // Anything that is not exactly true is not sharing.
    writeFileSync(join(home, "config.json"), JSON.stringify({ share: "yes" }));
    assert.equal(shareDefault(), false);
  });
});

// ------------------------------------- private hides memories, not the rules

test("private mode hides the memories and commits nothing else", () => {
  withRepo((root) => {
    ignoreInGit(root, false);
    writeClaim(root, "a-one.md");
    // -uall, because git collapses a wholly-untracked directory to `?? .lethe/`
    // and the whole question is which files inside it are visible.
    const status = execFileSync("git", ["status", "--porcelain", "-uall"],
      { cwd: root, encoding: "utf8" });

    // The rules file is expected to show up -- it is meant to be committed. No
    // memory may ever appear, which is the property that matters.
    assert.equal(status.includes("memory"), false, `a claim reached git status:\n${status}`);
    assert.match(status, /\.lethe\/\.gitignore/);
  });
});

test("the ignore file is never ignored, in either mode", () => {
  // It was, briefly. Untracking a file that is already tracked is a change other
  // people receive: a teammate's pull deletes their copy, the rules vanish from
  // their working tree, and *their* private memories stop being ignored. A
  // checkout spanning the untracking commit does the same thing locally, which
  // is how it was caught.
  withRepo((root) => {
    for (const share of [true, false]) {
      ignoreInGit(root, share);
      const lines = readFileSync(join(root, ".lethe", ".gitignore"), "utf8").split("\n");
      assert.ok(lines.includes("!.gitignore"),
        `share=${share}: the rules must stay readable by git`);
      assert.equal(lines.includes("# !.gitignore"), false);
    }
  });
});

test("only the memory lines toggle, and they toggle in place", () => {
  withRepo((root) => {
    assert.equal(ignoreInGit(root, false), "added");
    const off = readFileSync(join(root, ".lethe", ".gitignore"), "utf8").split("\n");
    assert.ok(off.includes("# !memory/"));
    assert.ok(off.includes("# !memory/*.md"));

    assert.equal(ignoreInGit(root, true), "updated");
    const on = readFileSync(join(root, ".lethe", ".gitignore"), "utf8").split("\n");
    assert.ok(on.includes("!memory/"));
    assert.ok(on.includes("!memory/*.md"));

    assert.equal(ignoreInGit(root, true), "present", "no change needed twice");
  });
});
