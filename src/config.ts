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
 * Keep an in-repo store out of version control.
 *
 * Storing memory in the repo and committing it are separate decisions: the
 * point of `team` scope is usually to keep data out of the home directory, not
 * necessarily to share it.
 *
 * Only claims are ever written into the repository. Episodes live under
 * `~/.lethe/projects/<key>/` no matter what the scope says, and the store
 * relocates any that predate that rule -- so there is nothing episode-shaped
 * here to ignore. An earlier version wrote a `.lethe/episodes/` line, which
 * protected a directory that has never existed while implying to the reader
 * that their raw session notes were sitting in the repo.
 */
export function ignoreInGit(root: string, share: boolean): "added" | "present" | "failed" {
  const path = join(root, ".gitignore");
  const marker = "# lethe";
  try {
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current.includes(marker)) return "present";

    // The line is written either way, commented or not, so the choice is
    // visible and reversible by editing one character rather than by reading
    // the documentation.
    const block = share
      ? [
          "# lethe: consolidated claims are committed, so anyone cloning this repo",
          "# inherits what has been learned. Uncomment to keep them on this machine:",
          "# .lethe/memory/",
        ]
      : [
          "# lethe: consolidated claims stay on this machine. Comment this out to",
          "# share them with the team by committing them to this repository:",
          ".lethe/memory/",
        ];

    const prefix = current && !current.endsWith("\n") ? "\n" : "";
    writeFileSync(path, `${current}${prefix}\n${block.join("\n")}\n`, "utf8");
    return "added";
  } catch {
    return "failed";
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
