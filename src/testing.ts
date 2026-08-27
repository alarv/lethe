/**
 * Test scaffolding.
 *
 * Every test must run against a throwaway store. Running against the real one
 * destroyed live memories twice, which is why this exists rather than each test
 * rolling its own mkdtemp and getting it subtly wrong.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";

export async function withStore(
  fn: (store: Store, home: string, workspace: string) => void | Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "lethe-test-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "lethe-test-ws-"));
  // Store keys memory to the nearest .git, so the workspace has to look like a
  // repository or every test would share the cwd's project key -- and leak into
  // each other.
  mkdirSync(join(workspace, ".git"), { recursive: true });
  writeFileSync(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");

  const previous = process.env.LETHE_HOME;
  process.env.LETHE_HOME = home;
  try {
    await fn(new Store(workspace), home, workspace);
  } finally {
    if (previous === undefined) delete process.env.LETHE_HOME;
    else process.env.LETHE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}
