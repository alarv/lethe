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
 * It needs a model. CLAUDE_CONFIG_DIR is isolated per run, and a fresh one has
 * no login, so the run authenticates with ANTHROPIC_API_KEY (or the long-lived
 * token from `claude setup-token`). It never reads the operator's keychain.
 * Nothing here reads, stores or prints credentials. A published run must name
 * the Claude Code version and model that produced it.
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
  statSync,
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
  /**
   * `harvested` came from a real session; `synthetic` is written by hand. Only
   * harvested pairs can support a claim about real work.
   */
  provenance?: "harvested" | "synthetic";
  /**
   * Required for `harvested`: when and where the pair came from, so a reviewer
   * can ask for the session instead of taking the label on trust.
   */
  harvestedFrom?: { date: string; session: string; redactions?: string[] };
  /** What the seed session is asked to do. Discovers the thing worth keeping. */
  seedPrompt: string;
  /** The later task. Deliberately worded unlike the seed. */
  probePrompt: string;
  checks: Check[];
  /**
   * Literals the probe must not be able to find: checked against every file in
   * the sandbox repo and against the probe prompt before a run starts. A pair
   * that leaks its answer produces a valid-looking run that measures nothing.
   */
  repoMustNotContain?: string[];
  /**
   * Environment passed only to command checks, never to the agent. Lets a check
   * assert on a value without putting it in the sandbox repo where the probe
   * could read it.
   */
  checkEnv?: Record<string, string>;
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
        .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
        .map((d) => d.name)
        .sort();
  return ids.map((id) => {
    const file = join(scenariosDir, id, "scenario.json");
    const scenario = JSON.parse(readFileSync(file, "utf8")) as Scenario;
    if (scenario.id !== id) throw new Error(`${file}: id is "${scenario.id}", directory is "${id}"`);
    assertValid(scenario, file);
    assertNoLeak(scenario);
    return scenario;
  });
}

/**
 * A label is not evidence. `harvested` is the only provenance that can support
 * a claim about real work, so it must say where the pair came from.
 */
function assertValid(scenario: Scenario, file: string): void {
  const provenance = scenario.provenance ?? "synthetic";
  if (provenance !== "harvested" && provenance !== "synthetic") {
    throw new Error(`${file}: provenance must be "harvested" or "synthetic"`);
  }
  for (const field of ["id", "category", "seedPrompt", "probePrompt"] as const) {
    if (typeof scenario[field] !== "string" || !scenario[field]!.trim()) {
      throw new Error(`${file}: ${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(scenario.checks) || !scenario.checks.length) {
    throw new Error(`${file}: at least one check is required`);
  }
  if (provenance === "harvested") {
    if (!scenario.harvestedFrom?.date || !scenario.harvestedFrom?.session) {
      throw new Error(`${file}: harvested pairs need harvestedFrom { date, session }`);
    }
    if (!scenario.repoMustNotContain?.length) {
      throw new Error(`${file}: harvested pairs need repoMustNotContain, or the probe may just read the answer`);
    }
  }
}

/**
 * A scenario whose answer is in the prompt or the fixture cannot distinguish
 * memory from search. Fail before spending a model, not after.
 */
function assertNoLeak(scenario: Scenario): void {
  const literals = scenario.repoMustNotContain ?? [];
  const probe = scenario.probePrompt.toLowerCase();
  for (const literal of literals) {
    if (probe.includes(literal.toLowerCase())) {
      throw new Error(`${scenario.id}: repoMustNotContain "${literal}" appears in the probe prompt`);
    }
    const repo = join(scenariosDir, scenario.id, "repo");
    for (const entry of readdirSync(repo, { recursive: true, encoding: "utf8" })) {
      const file = join(repo, entry);
      if (!statSync(file).isFile()) continue;
      if (readFileSync(file, "utf8").includes(literal)) {
        throw new Error(`${scenario.id}: answer "${literal}" is in the sandbox repo at ${entry}`);
      }
    }
  }
}

function sandboxFor(scenario: Scenario): Sandbox {
  const base = mkdtempSync(join(tmpdir(), `lethe-agent-${scenario.id}-`));
  const repo = join(base, "repo");
  copyFixture(scenario, repo);
  const home = join(base, "home");
  const config = join(base, "config");
  mkdirSync(home, { recursive: true });
  mkdirSync(config, { recursive: true });
  return { base, repo, home, config };
}

function copyFixture(scenario: Scenario, repo: string): void {
  cpSync(join(scenariosDir, scenario.id, "repo"), repo, { recursive: true });
  // A repository, without depending on git being configured on this machine.
  mkdirSync(join(repo, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
}

/**
 * The probe is a fresh checkout, not the seed's working tree. Anything the seed
 * wrote into the repository is discarded; memory survives only where it is
 * supposed to: committed claims in `.lethe/` for the lethe conditions, and the
 * stores outside the repo (`LETHE_HOME`, `CLAUDE_CONFIG_DIR`) for all of them.
 */
function resetRepo(s: Sandbox, scenario: Scenario, condition: Condition): void {
  const keep = join(s.base, "repo-lethe-keep");
  const keepMemory = usesLethe(condition);
  const hasMemory = keepMemory && existsSync(join(s.repo, ".lethe"));
  if (hasMemory) cpSync(join(s.repo, ".lethe"), keep, { recursive: true });
  rmSync(s.repo, { recursive: true, force: true });
  copyFixture(scenario, s.repo);
  if (hasMemory) cpSync(keep, join(s.repo, ".lethe"), { recursive: true });
  rmSync(keep, { recursive: true, force: true });
}

/**
 * `home` is LETHE_HOME. A condition with lethe off that still wrote there did not
 * get the baseline it claims to be, so the run is void rather than merely slow.
 */
function assertNoLetheStore(s: Sandbox): void {
  const projects = join(s.home, "projects");
  if (!existsSync(projects)) return;
  const written = readdirSync(projects);
  if (written.length) throw new Error(`lethe store written while lethe was off: ${written.join(", ")}`);
}

function usesLethe(condition: Condition): boolean {
  return condition === "lethe" || condition === "both";
}

function envFor(agent: Agent, s: Sandbox, scenario: Scenario, condition: Condition, phase: Phase): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LETHE_HOME: s.home,
    CLAUDE_CONFIG_DIR: s.config,
    LETHE_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
  };
  // The mock needs the answer to act. A real agent must never see it, or the
  // probe can read the answer out of its own environment and the run is void.
  if (agent === "mock") {
    env.LETHE_EVAL_PHASE = phase;
    env.LETHE_EVAL_CONDITION = condition;
    env.LETHE_EVAL_MCP = usesLethe(condition) ? "1" : "0";
    env.LETHE_EVAL_SCENARIO = join(scenariosDir, scenario.id);
    env.LETHE_EVAL_ANSWER = scenario.seedAnswer ?? "";
    env.LETHE_CLI = distCli;
  }
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

function argvFor(
  agent: Agent,
  prompt: string,
  condition: Condition,
  s: Sandbox,
  budget: string,
  model: string,
): string[] {
  if (agent === "mock") return [join(here, "mock-agent.mjs"), prompt];
  const argv = [
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
    usesLethe(condition) ? mcpConfig(s) : JSON.stringify({ mcpServers: {} }),
    "--max-budget-usd",
    budget,
  ];
  if (model) argv.push("--model", model);
  return argv;
}

/** The version is part of the result: a run is only comparable to the same build. */
function claudeVersion(): string | null {
  const r = spawnSync("claude", ["--version"], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "").trim() || null : null;
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

/**
 * These are not scenario failures: every later session will fail the same way,
 * and continuing turns one billing problem into 50 rows of noise.
 */
const FATAL: [RegExp, string][] = [
  [/credit balance is too low/i, "API credit is exhausted"],
  [/invalid x-api-key/i, "the API key was rejected"],
  [/not logged in/i, "the session is not authenticated"],
];

function fatalFrom(text: string): string | null {
  for (const [pattern, reason] of FATAL) if (pattern.test(text)) return reason;
  return null;
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
  model: string,
): { session?: Session; error?: string; fatal?: string } {
  const r = spawnSync(agent === "mock" ? process.execPath : "claude", argvFor(agent, prompt, condition, s, budget, model), {
    cwd: s.repo,
    env: envFor(agent, s, scenario, condition, phase),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { error: `${phase}: ${r.error.message}` };
  const output = `${r.stderr ?? ""}\n${r.stdout ?? ""}`.trim();
  if (r.status !== 0) {
    // The CLI sometimes exits 1 with the only explanation on stdout, so both
    // streams belong in the message.
    const tail = output.split("\n").slice(-3).join(" | ").slice(-400);
    return {
      error: `${phase}: exit ${r.status}${tail ? ` (${tail})` : ""}`,
      fatal: fatalFrom(output) ?? undefined,
    };
  }
  const session = parseSession(r.stdout ?? "");
  if (!session) {
    const tail = (r.stdout ?? "").trim().split("\n").slice(-2).join(" | ");
    return { error: `${phase}: no result event${tail ? ` (${tail})` : ""}`, fatal: fatalFrom(output) ?? undefined };
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
    const r = spawnSync(cmd, args, {
      cwd: s.repo,
      env: { ...env, ...scenario.checkEnv },
      encoding: "utf8",
      timeout: 120_000,
    });
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
  console.log("  condition   runs  errors  solved   turns    tokens   output   cost    seed tokens");
  console.log("  ────────────────────────────────────────────────────────────────────────────────────");
  for (const condition of CONDITIONS) {
    const runs = records.filter((r) => r.condition === condition);
    if (!runs.length) continue;
    const probes = runs.flatMap((r) => (r.probe ? [r.probe] : []));
    const seeds = runs.flatMap((r) => (r.seed ? [r.seed] : []));
    const solved = runs.filter((r) => r.solved).length;
    const errors = runs.filter((r) => r.error).length;
    console.log(
      `  ${condition.padEnd(9)}  ${String(runs.length).padStart(4)}  ${String(errors).padStart(6)}  ${pct(solved / runs.length).padStart(5)}  ` +
        `${median(probes.map((p) => p.turns)).toFixed(1).padStart(5)}  ` +
        `${Math.round(median(probes.map((p) => p.tokens))).toString().padStart(7)}  ` +
        `${Math.round(median(probes.map((p) => p.outputTokens))).toString().padStart(6)}  ` +
        `$${median(probes.map((p) => p.costUsd)).toFixed(3).padStart(6)}  ` +
        `${Math.round(median(seeds.map((p) => p.tokens))).toString().padStart(11)}`,
    );
  }
  console.log("\n  seed is the cost of acquiring the memory; probe is the cost of using it.");
  console.log("  Solved is assertion-based. Every run, including failures, is in runs.jsonl.");
  const total = records.reduce((sum, r) => sum + (r.seed?.costUsd ?? 0) + (r.probe?.costUsd ?? 0), 0);
  const sessions = records.reduce((n, r) => n + (r.seed ? 1 : 0) + (r.probe ? 1 : 0), 0);
  console.log(`  total reported cost: $${total.toFixed(2)} for ${sessions} sessions.`);
  const errored = records.filter((r) => r.error).length;
  if (errored) {
    console.log(`\n  ${errored} run(s) errored. This run is VOID: an error is not an unsolved run.`);
    console.log("  The table above is partial at best; do not quote it. runs.jsonl has each error.");
    process.exitCode = 1;
  }

  // With a handful of pairs, medians across all of them hide a scenario that
  // always wins or always loses. Show each one.
  if (new Set(records.map((r) => r.scenario)).size > 1) {
    const present = CONDITIONS.filter((c) => records.some((r) => r.condition === c));
    console.log("\nper scenario (solved% / median probe turns)");
    console.log(`  ${"scenario".padEnd(24)}${present.map((c) => c.padStart(12)).join("")}`);
    for (const id of [...new Set(records.map((r) => r.scenario))]) {
      const cells = present.map((condition) => {
        const runs = records.filter((r) => r.scenario === id && r.condition === condition);
        if (!runs.length) return "—".padStart(12);
        const solved = runs.filter((r) => r.solved).length;
        const errors = runs.filter((r) => r.error).length;
        const turns = median(runs.flatMap((r) => (r.probe ? [r.probe.turns] : [])));
        return `${errors ? "!" : ""}${pct(solved / runs.length)} / ${turns.toFixed(1)}`.padStart(12);
      });
      console.log(`  ${id.padEnd(24)}${cells.join("")}`);
    }
    if (records.some((r) => r.error)) console.log("  ! = has errored runs; those cells are not results.");
  }
}

async function main(): Promise<void> {
  const scenarios = loadScenarios();
  if (process.argv.includes("--validate")) {
    console.log("scenarios (validated; no model is run)");
    for (const s of scenarios) {
      const provenance = s.provenance ?? "synthetic";
      const from = s.harvestedFrom ? ` · ${s.harvestedFrom.date} ${s.harvestedFrom.session}` : "";
      console.log(
        `  ${s.id.padEnd(24)} ${provenance.padEnd(10)} ${s.checks.length} check(s), ` +
          `${s.repoMustNotContain?.length ?? 0} leak guard(s)${from}`,
      );
    }
    console.log("\n  all scenarios are valid and leak-free.");
    return;
  }
  const agent = arg("agent", "claude") as Agent;
  if (agent !== "claude" && agent !== "mock") throw new Error(`unknown --agent=${agent}`);
  if (agent === "claude" && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "no ANTHROPIC_API_KEY: a fresh CLAUDE_CONFIG_DIR has no login, so the run would fail 24 times.\n" +
        "Run `claude setup-token`, export the token as ANTHROPIC_API_KEY, and retry.",
    );
  }
  const conditions = (arg("conditions", DEFAULT_CONDITIONS.join(",")).split(",") as Condition[]).filter((c) =>
    CONDITIONS.includes(c),
  );
  if (!conditions.length) throw new Error("no valid conditions");
  const repeats = intArg("repeats", 5);
  const timeoutMs = intArg("timeout-ms", 600_000);
  const budget = arg("budget", "1.00");
  const model = arg("model", "");
  const keep = process.argv.includes("--keep");
  const version = agent === "claude" ? claudeVersion() : null;

  if (!existsSync(distCli)) throw new Error("dist/cli.js is missing: run `npm run build` first");

  console.log(
    `lethe agent eval — ${scenarios.length} scenario(s) x ${conditions.length} condition(s) x ${repeats} ` +
      `repeats, agent=${agent}`,
  );
  if (agent === "mock") console.log("mock agent: this checks the harness, not the thesis.");
  const synthetic = scenarios.filter((s) => (s.provenance ?? "synthetic") === "synthetic").length;
  if (synthetic) {
    console.log(
      `${synthetic} synthetic scenario(s): they can show a fact survived, not that real repeated work got cheaper.`,
    );
  }
  const harvested = scenarios.filter((s) => s.provenance === "harvested").length;
  if (harvested) console.log(`${harvested} harvested scenario(s).`);
  if (agent === "claude") {
    console.log(`claude ${version ?? "(version unknown)"}${model ? `, model ${model}` : ", account default model"}`);
  }
  console.log("auto memory, lethe and the operator's settings are isolated per run.");

  const records: Run[] = [];
  let aborted: string | null = null;
  outer: for (const scenario of scenarios) {
    for (const condition of conditions) {
      for (let repeat = 1; repeat <= repeats; repeat++) {
        const s = sandboxFor(scenario);
        const record: Run = { scenario: scenario.id, condition, repeat, solved: false, checks: [] };
        let fatal: string | undefined;
        try {
          const seed = runSession(agent, scenario.seedPrompt, condition, scenario, s, "seed", timeoutMs, budget, model);
          record.seed = seed.session;
          fatal = seed.fatal;
          if (seed.error) record.error = seed.error;
          else {
            resetRepo(s, scenario, condition);
            const probe = runSession(agent, scenario.probePrompt, condition, scenario, s, "probe", timeoutMs, budget, model);
            record.probe = probe.session;
            fatal = probe.fatal ?? fatal;
            if (probe.error) record.error = probe.error;
            else {
              if (!usesLethe(condition)) assertNoLetheStore(s);
              record.checks = grade(scenario, s, envFor(agent, s, scenario, condition, "probe"));
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
        if (fatal) {
          aborted = fatal;
          break outer;
        }
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
        claudeVersion: version,
        model: model || null,
        conditions,
        repeats,
        startedAt: stamp,
        scenarios: scenarios.map((s) => ({
          id: s.id,
          category: s.category,
          provenance: s.provenance ?? "synthetic",
          harvestedFrom: s.harvestedFrom ?? null,
          prompts: { seed: s.seedPrompt, probe: s.probePrompt },
        })),
        // Raw records, not just the table: docs/evals.md promises the runs.
        results: records,
      },
      null,
      2,
    ) + "\n",
  );

  if (aborted) {
    console.log(`\n  run aborted: ${aborted}. Every later session would fail the same way.`);
    console.log("  Top up the API key, or use a token from `claude setup-token`, then retry.");
    console.log("  The partial results are saved, but they are not a result.");
    process.exitCode = 1;
  }
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
