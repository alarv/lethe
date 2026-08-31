#!/usr/bin/env node
/**
 * Retrieval evaluation.
 *
 * docs/evals.md states the claim this project stands on: an agent with compacted
 * memory should reach a correct result in fewer turns and fewer tokens than one
 * with raw session logs. Measuring that end to end needs agent runs. This
 * measures the layer underneath it, which is load-bearing -- if retrieval over
 * distilled claims does not beat retrieval over the episodes they came from,
 * nothing downstream can.
 *
 *   node --experimental-strip-types evals/run.ts
 *   node --experimental-strip-types evals/run.ts --store <dir>   # a real store
 *
 * The comparison that matters is `compact` against `raw`. Beating `cold` proves
 * nothing: every agent already has no memory.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const root = join(here, "..");

interface Task {
  id: string;
  scenario: string;
  difficulty: "easy" | "hard";
  category: string;
  query: string;
}

type Condition = "cold" | "raw" | "compact" | "all";

/** Which retrieval mechanism is under test. Both are reported: an improvement
 *  that cannot be attributed to one change is not a measurement. */
type Mechanism = "naive" | "fts5";

interface Result {
  condition: Condition;
  mechanism: Mechanism;
  hit1: number;
  hit3: number;
  hit5: number;
  mrr: number;
  /** Characters of context consumed before the answer appears. */
  costToAnswer: number;
  /** Total size of the searchable store. */
  indexChars: number;
  n: number;
}

const K = 5;

function loadTasks(): Task[] {
  return readFileSync(join(root, "evals/tasks.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Task);
}

/**
 * Build a store from the fixtures, keeping only what a condition should see.
 * Episodes and claims are written to the same store so the retrieval code under
 * test is exactly the one that ships.
 *
 * The workspace is a throwaway directory rather than this repository. Running
 * against the repo let claims escape the sandbox into .lethe/memory,
 * where they persisted across conditions and across runs.
 */
async function buildStore(condition: Condition, home: string, workspace: string) {
  const { Store } = await import(join(root, "dist/store.js"));
  process.env.LETHE_HOME = home;
  const store = new Store(workspace);

  if (condition === "cold") return store;

  const fixtures = JSON.parse(readFileSync(join(root, "evals/fixtures.json"), "utf8")) as {
    scenarios: {
      name: string;
      episodes: { title: string; body: string; files: string[] }[];
      claim: { title: string; body: string; files: string[] };
    }[];
  };

  for (const s of fixtures.scenarios) {
    if (condition === "raw" || condition === "all") {
      for (const e of s.episodes) {
        store.create({ kind: "episode", title: e.title, body: e.body, files: e.files, tags: [s.name] });
      }
    }
    if (condition === "compact" || condition === "all") {
      store.create({
        kind: "claim",
        title: s.claim.title,
        body: s.claim.body,
        files: s.claim.files,
        tags: [s.name],
      });
    }
  }
  return store;
}

async function run(condition: Condition, tasks: Task[], mechanism: Mechanism): Promise<Result> {
  const home = mkdtempSync(join(tmpdir(), "lethe-eval-"));
  const workspace = mkdtempSync(join(tmpdir(), "lethe-ws-"));
  mkdirSync(join(workspace, ".git"), { recursive: true });
  writeFileSync(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
  try {
    const store = await buildStore(condition, home, workspace);
    let hit1 = 0, hit3 = 0, hit5 = 0, mrr = 0, cost = 0, answered = 0;
    const indexChars = store.all().reduce(
      (n: number, m: { title: string; body: string }) => n + m.title.length + m.body.length, 0);

    for (const task of tasks) {
      const hits = mechanism === "fts5"
        ? store.search(task.query, K)
        : store.searchNaive(task.query, K);
      // Correct means "surfaced something from the right scenario". Scoring by
      // memory id would be unfair across conditions: the right answer is an
      // episode under raw and a claim under compact.
      const ranks = hits.map((m: { tags: string[] }) => m.tags.includes(task.scenario));
      const first = ranks.indexOf(true);

      if (first === 0) hit1 += 1;
      if (first >= 0 && first < 3) hit3 += 1;
      if (first >= 0) hit5 += 1;
      if (first >= 0) mrr += 1 / (first + 1);

      // Context spent getting to the answer, not context returned. Charging for
      // the full top-k penalises claims for having fuller bodies, when the point
      // of a claim is that you need fewer of them and can stop sooner.
      if (first >= 0) {
        cost += hits.slice(0, first + 1).reduce(
          (n: number, m: { title: string; body: string }) => n + m.title.length + m.body.length, 0);
        answered += 1;
      }
    }

    const n = tasks.length;
    return {
      condition,
      mechanism,
      hit1: hit1 / n, hit3: hit3 / n, hit5: hit5 / n, mrr: mrr / n,
      costToAnswer: answered ? cost / answered : 0,
      indexChars,
      n,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * Conditions run one at a time. They share process.env.LETHE_HOME, so running
 * them concurrently let them collide in a single store -- which showed up as
 * every condition scoring identically, including the one with no memories.
 */
async function runAll(
  conditions: Condition[],
  tasks: Task[],
  mechanism: Mechanism,
): Promise<Result[]> {
  const out: Result[] = [];
  for (const c of conditions) out.push(await run(c, tasks, mechanism));
  return out;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`.padStart(4);
}

function table(results: Result[], title: string): void {
  console.log(`\n${title}`);
  console.log("  condition   hit@1  hit@3  hit@5    MRR   cost-to-answer   index");
  console.log("  ──────────────────────────────────────────────────────────────────");
  for (const r of results) {
    console.log(
      `  ${r.condition.padEnd(9)}  ${pct(r.hit1)}   ${pct(r.hit3)}   ${pct(r.hit5)}  ` +
        `${r.mrr.toFixed(2)}   ${String(Math.round(r.costToAnswer)).padStart(12)}   ` +
        `${String(r.indexChars).padStart(5)}`,
    );
  }
}

function verdict(overall: Result[], mechanism: Mechanism): void {
  const raw = overall.find((r) => r.condition === "raw")!;
  const compact = overall.find((r) => r.condition === "compact")!;
  console.log(`\nverdict — ${mechanism}`);
  const delta = compact.mrr - raw.mrr;
  const cheaper = raw.costToAnswer - compact.costToAnswer;
  console.log(
    `  MRR   ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} for compact ` +
      `(${raw.mrr.toFixed(2)} raw -> ${compact.mrr.toFixed(2)} compact)`,
  );
  console.log(
    `  cost  ${cheaper >= 0 ? "-" : "+"}${Math.abs(Math.round(cheaper))} chars to reach the answer`,
  );
  const shrink = 1 - compact.indexChars / raw.indexChars;
  console.log(`  index ${(shrink * 100).toFixed(0)}% smaller (${raw.indexChars} -> ${compact.indexChars} chars)`);
  if (delta < 0 && cheaper <= 0) {
    console.log("\n  Compaction loses on both axes. That is the thesis failing, not a tuning problem.");
  } else if (delta < 0) {
    console.log("\n  Compaction retrieves worse but costs less. Whether that trade is worth it is a judgement, not a number.");
  }
}

async function main(): Promise<void> {
  const all = loadTasks();
  const conditions: Condition[] = ["cold", "raw", "compact", "all"];
  const asked = process.argv.find((a) => a.startsWith("--retrieval="))?.split("=")[1] ?? "both";
  const mechanisms: Mechanism[] = asked === "both" ? ["naive", "fts5"] : [asked as Mechanism];

  console.log(`lethe retrieval eval — ${all.length} tasks, top-${K}`);
  console.log("compact vs raw is the comparison that matters; cold is the floor.");

  for (const mechanism of mechanisms) {
    const overall = await runAll(conditions, all, mechanism);
    table(overall, `all tasks — ${mechanism}`);
    for (const d of ["easy", "hard"] as const) {
      const subset = all.filter((t) => t.difficulty === d);
      table(
        await runAll(conditions, subset, mechanism),
        `${d} (${subset.length} tasks) — ${mechanism}` +
          (d === "hard" ? " — queries that share little wording with what was recorded" : ""),
      );
    }
    verdict(overall, mechanism);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
