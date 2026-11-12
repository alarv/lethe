#!/usr/bin/env node
/**
 * End-to-end agent evaluation: turns and tokens to a correct result.
 *
 * docs/evals.md states the claim this project stands on, and `evals/run.ts`
 * measures the layer under it (retrieval). This runs real agents over a whole
 * episode: a seed session discovers something, a probe session in a fresh
 * context needs it. It is the harness for the three launch conditions:
 *
 *   auto   Claude's own memory, lethe not installed
 *   lethe  lethe's memory, Claude auto memory switched off
 *   both   both, which is what a user who installs lethe actually has
 *
 * Isolation is the whole design. Each run gets its own repo, LETHE_HOME and
 * CLAUDE_CONFIG_DIR, so a run cannot see the previous one, touch the real
 * ~/.lethe, or inherit the operator's auto memory or settings. Telemetry is
 * switched off for every process the harness starts.
 *
 *   npm run eval:agent                                   # claude, all conditions
 *   npm run eval:agent -- --agent=mock                   # plumbing check, no model
 *   npm run eval:agent -- --repeats=5 --conditions=auto,lethe
 *
 * It needs a model. Set ANTHROPIC_API_KEY for the run: CLAUDE_CONFIG_DIR is
 * isolated, so Claude Code cannot use the operator's OAuth login. Nothing here
 * reads, stores or prints credentials.
 *
 * The only shipped scenario is `smoke`, which exists to prove the harness runs
 * end to end. It is not evidence for the thesis and its numbers must not be
 * quoted in docs/evals.md as such. Real scenarios need checks that run the
 * project's own tests, and tasks drawn from real sessions.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const scenariosDir = join(here, "scenarios");
const distCli = join(repoRoot, "dist", "cli.js");

type Condition = "cold" | "auto" | "lethe" | "both";
/**
 * The three launch conditions. `cold` is not one of them: it is a harness check,
 * not a product comparison. A run under `--conditions=cold` must fail, and if it
 * succeeds the isolation or the grading is broken.
 */
const CONDITIONS: Condition[] = ["cold", "auto", "lethe", "both"];
const DEFAULT_CONDITIONS: Condition[] = ["auto", "lethe", "both"];
type Phase = "seed" | "probe";
type Agent = "claude" | "mock";

type Check =
  | { kind: "file"; path: string; contains?: string }
  | { kind: "command"; command: string[]; expectExit?: number };

interface Scenario {
  id: string;
  category: string;
  /** What the seed session is asked to do. Discovers the thing worth keeping. */
  seedPrompt: string;
  /** The later task. Deliberately worded unlike the seed. */
  probePrompt: string;
  checks: Check[];
  /**
   * Only the mock reads this. A real scenario's answer is whatever its checks
   * verify, not a string a scenario hands the agent.
   */
  seedAnswer?: string;
}

interface Sandbox {
  base: string;
  repo: string;
  home: string;
  config: string;
}

interface Session {
  turns: number;
  tokens: number;
  outputTokens: number;
  costUsd: number;
  text: string;
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

interface Run {
  scenario: string;
  condition: Condition;
  repeat: number;
  solved: boolean;
  seed?: Session;
  probe?: Session;
  checks: CheckResult[];
  error?: string;
}

function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function intArg(name: string, fallback: number): number {
  const n = Number.parseInt(arg(name, String(fallback)), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function loadScenarios(): Scenario[] {
  const wanted = arg("scenarios", "");
  const ids = wanted
    ? wanted.split(",")
    : readdirSync(scenariosDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
  return ids.map((id) => {
    const file = join(scenariosDir, id, "scenario.json");
    const scenario = JSON.parse(readFileSync(file, "utf8")) as Scenario;
    if (scenario.id !== id) throw new Error(`${file}: id is "${scenario.id}", directory is "${id}"`);
    return scenario;
  });
}

function sandboxFor(scenario: Scenario): Sandbox {
  const base = mkdtempSync(join(tmpdir(), `lethe-agent-${scenario.id}-`));
  const repo = join(base, "repo");
  cpSync(join(scenariosDir, scenario.id, "repo"), repo, { recursive: true });
  // A repository, without depending on git being configured on this machine.
  mkdirSync(join(repo, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  const home = join(base, "home");
  const config = join(base, "config");
  mkdirSync(home, { recursive: true });
  mkdirSync(config, { recursive: true });
  return { base, repo, home, config };
}

function envFor(s: Sandbox, scenario: Scenario, condition: Condition, phase: Phase): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LETHE_HOME: s.home,
    CLAUDE_CONFIG_DIR: s.config,
    LETHE_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
    LETHE_EVAL_PHASE: phase,
    LETHE_EVAL_CONDITION: condition,
    LETHE_EVAL_MCP: condition === "lethe" || condition === "both" ? "1" : "0",
    LETHE_EVAL_SCENARIO: join(scenariosDir, scenario.id),
    LETHE_EVAL_ANSWER: scenario.seedAnswer ?? "",
    LETHE_CLI: distCli,
  };
  if (condition === "lethe" || condition === "cold") env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  else delete env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  return env;
}

function mcpConfig(s: Sandbox): string {
  return JSON.stringify({
    mcpServers: {
      lethe: {
        command: process.execPath,
        args: [distCli, "mcp"],
        env: { LETHE_HOME: s.home, LETHE_TELEMETRY: "0" },
      },
    },
  });
}

const ALLOWED = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "mcp__lethe__recall",
  "mcp__lethe__note",
  "mcp__lethe__confirm",
  "mcp__lethe__correct",
  "mcp__lethe__forget",
  "mcp__lethe__learn",
].join(",");

function argvFor(agent: Agent, prompt: string, condition: Condition, s: Sandbox, budget: string): string[] {
  if (agent === "mock") return [join(here, "mock-agent.mjs"), prompt];
  return [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    ALLOWED,
    "--strict-mcp-config",
    "--mcp-config",
    condition === "auto" ? JSON.stringify({ mcpServers: {} }) : mcpConfig(s),
    "--max-budget-usd",
    budget,
  ];
}

/** Claude Code's stream-json ends with one `result` event carrying the totals. */
function parseSession(stdout: string): Session | null {
  let last: Record<string, unknown> | null = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "result") last = event;
    } catch {
      /* not JSON: Claude sometimes writes a warning to stdout */
    }
  }
  if (!last) return null;
  const usage = (last.usage ?? {}) as Record<string, number | undefined>;
  const input = usage.input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return {
    turns: typeof last.num_turns === "number" ? last.num_turns : 0,
    tokens: input + cacheWrite + cacheRead + output,
    outputTokens: output,
    costUsd: typeof last.total_cost_usd === "number" ? last.total_cost_usd : 0,
    text: typeof last.result === "string" ? last.result : "",
  };
}

function runSession(
  agent: Agent,
  prompt: string,
  condition: Condition,
  scenario: Scenario,
  s: Sandbox,
  phase: Phase,
  timeoutMs: number,
  budget: string,
): { session?: Session; error?: string } {
  const r = spawnSync(agent === "mock" ? process.execPath : "claude", argvFor(agent, prompt, condition, s, budget), {
    cwd: s.repo,
    env: envFor(s, scenario, condition, phase),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { error: `${phase}: ${r.error.message}` };
  if (r.status !== 0) {
    const tail = (r.stderr ?? "").trim().split("\n").slice(-3).join(" | ");
    return { error: `${phase}: exit ${r.status}${tail ? ` (${tail})` : ""}` };
  }
  const session = parseSession(r.stdout ?? "");
  if (!session) {
    const tail = (r.stdout ?? "").trim().split("\n").slice(-2).join(" | ");
    return { error: `${phase}: no result event${tail ? ` (${tail})` : ""}` };
  }
  return { session };
}

function grade(scenario: Scenario, s: Sandbox, env: NodeJS.ProcessEnv): CheckResult[] {
  return scenario.checks.map((check) => {
    if (check.kind === "file") {
      const path = join(s.repo, check.path);
      if (!existsSync(path)) return { name: `file ${check.path}`, ok: false, detail: "missing" };
      const text = readFileSync(path, "utf8");
      const ok = check.contains === undefined || text.includes(check.contains);
      return {
        name: `file ${check.path}`,
        ok,
        detail: ok ? "ok" : `does not contain ${JSON.stringify(check.contains)}`,
      };
    }
    const [cmd, ...args] = check.command;
    if (!cmd) return { name: "command", ok: false, detail: "empty command" };
    const r = spawnSync(cmd, args, { cwd: s.repo, env, encoding: "utf8", timeout: 120_000 });
    const want = check.expectExit ?? 0;
    const ok = (r.status ?? -1) === want;
    return {
      name: `command ${check.command.join(" ")}`,
      ok,
      detail: ok ? "ok" : `exit ${r.status}: ${(r.stderr ?? "").trim().slice(-200)}`,
    };
  });
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function summarise(records: Run[]): void {
  console.log("\nprobe session, medians across runs");
  console.log("  condition   runs  solved   turns    tokens   output   cost    seed tokens");
  console.log("  ───────────────────────────────────────────────────────────────────────────");
  for (const condition of CONDITIONS) {
    const runs = records.filter((r) => r.condition === condition);
    if (!runs.length) continue;
    const probes = runs.flatMap((r) => (r.probe ? [r.probe] : []));
    const seeds = runs.flatMap((r) => (r.seed ? [r.seed] : []));
    const solved = runs.filter((r) => r.solved).length;
    console.log(
      `  ${condition.padEnd(9)}  ${String(runs.length).padStart(4)}  ${pct(solved / runs.length).padStart(5)}  ` +
        `${median(probes.map((p) => p.turns)).toFixed(1).padStart(5)}  ` +
        `${Math.round(median(probes.map((p) => p.tokens))).toString().padStart(7)}  ` +
        `${Math.round(median(probes.map((p) => p.outputTokens))).toString().padStart(6)}  ` +
        `$${median(probes.map((p) => p.costUsd)).toFixed(3).padStart(6)}  ` +
        `${Math.round(median(seeds.map((p) => p.tokens))).toString().padStart(11)}`,
    );
  }
  console.log("\n  seed is the cost of acquiring the memory; probe is the cost of using it.");
  console.log("  Solved is assertion-based. Every run, including failures, is in runs.jsonl.");
}

async function main(): Promise<void> {
  const agent = arg("agent", "claude") as Agent;
  if (agent !== "claude" && agent !== "mock") throw new Error(`unknown --agent=${agent}`);
  const conditions = (arg("conditions", DEFAULT_CONDITIONS.join(",")).split(",") as Condition[]).filter((c) =>
    CONDITIONS.includes(c),
  );
  if (!conditions.length) throw new Error("no valid conditions");
  const repeats = intArg("repeats", 5);
  const timeoutMs = intArg("timeout-ms", 600_000);
  const budget = arg("budget", "1.00");
  const keep = process.argv.includes("--keep");
  const scenarios = loadScenarios();

  if (!existsSync(distCli)) throw new Error("dist/cli.js is missing: run `npm run build` first");

  console.log(
    `lethe agent eval — ${scenarios.length} scenario(s) x ${conditions.length} condition(s) x ${repeats} ` +
      `repeats, agent=${agent}`,
  );
  if (agent === "mock") console.log("mock agent: this checks the harness, not the thesis.");
  console.log("auto memory, lethe and the operator's settings are isolated per run.");

  const records: Run[] = [];
  for (const scenario of scenarios) {
    for (const condition of conditions) {
      for (let repeat = 1; repeat <= repeats; repeat++) {
        const s = sandboxFor(scenario);
        const record: Run = { scenario: scenario.id, condition, repeat, solved: false, checks: [] };
        try {
          const seed = runSession(agent, scenario.seedPrompt, condition, scenario, s, "seed", timeoutMs, budget);
          record.seed = seed.session;
          if (seed.error) record.error = seed.error;
          else {
            const probe = runSession(agent, scenario.probePrompt, condition, scenario, s, "probe", timeoutMs, budget);
            record.probe = probe.session;
            if (probe.error) record.error = probe.error;
            else {
              record.checks = grade(scenario, s, envFor(s, scenario, condition, "probe"));
              record.solved = record.checks.every((c) => c.ok);
            }
          }
        } catch (e) {
          record.error = e instanceof Error ? e.message : String(e);
        } finally {
          if (!keep) rmSync(s.base, { recursive: true, force: true });
        }
        records.push(record);
        const status = record.error ? `error: ${record.error}` : record.solved ? "solved" : "unsolved";
        const turns = record.probe ? `${record.probe.turns} turns` : "";
        console.log(`  ${scenario.id} / ${condition} / run ${repeat}: ${status}${turns ? `, ${turns}` : ""}`);
      }
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = arg("out", join(repoRoot, "evals", "results", `agent-${stamp}`));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "runs.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(
    join(outDir, "summary.json"),
    JSON.stringify(
      {
        agent,
        conditions,
        repeats,
        scenarios: scenarios.map((s) => ({ id: s.id, category: s.category, prompts: { seed: s.seedPrompt, probe: s.probePrompt } })),
        // Raw records, not just the table: docs/evals.md promises the runs.
        results: records,
      },
      null,
      2,
    ) + "\n",
  );

  summarise(records);
  console.log(`\n  raw runs: ${outDir}`);
  if (agent === "mock") {
    console.log("  This proves the harness wires conditions, isolation and grading. It says nothing");
    console.log("  about whether memory helps, and must not be published as a result.");
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
