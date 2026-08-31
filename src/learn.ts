/**
 * Seeding memory from the repository itself, so lethe is useful on day one.
 *
 * The cold-start problem is not cosmetic. An empty store does not merely fail to
 * help -- it teaches the agent that `recall` does not pay. First session it
 * returns nothing, second session nothing, and by the third the model has
 * learned to stop asking. Adoption measured in lethe's own store is consistent
 * with exactly that: 12% of sessions called `recall`, 18% called `note`.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: walk `src/` and write claims describing
 * the architecture. That produces a stale mirror of the code -- confidently
 * wrong after the first refactor, re-derivable by simply reading the file, and
 * actively harmful to retrieval, because `recall` returns eight hits and forty
 * architecture summaries push out the one hard-won gotcha. The rule the whole
 * project runs on is that a memory must not be trivially re-derivable from the
 * code, and a summary of the code is the purest violation of it.
 *
 * So this tier extracts only "how to work here" -- the build, test and check
 * commands, the runtime floor, what CI does before it runs the tests. Those are
 * facts an agent otherwise rediscovers by reading three files, and they are
 * scattered across `package.json`, a lockfile, a workflow and a README
 * paragraph rather than stated anywhere once.
 *
 * Two properties make it safe to seed generously:
 *
 *   1. Every fact must cite a file and be checkable against it. `cited()` is a
 *      mechanical gate, not a prompt instruction -- an extractor that invents a
 *      command is rejected before it reaches the store. This tier uses no model
 *      at all, so it also cannot fail for want of one.
 *
 *   2. Seeded claims enter WEAK. They were not earned by experience, so they
 *      start below a claim distilled from real episodes, and ordinary decay
 *      culls the ones that never get recalled or confirmed. Being wrong is
 *      therefore self-correcting, which is what earns the right to guess.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Memory, Store } from "./store.js";

/**
 * Starting strength for a claim nobody learned.
 *
 * Chosen against the decay constants in compact.ts: from 0.6, with TAU_DAYS 56
 * and a COLD threshold of 0.2, an untouched seed falls cold in roughly 61 days
 * (`ln(0.6/0.2) * 56`). From the usual 1.0 it would take about 90. So a seeded
 * claim that never proves useful has about two months to do so and is then
 * purged, while one that gets recalled is reinforced past the point of caring.
 */
export const SEED_STRENGTH = 0.6;

/** Marks a claim as seeded rather than earned, and carries its stable key. */
export const SEED_TAG = "seed";

export interface Fact {
  /**
   * Stable across runs, so re-seeding revises the existing claim instead of
   * writing a second one beside it. This matters more than the watermark does:
   * a teammate cloning a repo with committed claims has no watermark of their
   * own, and without a key their first `lethe init` would duplicate the lot.
   */
  key: string;
  title: string;
  body: string;
  /** Repo-relative paths this was read out of. */
  files: string[];
  /** Strings claimed to have come verbatim from `files`; checked by `cited()`. */
  quoted: string[];
  salience: number;
}

// ------------------------------------------------------------------ reading

/** Reads a repo-relative file, or null. Missing files are the common case. */
function text(root: string, rel: string): string | null {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return null;
  }
}

function json(root: string, rel: string): Record<string, unknown> | null {
  const raw = text(root, rel);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Does this fact hold up against the files it cites?
 *
 * Two conditions, and the split matters. Every quoted string must appear in a
 * cited file -- that is what stops an extractor inventing a command. But some
 * facts are cited by a file's *existence* rather than its contents (a lockfile
 * says which package manager to use without containing the install command), so
 * an empty `quoted` is permitted as long as a cited file is really there.
 * Requiring a quote unconditionally silently dropped every lockfile-only repo.
 *
 * The de-escaped haystack is not belt-and-braces either. A value parsed out of
 * JSON has had its escapes resolved, so the test script
 * `LETHE_HOME="${TMPDIR:-/tmp}/..."` does not appear byte-for-byte in
 * package.json, where it is written `LETHE_HOME=\"${TMPDIR:-/tmp}/...\"`. Testing
 * the raw bytes alone would reject every correct fact drawn from JSON.
 */
export function cited(fact: Fact, root: string): boolean {
  const present = fact.files.filter((f) => existsSync(join(root, f)));
  if (!present.length) return false;

  const hay = present
    .map((f) => text(root, f))
    .filter((t): t is string => t !== null)
    .flatMap((t) => [t, t.replace(/\\"/g, '"').replace(/\\\\/g, "\\")])
    .join("\n");
  return fact.quoted.every((q) => q.trim().length > 0 && hay.includes(q));
}

// --------------------------------------------------------------- extractors

/**
 * The scripts worth knowing, in the order someone needs them.
 *
 * Named explicitly rather than "every script", because a package.json holds
 * release plumbing and one-off helpers that are noise to an agent. The point is
 * to answer "how do I check my change here", not to inventory the file.
 */
const SCRIPTS = ["build", "test", "typecheck", "lint", "check", "format", "dev", "start"];

/**
 * One claim for all the commands, not one per command.
 *
 * Five separate claims would each be individually true and collectively a
 * retrieval problem -- they would fill the eight-hit budget by themselves. A
 * single dense claim is what an agent actually wants to read.
 */
function nodeCommands(root: string): Fact | null {
  const pkg = json(root, "package.json");
  const scripts = pkg?.scripts as Record<string, string> | undefined;
  if (!scripts) return null;

  const found = SCRIPTS.filter((s) => typeof scripts[s] === "string" && scripts[s]!.trim());
  if (!found.length) return null;

  const width = Math.max(...found.map((s) => s.length));
  const lines = found.map((s) => `  npm run ${s.padEnd(width)}  -> ${scripts[s]}`);
  // `npm test` is idiomatic and the only one of these with a bare alias.
  const runner = found.includes("test") ? "npm test runs the suite. " : "";

  /**
   * The title names the scripts it actually found, rather than saying "check".
   *
   * Not cosmetic -- retrieval is keyword-based, and titles carry weight. The
   * first version was titled "Build and check this repo with the npm scripts",
   * which contains no form of the word "test", so "how do I run the tests here"
   * did not retrieve it on lethe's own store while a direct query for "npm
   * scripts" ranked it first. Naming the scripts is both more findable and more
   * specific.
   */
  const named = found.filter((s) => s !== "dev" && s !== "start");
  const verbs = (named.length ? named : found).slice(0, 4);
  const phrase = verbs.length > 1
    ? `${verbs.slice(0, -1).join(", ")} and ${verbs[verbs.length - 1]}`
    : verbs[0]!;

  return {
    key: "commands",
    title: `How to ${phrase} this repo -- the npm scripts in package.json`,
    body: [
      `${runner}The scripts, verbatim:`,
      "",
      ...lines,
      "",
      "Read out of package.json when memory was seeded, so a script that has since",
      "been renamed makes this a stale claim -- correct it rather than working",
      "around it.",
    ].join("\n"),
    files: ["package.json"],
    quoted: found.map((s) => scripts[s]!),
    salience: 0.6,
  };
}

/** Make targets, for repos where the Makefile is the real entry point. */
function makeCommands(root: string): Fact | null {
  const raw = text(root, "Makefile");
  if (!raw) return null;
  // Real targets only: no pattern rules, no variable assignments, no .PHONY.
  const targets = [...raw.matchAll(/^([a-zA-Z][\w-]*):(?!=)/gm)]
    .map((m) => m[1]!)
    .filter((t) => t !== "PHONY");
  const unique = [...new Set(targets)].slice(0, 12);
  if (!unique.length) return null;

  return {
    key: "make",
    title: "This repo is driven by a Makefile; `make <target>` is the entry point",
    body: [
      `Targets defined in the Makefile: ${unique.join(", ")}.`,
      "",
      "Prefer these over reconstructing the underlying command -- they exist",
      "because the underlying command has flags that are easy to get wrong.",
    ].join("\n"),
    files: ["Makefile"],
    quoted: unique.map((t) => `${t}:`),
    salience: 0.6,
  };
}

/** Python projects state how their suite runs in a different set of files. */
function pythonCommands(root: string): Fact | null {
  const files = ["pyproject.toml", "tox.ini", "pytest.ini", "setup.cfg"].filter((f) =>
    existsSync(join(root, f)),
  );
  if (!files.length) return null;

  const quoted: string[] = [];
  const notes: string[] = [];
  const cite: string[] = [];
  for (const f of files) {
    const raw = text(root, f) ?? "";
    // The strings worth keeping are the ones that change how tests are invoked.
    for (const key of ["addopts", "testpaths", "requires-python", "python_requires"]) {
      const m = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.+)$`, "m").exec(raw);
      if (!m) continue;
      quoted.push(m[0]!.trim());
      notes.push(`  ${f}: ${m[0]!.trim()}`);
      if (!cite.includes(f)) cite.push(f);
    }
  }
  if (!notes.length) return null;

  return {
    key: "python",
    title: "Python test configuration lives outside the test files",
    body: [
      "Options that change how the suite runs, verbatim from config:",
      "",
      ...notes,
      "",
      "pytest picks these up implicitly, so a run that behaves differently from",
      "the plain command line is usually one of these, not the test.",
    ].join("\n"),
    files: cite,
    quoted,
    salience: 0.6,
  };
}

/**
 * The runtime floor, and how dependencies are meant to be installed.
 *
 * Worth its own claim because getting either wrong is slow and confusing rather
 * than loud: the wrong package manager produces a second lockfile that only a
 * reviewer notices, and a runtime below the floor fails in whatever module
 * happens to touch a missing built-in first.
 */
function runtime(root: string): Fact | null {
  const pkg = json(root, "package.json");
  const node = (pkg?.engines as Record<string, string> | undefined)?.node;

  const LOCKS: [string, string][] = [
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["yarn.lock", "yarn install --immutable"],
    ["bun.lockb", "bun install --frozen-lockfile"],
    ["package-lock.json", "npm ci"],
  ];
  const lock = LOCKS.find(([f]) => existsSync(join(root, f)));
  if (!node && !lock) return null;

  const quoted: string[] = [];
  const files: string[] = [];
  const lines: string[] = [];

  if (node) {
    quoted.push(node);
    files.push("package.json");
    lines.push(
      `Node ${node}, from package.json engines.node. Below the floor the failure`,
      "surfaces in whatever module touches a missing built-in first, not as a",
      "clear version error.",
    );
  }
  if (lock) {
    if (node) lines.push("");
    files.push(lock[0]);
    lines.push(
      `Install with \`${lock[1]}\` -- ${lock[0]} is the lockfile here.`,
      "A different package manager writes a second lockfile, which is a review",
      "comment rather than an error, so nothing stops you.",
    );
  }

  return {
    key: "runtime",
    title: node
      ? `This repo needs Node ${node}${lock ? `, installed with ${lock[1].split(" ")[0]}` : ""}`
      : `Install dependencies with \`${lock![1]}\``,
    body: lines.join("\n"),
    files,
    quoted,
    salience: 0.55,
  };
}

/**
 * Workflows that do not answer "how do I check my change here".
 *
 * A release workflow's steps are real and verbatim and completely wrong to
 * repeat locally. Caught for real on lethe's own repo: the first version of this
 * extractor lifted `npm publish --provenance --access public` out of publish.yml
 * and filed it under "running these locally is the cheapest way to not fail
 * review". A seeded memory that hands an agent a publish command is worse than
 * no seeded memory.
 */
const NOT_A_CHECK = /publish|release|deploy|^cd[-.]/i;

/**
 * Commands that act on the outside world, wherever they appear.
 *
 * The filename filter above is not enough on its own: plenty of repos put a
 * deploy job in ci.yml. This is the backstop, and it is deliberately about the
 * effect rather than the tool -- anything that pushes, publishes or applies is
 * not a local check no matter which workflow it lives in.
 */
const OUTWARD = /\b(?:(?:npm|yarn|pnpm|bun)\s+publish|gh\s+release|docker\s+push|terraform\s+apply|kubectl\s+apply|helm\s+(?:upgrade|install)|(?:aws|gcloud|az)\s+.*\bdeploy|serverless\s+deploy|git\s+push)\b/i;

/**
 * What CI actually runs, which is the closest thing a repo has to a contract.
 *
 * Deliberately line-based rather than a YAML parse: adding a dependency to a
 * zero-dependency package in order to read four `run:` lines is a bad trade, and
 * the failure mode of the heuristic is a missing fact rather than a wrong one --
 * anything it does report is quoted and gated by `cited()`.
 *
 * Only single-line `run:` values are taken. A block scalar (`run: |`) in a real
 * workflow is a shell program, sometimes fifty lines of it, and none of that
 * belongs in a memory.
 */
function ci(root: string): Fact | null {
  const dir = join(root, ".github", "workflows");
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .filter((f) => !NOT_A_CHECK.test(basename(f, f.endsWith(".yaml") ? ".yaml" : ".yml")));
  } catch {
    return null;
  }
  if (!names.length) return null;

  const commands: string[] = [];
  const services: string[] = [];
  const files: string[] = [];

  for (const name of names.sort()) {
    const rel = join(".github", "workflows", name);
    const raw = text(root, rel);
    if (!raw) continue;
    let used = false;

    for (const line of raw.split("\n")) {
      const m = /^[ \t]*-?[ \t]*run:[ \t]*(?!\|)(\S.*)$/.exec(line);
      if (!m) continue;
      const cmd = m[1]!.trim();
      // Nothing templated: a half-expanded ${{ }} is worse than no memory.
      if (cmd.includes("${{") || cmd.length > 80) continue;
      // Nothing that acts on the outside world; see OUTWARD.
      if (OUTWARD.test(cmd)) continue;
      if (!commands.includes(cmd)) {
        commands.push(cmd);
        used = true;
      }
    }

    // A `services:` block means the suite needs something running. That is the
    // single most valuable thing in a workflow file -- it is the "tests need
    // docker compose up first" lesson, stated by the repo rather than learned
    // the hard way at 14:31 on a Tuesday.
    const block = /^([ \t]*)services:[ \t]*$/m.exec(raw);
    if (block) {
      const indent = block[1]!.length;
      for (const line of raw.slice(block.index + block[0].length).split("\n")) {
        if (!line.trim()) continue;
        if (line.length - line.trimStart().length <= indent) break;
        const named = /^[ \t]*([\w-]+):[ \t]*$/.exec(line);
        if (named && !services.includes(named[1]!)) {
          services.push(named[1]!);
          used = true;
        }
      }
    }

    if (used) files.push(rel);
  }

  if (!commands.length && !services.length) return null;

  const kept = commands.slice(0, 8);
  const lines: string[] = [];
  if (services.length) {
    lines.push(
      `CI starts ${services.join(", ")} before the tests run, so the suite expects`,
      "them to be up. A local run that cannot connect is far more often a missing",
      "service than a broken test.",
      "",
    );
  }
  if (kept.length) {
    lines.push("What CI runs, verbatim:", "");
    for (const c of kept) lines.push(`  ${c}`);
    lines.push("", "Running these locally is the cheapest way to not fail review.");
  }

  return {
    key: "ci",
    title: services.length
      ? `CI runs ${services.join(", ")} as services; the tests expect them running`
      : "What CI runs on every change",
    body: lines.join("\n").trim(),
    files,
    quoted: [...kept, ...services.map((s) => `${s}:`)],
    // Higher than the rest: this is the one that saves a confusing local failure.
    salience: services.length ? 0.7 : 0.6,
  };
}

const EXTRACTORS = [nodeCommands, makeCommands, pythonCommands, runtime, ci];

/**
 * Everything this tier can learn about a repo, gated.
 *
 * The gate runs here rather than in `seed()` so a caller inspecting the facts
 * sees exactly the set that would be written -- a dry run that disagrees with
 * the real one is worse than no dry run at all.
 */
export function facts(root: string): Fact[] {
  const out: Fact[] = [];
  for (const extract of EXTRACTORS) {
    let fact: Fact | null = null;
    try {
      fact = extract(root);
    } catch {
      // An unreadable or malformed file is a missing fact, never a failed setup.
      fact = null;
    }
    if (fact && cited(fact, root)) out.push(fact);
  }
  return out;
}

// ------------------------------------------------------------------ writing

export interface SeedReport {
  /** Facts the extractors produced and the gate accepted. */
  considered: number;
  written: number;
  revised: number;
  unchanged: number;
  /** Files the accepted facts were read out of, deduplicated. */
  sources: string[];
}

function keyOf(m: Memory): string | null {
  const tag = m.tags.find((t) => t.startsWith(`${SEED_TAG}:`));
  return tag ? tag.slice(SEED_TAG.length + 1) : null;
}

/**
 * Write the facts as weak claims, revising rather than duplicating.
 *
 * Idempotency comes from the seed key in `tags`, not from the watermark file.
 * The watermark records what has been read for the benefit of later tiers; it
 * cannot be what prevents duplicates, because it lives outside git while the
 * claims themselves may be committed -- so a teammate's clone has the claims and
 * no watermark, and would otherwise seed a second copy of every one.
 *
 * A revision keeps the original id, strength and confirmations. Someone who
 * confirmed "build and check this repo with the npm scripts" should not lose
 * that because a sibling script was added to the same claim.
 */
export function seed(
  store: Store,
  root: string,
  opts: { dryRun?: boolean; onFact?: (f: Fact) => void } = {},
): SeedReport {
  const found = facts(root);
  const report: SeedReport = {
    considered: found.length,
    written: 0,
    revised: 0,
    unchanged: 0,
    sources: [...new Set(found.flatMap((f) => f.files))].sort(),
  };

  const existing = new Map<string, Memory>();
  for (const m of store.all()) {
    const k = keyOf(m);
    if (k) existing.set(k, m);
  }

  for (const fact of found) {
    opts.onFact?.(fact);
    const prior = existing.get(fact.key);

    if (prior && prior.title === fact.title && prior.body === fact.body) {
      report.unchanged += 1;
      continue;
    }

    if (opts.dryRun) {
      if (prior) report.revised += 1;
      else report.written += 1;
      continue;
    }

    if (prior) {
      prior.title = fact.title;
      prior.body = fact.body;
      prior.files = fact.files;
      prior.updated = new Date().toISOString();
      store.write(prior);
      report.revised += 1;
      continue;
    }

    store.create({
      kind: "claim",
      title: fact.title,
      body: fact.body,
      files: fact.files,
      tags: [SEED_TAG, `${SEED_TAG}:${fact.key}`],
      salience: fact.salience,
      strength: SEED_STRENGTH,
    });
    report.written += 1;
  }

  return report;
}

// ---------------------------------------------------------------- watermark

/**
 * What has been read out of this repo, for the tiers that are not built yet.
 *
 * Lands in `.lethe/`, which the managed .gitignore ignores wholesale, so this is
 * per-checkout by construction -- which is right, since it records what *this*
 * machine has read. It is informational only: nothing depends on it for
 * correctness, and deleting it costs one redundant re-seed.
 */
export interface Watermark {
  at: string;
  seeded: number;
  /** Last commit whose history has been distilled. Null until that tier exists. */
  historyThrough: string | null;
}

export function watermarkPath(root: string): string {
  return join(root, ".lethe", "learned.json");
}

export function readWatermark(root: string): Watermark | null {
  try {
    return JSON.parse(readFileSync(watermarkPath(root), "utf8")) as Watermark;
  } catch {
    return null;
  }
}

export function writeWatermark(root: string, next: Watermark): void {
  const path = watermarkPath(root);
  try {
    mkdirSync(join(root, ".lethe"), { recursive: true });
    // Temp + rename, like every other write in the project: a half-written
    // watermark would read as a corrupt one on the next run.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch {
    // A watermark that could not be written costs a redundant re-read later,
    // which is cheap and idempotent. Never worth failing setup over.
  }
}

/** For the CLI: the files a seed would actually read, by basename. */
export function describeSources(root: string): string {
  const names = [...new Set(facts(root).flatMap((f) => f.files))].map((f) => basename(f));
  return names.length ? names.join(", ") : "nothing recognisable";
}
