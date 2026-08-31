/**
 * Configuration.
 *
 * There is one setting, in one file:
 *
 *   ~/.lethe/config.json    { "share": true }
 *
 * and it supplies nothing but the default answer `lethe init` offers in a
 * project that has not been set up yet. It is never consulted when a memory is
 * written.
 *
 * That is the point. Where a memory goes is derived from what it is (store.ts),
 * and whether a project's claims are shared is recorded in that project's
 * `.lethe/.gitignore` -- the file git actually reads. A `scope` setting used to
 * duplicate that second fact, so config and git could disagree, and `lethe
 * doctor` grew a whole section whose job was to explain which one had won.
 * Deleting the setting deleted the disagreement. Configuration is a cost paid by
 * every reader -- see docs/api-design.md.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot, letheHome } from "./store.js";

export interface Config {
  /**
   * Commit new projects' claims by default?
   *
   * Read only by `lethe init`, and only when the project has no
   * `.lethe/.gitignore` yet. Once that file exists it is the answer.
   */
  share?: boolean;
  /**
   * Write the diagnostic log to `~/.lethe/lethe.log`?
   *
   * Off by default -- see log.ts. Set by `lethe init --debug`. Read by log.ts
   * directly out of the JSON rather than through this module, which would close
   * an import cycle, so this field documents it rather than serving it.
   */
  log?: boolean;
}

function read(path: string): Config {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Config;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {}; // an unreadable config should not stop the tool working
  }
}

export function globalConfigPath(): string {
  return join(letheHome(), "config.json");
}

export function loadConfig(): Config {
  return read(globalConfigPath());
}

/**
 * What `lethe init` offers when a project has not chosen yet.
 *
 * Private unless you said otherwise: writing memories into a repository is one
 * thing, publishing them to everyone who clones it is another, and the second
 * should never be the consequence of not answering a question.
 */
export function shareDefault(): boolean {
  return loadConfig().share === true;
}

export function writeConfig(path: string, next: Config): void {
  const current = read(path);
  const merged = { ...current, ...next };
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
}

/**
 * The only thing a project decides: are its claims committed?
 *
 * Claims are written into `<repo>/.lethe/memory/` either way -- see store.ts §
 * claimDir -- so this file holds the whole of the sharing decision, and
 * flipping it moves no files at all.
 *
 * The rules go in `<repo>/.lethe/.gitignore`, not the repository root. A
 * subdirectory .gitignore governs its own directory, and patterns in the deeper
 * file win over the shallower one -- verified including the migration case,
 * where a stale `.lethe/memory/` left in the root by an older version is
 * correctly overridden by `!memory/` here. So lethe never has to append to, and
 * never has to parse, a file the user owns. It also means uninstalling is
 * `rm -rf .lethe` with nothing left behind.
 *
 * The list is a whitelist -- `*` then explicit exceptions -- so an artifact a
 * later version writes into this directory cannot reach a commit by accident.
 * The old form was a blacklist in the root .gitignore, which is how it came to
 * be protecting `.lethe/episodes/`, a directory that has never existed.
 *
 * Only claims are ever written into the repository. Episodes live under
 * `~/.lethe/projects/<key>/` whatever else is here, and the store relocates
 * any that predate that rule.
 */
export type IgnoreResult = "added" | "updated" | "present" | "foreign" | "failed";

/**
 * The one decision in the file: uncommented, claims are committed.
 *
 * `!.gitignore` is deliberately NOT part of it -- this file is always meant to
 * be committed, even when the memories are not.
 *
 * Having private mode ignore this file too is tempting, because it leaves
 * `git status` perfectly clean, and it was briefly implemented that way. It is
 * unsafe in the case the tool exists for. Untracking a file that is already
 * tracked is a change other people receive: a teammate's `git pull` deletes
 * their copy, so the rules vanish from their working tree and *their* private
 * memories stop being ignored. It bites locally too -- a checkout that spans the
 * untracking commit removes the file and exposes everything under `.lethe/`,
 * which is how this was found.
 *
 * So the deal is: one committed file saying "ignore everything in here", and the
 * memories themselves stay out of git. The cost is that a repository reveals
 * lethe is in use, which is not a secret worth this failure mode.
 */
const CLAIM_LINES = ["!memory/", "!memory/*.md"];
const CLAIM_PATTERN = /^\s*(#\s*)?!memory\//;

function renderIgnore(share: boolean): string {
  return [
    "# Managed by lethe -- see `lethe init`. Kept inside .lethe/ so lethe never",
    "# edits a .gitignore you own, and `rm -rf .lethe` leaves nothing behind.",
    "#",
    "# Everything is ignored by default, so anything a later version writes here",
    "# cannot reach a commit by accident. The two !memory lines are the whole",
    "# decision: uncommented, consolidated claims are committed and anyone",
    "# cloning this repo inherits what has been learned; commented out, they",
    "# stay on this machine and only you can read them.",
    "#",
    "# This file itself is always committed, even when the memories are not, so",
    "# that the rules cannot go missing from anyone's working tree.",
    "#",
    "# Episodes are not listed because they are never here -- they live in",
    "# ~/.lethe/projects/<key>/, keyed to this project.",
    "",
    "*",
    "!.gitignore",
    ...CLAIM_LINES.map((l) => (share ? l : `# ${l}`)),
    "",
  ].join("\n");
}

export function ignoreInGit(root: string, share: boolean): IgnoreResult {
  const dir = join(root, ".lethe");
  const path = join(dir, ".gitignore");
  try {
    if (!existsSync(path)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, renderIgnore(share), "utf8");
      return "added";
    }

    // Toggle in place rather than rewriting, so any lines someone added by
    // hand survive `lethe init` being run again.
    const lines = readFileSync(path, "utf8").split("\n");
    if (!lines.some((l) => CLAIM_PATTERN.test(l))) return "foreign";
    const shared = lines.some((l) => /^\s*!memory\//.test(l));
    if (shared === share) return "present";

    const next = lines.map((l) =>
      CLAIM_PATTERN.test(l) ? (share ? l.replace(/^(\s*)#\s*/, "$1") : l.replace(/^(\s*)/, "$1# ")) : l,
    );
    writeFileSync(path, next.join("\n"), "utf8");
    return "updated";
  } catch {
    return "failed";
  }
}

/**
 * A `.lethe/` rule left behind in the repository root by an older version.
 *
 * Harmless -- the nested file overrides it -- but it is the kind of stale line
 * that gets read as authoritative months later, so it is worth pointing at.
 */
export function staleRootIgnore(root: string): string[] {
  try {
    return readFileSync(join(root, ".gitignore"), "utf8")
      .split("\n")
      .filter((l) => /^\s*#?\s*\.lethe\//.test(l) && l.trim() !== "");
  } catch {
    return [];
  }
}

// ------------------------------------------------------------ introspection
// `lethe doctor` has to answer "why is my memory not where I thought", and the
// answers are no longer in the config file: they are the derived paths and what
// git does with them.

/**
 * Config files still carrying the removed `scope` setting.
 *
 * Nothing reads it, so a file that sets it is a file whose author believes
 * something untrue about where their memory goes. Silence there would be the
 * same failure the setting itself used to cause, so doctor names them.
 */
export function staleConfig(cwd = process.cwd()): string[] {
  const root = findProjectRoot(cwd);
  const paths = [globalConfigPath(), ...(root ? [join(root, ".lethe", "config.json")] : [])];
  return paths.filter((path) => {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      return !!raw && typeof raw === "object" && "scope" in raw;
    } catch {
      return false;
    }
  });
}

/**
 * What git actually does with the claims in this repository.
 *
 * The .gitignore line records what was intended; this reports what happened,
 * and they still come apart. The common case: sharing gets turned on and nobody
 * ever runs `git add`, so the claims are neither ignored nor committed. lethe's
 * own repo sat the other way round for weeks -- nine claims that looked shared
 * and were committed nowhere. So doctor asks git rather than trusting the file
 * lethe wrote itself.
 */
export type Sharing = "shared" | "ignored" | "untracked" | "empty" | "unknown";

export function claimSharing(root: string): { state: Sharing; files: number; tracked: number } {
  const dir = join(root, ".lethe", "memory");
  let files = 0;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).length;
  } catch {
    return { state: "empty", files: 0, tracked: 0 };
  }
  if (files === 0) return { state: "empty", files, tracked: 0 };

  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null; // non-zero exit is an answer for check-ignore, not an error
    }
  };

  const listed = git(["ls-files", "--", ".lethe/memory"]);
  if (listed === null) return { state: "unknown", files, tracked: 0 };
  const tracked = listed.split("\n").filter((l) => l.trim().endsWith(".md")).length;

  if (tracked > 0) return { state: "shared", files, tracked };
  if (git(["check-ignore", "-q", ".lethe/memory"]) !== null) return { state: "ignored", files, tracked };
  return { state: "untracked", files, tracked };
}
