/**
 * Is the running lethe the published one?
 *
 * The install lines use an unpinned `npx @alarv/lethe`, which resolves the
 * latest version on a new server process. That still leaves three ways to run
 * an old one: a global or pinned install, a long-lived harness that keeps the
 * server process it spawned, and an offline npx that fell back to its cache.
 * Nothing told the user, and `doctor` compared only the local build stamp.
 *
 * The registry is asked at most once a day, never on the prompt path, and the
 * answer is cached in the lethe home. A failure is retried hourly rather than
 * daily so an offline laptop does not look permanently up to date.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { version } from "./telemetry.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 4000;

export interface UpdateCheck {
  /** When the registry was last asked, in epoch ms. */
  checkedAt: number;
  /** The published version, or null when the registry could not be reached. */
  latest: string | null;
}

/** Mirrors telemetry.home(); kept here so this module needs no store cycle. */
function home(): string {
  return process.env.LETHE_HOME || join(homedir(), ".lethe");
}

function cachePath(): string {
  return join(home(), "update.json");
}

/** The last answer, without touching the network. */
export function cachedUpdate(): UpdateCheck | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(), "utf8")) as Partial<UpdateCheck>;
    const checkedAt = Number(raw.checkedAt);
    const latest = typeof raw.latest === "string" && /^\d+\.\d+\.\d+/.test(raw.latest) ? raw.latest : null;
    if (!Number.isFinite(checkedAt)) return null;
    return { checkedAt, latest };
  } catch {
    return null;
  }
}

/** Numeric, not lexical: 0.10.0 is newer than 0.9.9. A release beats its own prerelease. */
export function newer(a: string, b: string): boolean {
  const parts = (v: string) => v.split("-")[0]!.split(".").map((n) => Number(n) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const [x, y] = [pa[i] ?? 0, pb[i] ?? 0];
    if (x !== y) return x > y;
  }
  return !a.includes("-") && b.includes("-");
}

function askNpm(): Promise<string | null> {
  return new Promise((resolve) => {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    execFile(
      npm,
      ["view", "@alarv/lethe", "version"],
      { timeout: TIMEOUT_MS, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const out = String(stdout).trim();
        resolve(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(out) ? out : null);
      },
    );
  });
}

/**
 * Refresh the cached answer if it is old enough. Never throws, never blocks a
 * caller that does not await it; CI and `LETHE_NO_UPDATE_CHECK=1` keep it off.
 */
export async function refreshUpdate(force = false): Promise<UpdateCheck | null> {
  if (process.env.LETHE_NO_UPDATE_CHECK === "1" || process.env.CI) return cachedUpdate();
  const cached = cachedUpdate();
  const age = cached ? Date.now() - cached.checkedAt : Infinity;
  if (!force && cached && age < (cached.latest ? DAY_MS : RETRY_MS)) return cached;

  const latest = (await askNpm()) ?? cached?.latest ?? null;
  const next: UpdateCheck = { checkedAt: Date.now(), latest };
  try {
    mkdirSync(home(), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(next) + "\n", "utf8");
  } catch {
    // The cache is an optimization; a read-only home is not an error.
  }
  return next;
}

/**
 * One line for a session, from the cache only. It says there is a newer release
 * and nothing about how to install it: the agent doing the work does not need
 * to be told to run npm, and `doctor` has the command for the person reading.
 */
export function updateNotice(current = version(), check = cachedUpdate()): string | null {
  if (!check?.latest || !newer(check.latest, current)) return null;
  return `A newer lethe is published: ${check.latest} (this session runs ${current}).`;
}

/** What to do about it, for a human at a terminal. */
export const UPDATE_ADVICE =
  "run `lethe restart` if you launch through npx, or `npm i -g @alarv/lethe@latest` for a global install.";
