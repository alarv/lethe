/**
 * Configuration.
 *
 * Resolution order, most specific first:
 *
 *   LETHE_SCOPE=...              environment, for one-off runs
 *   <repo>/.lethe/config.json    this project
 *   ~/.lethe/config.json         everything
 *   built-in default
 *
 * There is deliberately very little here. Configuration is a cost paid by every
 * reader, so anything that can be inferred should be inferred -- see
 * docs/api-design.md.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot, letheHome, type Scope } from "./store.js";

export interface Config {
  /** Where memories go when a tool does not say. */
  scope?: Scope;
}

const SCOPES = new Set<Scope>(["local", "team", "personal"]);

/** Every valid scope, in the order they are worth explaining. */
export const SCOPE_NAMES: readonly Scope[] = ["local", "team", "personal"];

/**
 * Guard for anything that claims to be a scope.
 *
 * Exported because an unrecognised value used to be accepted in silence:
 * `lethe init --scope=banana` wrote `"banana"` to config.json, said "default
 * scope banana", and then resolved to `local` -- so the setting appeared to
 * take and did not. That is the exact failure the config rows in `lethe doctor`
 * exist to answer, and it was pointing at a file it could not read.
 */
export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && SCOPES.has(value as Scope);
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

export function projectConfigPath(cwd = process.cwd()): string | null {
  const root = findProjectRoot(cwd);
  return root ? join(root, ".lethe", "config.json") : null;
}

export function loadConfig(cwd = process.cwd()): Config {
  const merged: Config = { ...read(globalConfigPath()) };
  const project = projectConfigPath(cwd);
  if (project) Object.assign(merged, read(project));

  const env = process.env.LETHE_SCOPE as Scope | undefined;
  if (env && SCOPES.has(env)) merged.scope = env;
  return merged;
}

/** The scope to use when a caller does not specify one. */
export function defaultScope(cwd = process.cwd()): Scope {
  const s = loadConfig(cwd).scope;
  if (!s || !SCOPES.has(s)) return "local";
  // team scope needs somewhere to put the files.
  if (s === "team" && !findProjectRoot(cwd)) return "local";
  return s;
}

export function writeConfig(path: string, next: Config): void {
  const current = read(path);
  const merged = { ...current, ...next };
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
}

/**
 * Storing memory in the repo and committing it are separate decisions: the
 * point of `team` scope is usually to keep data out of the home directory, not
 * necessarily to share it. This is where that second decision is recorded.
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
 * `~/.lethe/projects/<key>/` no matter what the scope says, and the store
 * relocates any that predate that rule.
 */
export type IgnoreResult = "added" | "updated" | "present" | "foreign" | "failed";

/** The one decision in the file: uncommented, claims are committed. */
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
    "# Episodes are not listed because they are never here -- they live in",
    "# ~/.lethe/projects/<key>/ whatever the scope says.",
    "",
    "*",
    "!.gitignore",
    "!config.json",
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
// `lethe doctor` has to be able to answer "why is my memory not where I said
// it should be", and both answers live outside the config file: which config
// won, and whether git agrees with it.

export interface ConfigSource {
  path: string;
  scope: Scope | undefined;
  exists: boolean;
}

/**
 * Every place a scope could come from, least specific first.
 *
 * The last entry with a scope is the one that wins, which mirrors how
 * loadConfig merges them.
 */
export function configSources(cwd = process.cwd()): ConfigSource[] {
  const paths = [globalConfigPath(), projectConfigPath(cwd)].filter((p): p is string => !!p);
  return paths.map((path) => ({ path, scope: read(path).scope, exists: existsSync(path) }));
}

/**
 * What git actually does with the claims in this repository.
 *
 * `team` scope only decides where the files are written. Whether anyone else
 * ever sees them is a separate question that .gitignore answers, and the two
 * disagreeing silently is the trap this exists to catch: lethe's own repo sat
 * at scope=team with `.lethe/memory/` ignored, so nine claims looked shared
 * and were committed nowhere.
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
