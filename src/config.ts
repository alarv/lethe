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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
 */
export function ignoreInGit(root: string): "added" | "present" | "failed" {
  const path = join(root, ".gitignore");
  const entry = ".lethe/";
  try {
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current.split("\n").some((l) => l.trim() === entry || l.trim() === ".lethe")) {
      return "present";
    }
    const prefix = current && !current.endsWith("\n") ? "\n" : "";
    writeFileSync(path, `${current}${prefix}\n# lethe memory (local only)\n${entry}\n`, "utf8");
    return "added";
  } catch {
    return "failed";
  }
}
