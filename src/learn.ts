/**
 * Seeding memory from the repository, so lethe is useful on day one.
 *
 * The cold-start problem is not cosmetic. An empty store does not merely fail to
 * help -- it teaches the agent that `recall` does not pay. First session it
 * returns nothing, second session nothing, and by the third the model has
 * learned to stop asking. Adoption measured in lethe's own store is consistent
 * with exactly that: 12% of sessions called `recall`, 18% called `note`.
 *
 * THE AGENT IN THE SESSION DOES THE READING. `learn` is an MCP tool, and that is
 * the whole design. The host already has a capable model with the repository
 * open and file tools in its hands; it costs nothing extra, it needs no key, and
 * it knows every ecosystem lethe would otherwise have to learn about. lethe does
 * not need a model. It needs a client, and it already has one.
 *
 * Two rejected designs, both of which shipped briefly and were wrong:
 *
 *   1. HAND-WRITTEN EXTRACTORS. npm scripts, then a Makefile, then pyproject and
 *      pytest keys, then uv and poetry and requirements, then Taskfile, then
 *      workflow services -- with R, Go and Java queued behind them. A language
 *      matrix maintained inside a memory tool forever, reimplementing what the
 *      model already knows.
 *
 *   2. HIRING A MODEL. Resolving a distiller and pasting a selection of files
 *      into a prompt. That needed a second, blinder heuristic to choose which
 *      files to paste, sent repository contents somewhere they did not need to
 *      go, and used a weaker model than the one already running in the session.
 *
 * So this module holds no ecosystem knowledge and no file-selection rule. What
 * it does hold is the three things that stay lethe's job:
 *
 *   - A MECHANICAL GATE. `gate()` requires every value the agent declares as
 *     quoted to appear verbatim in a file it cited, refuses facts citing files
 *     that do not exist, and refuses outward-facing commands. A nondeterministic
 *     producer needs a deterministic check -- the same posture as the evidence
 *     gate on consolidation, and for the same reason: an instruction is a
 *     request, this is a check.
 *
 *   - WEAK SEEDING. Seeded claims were not earned by experience, so they enter
 *     below a claim distilled from real episodes and ordinary decay culls the
 *     ones never recalled or confirmed. Being wrong is self-correcting, which is
 *     what earns the right to seed a guess at all.
 *
 *   - IDEMPOTENCY. A stable key per fact, so re-running revises rather than
 *     duplicating.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
   * own, and without a key their first run would duplicate the lot.
   */
  key: string;
  title: string;
  body: string;
  /** Repo-relative paths this was read out of. */
  files: string[];
  /** Strings the agent claims came verbatim from `files`; checked by `gate()`. */
  quoted: string[];
  salience: number;
}

// -------------------------------------------------------------- instructions

/**
 * What the tool says when asked to learn with nothing to write yet.
 *
 * Returned to the agent rather than sent to a model: it is a brief for work the
 * caller is about to do with its own file tools, which is why it can say "read
 * it yourself" at all.
 */
export const LEARN_INSTRUCTIONS = `Seed this project's memory from what the repository already says about itself.
Nothing has been read for you -- read it yourself, with your own tools, then call
\`learn\` again with a \`facts\` array.

WHAT TO LOOK AT: the manifest and lockfile, the task runner or scripts, CI
config, and any CONTRIBUTING or AGENTS file. Work out the language and tooling
from what you find; no assumption has been made about any of it.

WHAT IS WORTH RECORDING -- how to work here, not what the code is:
- How to install dependencies, and which file is authoritative when several
  disagree (a lockfile beats a requirements list; say so if both exist).
- How to build, test, lint and typecheck. The real command, not an approximation.
- The runtime or language version the repo requires.
- Services the tests expect to be running, and what the failure looks like when
  they are not.
- Anything CI does that a local run does not, since CI is the actual contract.
- A convention stated in CONTRIBUTING or AGENTS that the code would not reveal.

WHAT WILL BE REJECTED:
- Any description of what the source code does or how it is structured. That is a
  stale mirror of the code -- wrong after the first refactor, re-derivable by
  reading the file, and it crowds retrieval out of the hard-won lessons. recall
  returns eight hits; do not spend them on a tour of the codebase.
- Anything that publishes, deploys, pushes or releases. Those steps are real and
  completely wrong to run locally.
- What the project is for. A future agent can read the README.
- A guess. If the repo does not say it, leave it out.

EACH FACT:
  key      short stable slug for the SUBJECT -- "install", "test", "runtime",
           "services", "ci", "conventions". Re-running must produce the same key
           for the same subject: that is what revises a claim instead of writing
           a second one next to it. One fact per key.
  title    one line, the rule itself. "Install with \`uv sync\`; uv.lock is
           authoritative" beats "this project uses Python".
  body     one to four lines. Commands, paths and versions EXACTLY as written.
  files    repo-relative paths the fact came from.
  quoted   one or more strings you COPIED VERBATIM from those files. Each is
           checked against the file and the fact is discarded if it is not found,
           so quote something really there -- a version constraint, a script
           body, a CI step -- rather than a command you inferred. The inferred
           command belongs in the body.

Prefer few dense facts over many thin ones. Six is plenty; two good ones beat six
padded. Seeded claims start weak and decay in about two months unless something
confirms them, so a wrong guess expires -- but a thin one still occupies a
retrieval slot until it does.`;

// ---------------------------------------------------------------------- gate

/** Reads a repo-relative file, or null. */
function text(root: string, rel: string): string | null {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return null;
  }
}

/**
 * Commands that act on the outside world.
 *
 * A release pipeline's steps are real, verbatim, and completely wrong to repeat
 * locally. Caught for real: an earlier version lifted `npm publish --provenance
 * --access public` out of publish.yml and filed it under "running these locally
 * is the cheapest way to not fail review". A seeded memory that hands an agent a
 * publish or deploy command is worse than no seeded memory, so this is checked
 * in code and not left to the instructions.
 */
const OUTWARD = /\b(?:(?:npm|yarn|pnpm|bun)\s+publish|gh\s+release|docker\s+push|terraform\s+(?:apply|destroy)|kubectl\s+(?:apply|delete)|helm\s+(?:upgrade|install)|(?:aws|gcloud|az)\s+.*\bdeploy|serverless\s+deploy|git\s+push|cargo\s+publish|mvn\s+deploy|twine\s+upload|gradle\s+publish)\b/i;

/**
 * Files a claim must never be built out of.
 *
 * This is not about reading them, it is about what gets written. A claim body is
 * stored in `.lethe/memory/`, which may be committed, so a fact quoting a line of
 * `.env` would copy a credential out of an ignored file into a tracked one. That
 * is the one direction that must never happen.
 */
const SECRETS = /(?:^|\/)(?:\.env|\.npmrc|\.netrc|\.pypirc|\.git-credentials|credentials|secrets?)\b|\.(?:pem|key|p12|pfx|keystore|jks)$|(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/i;

/**
 * Does every quoted value really appear in a file the fact cites?
 *
 * An empty `quoted` is permitted when a cited file exists, because a fact may
 * legitimately rest on a file's existence rather than its contents -- a lockfile
 * says which installer is authoritative without containing the install command.
 *
 * The de-escaped haystack is not belt-and-braces. A value read out of JSON has
 * had its escapes resolved, so a script written `LETHE_HOME=\"...\"` in the file
 * does not appear byte-for-byte once quoted back. Testing the raw bytes alone
 * would reject correct facts drawn from any JSON manifest.
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

export interface Rejection {
  fact: Fact;
  reason: string;
}

/**
 * Everything a fact must satisfy before it is allowed to become a memory.
 *
 * In code rather than in the instructions, because the producer is a model and
 * this writes to a store other people read. An instruction is a request.
 */
export function gate(facts: Fact[], root: string): { kept: Fact[]; rejected: Rejection[] } {
  const kept: Fact[] = [];
  const rejected: Rejection[] = [];

  for (const fact of facts) {
    if (!fact.key.trim() || !fact.title.trim() || !fact.body.trim()) {
      rejected.push({ fact, reason: "missing a key, title or body" });
      continue;
    }
    if (!fact.files.length) {
      rejected.push({ fact, reason: "cites no file" });
      continue;
    }
    const secret = fact.files.find((f) => SECRETS.test(f));
    if (secret) {
      rejected.push({ fact, reason: `cites a file that may hold credentials: ${secret}` });
      continue;
    }
    const missing = fact.files.filter((f) => !existsSync(join(root, f)));
    if (missing.length === fact.files.length) {
      rejected.push({ fact, reason: `cites files that do not exist: ${missing.join(", ")}` });
      continue;
    }
    if (!cited(fact, root)) {
      rejected.push({ fact, reason: "a quoted value does not appear in the file it cites" });
      continue;
    }
    const outward = OUTWARD.exec(`${fact.title}\n${fact.body}`);
    if (outward) {
      rejected.push({ fact, reason: `names an outward-facing command: ${outward[0]}` });
      continue;
    }
    kept.push(fact);
  }

  return { kept, rejected };
}

// ------------------------------------------------------------------ writing

export interface SeedReport {
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
 * Write facts as weak claims, revising rather than duplicating.
 *
 * Idempotency comes from the seed key in `tags`, not from the watermark file. The
 * watermark is git-ignored while the claims themselves may be committed, so a
 * teammate's clone has the claims and no watermark and would otherwise seed a
 * second copy of every one.
 *
 * A revision keeps the original id, strength and confirmations. Someone who
 * confirmed a claim should not lose that because its wording was refreshed.
 */
export function seed(
  store: Store,
  facts: Fact[],
  opts: { dryRun?: boolean } = {},
): SeedReport {
  const report: SeedReport = {
    considered: facts.length,
    written: 0,
    revised: 0,
    unchanged: 0,
    sources: [...new Set(facts.flatMap((f) => f.files))].sort(),
  };

  const existing = new Map<string, Memory>();
  for (const m of store.all()) {
    const k = keyOf(m);
    if (k) existing.set(k, m);
  }

  for (const fact of facts) {
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

/** Seeded claims already in the store, for reporting what has been learned. */
export function seeded(store: Store): Memory[] {
  return store.all().filter((m) => m.tags.includes(SEED_TAG));
}

// ---------------------------------------------------------------- watermark

/**
 * What has been seeded out of this repo, and when.
 *
 * Lands in `.lethe/`, which the managed .gitignore ignores wholesale, so this is
 * per-checkout by construction -- which is right, since it records what *this*
 * machine has read. Informational only: nothing depends on it for correctness,
 * and deleting it costs one redundant re-seed.
 */
export interface Watermark {
  at: string;
  seeded: number;
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
