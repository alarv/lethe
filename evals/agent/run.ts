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
 * `--agent=opencode` runs the same pairs through opencode. It has no automatic
 * cross-session memory, so only `cold` and `lethe` are meaningful there.
 *
 * Isolation is the whole design. Each run gets its own repo, LETHE_HOME, HOME
 * per phase, and CLAUDE_CONFIG_DIR or opencode data/config/cache, so a run
 * cannot see the previous one, touch the real ~/.lethe, or inherit the
 * operator's auto memory or settings. The environment is stripped of PWD,
 * npm_* and the other variables that name this project, and the answer itself
 * is randomized per pair (`fact` + `{{FACT}}`) so it cannot be grepped from the
 * harness or an old result. The seed's session data is deleted before the
 * probe. A tool call outside the sandbox voids the run. Telemetry is off for
 * every process the harness starts.
 *
 *   npm run eval:agent                                   # claude, the three launch conditions
 *   npm run eval:agent -- --agent=mock                   # plumbing check, no model
 *   npm run eval:agent -- --agent=opencode --model=opencode/deepseek-v4.1-flash-free \
 *     --conditions=cold,lethe                            # free validation
 *   npm run eval:agent -- --repeats=5 --conditions=auto,lethe
 *
 * Claude needs a model. CLAUDE_CONFIG_DIR is isolated per run, and a fresh one
 * has no login, so the run authenticates from the environment: ANTHROPIC_API_KEY
 * for a Console key, or CLAUDE_CODE_OAUTH_TOKEN for a subscription token from
 * `claude setup-token`. The two are not interchangeable: a subscription token
 * in ANTHROPIC_API_KEY is rejected as an invalid API key. It never reads the
 * operator's keychain. Nothing here reads, stores or prints credentials. A
 * published run must name the agent version and model that produced it.
 *
 * The shipped scenarios are synthetic: they prove the harness runs end to end
 * and that a told fact survives a fresh checkout. They are not evidence for the
 * thesis and their numbers must not be quoted as such. The gate needs tasks
 * drawn from real sessions, with checks that run the project's own tests.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
type Agent = "claude" | "opencode" | "mock";

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
  /**
   * A per-pair random value. The scenario file stores a template such as
   * "staging-{{random}}.internal.example:8443"; every "{{FACT}}" in prompts,
   * checks and guards is replaced with it. This is what stops a probe from
   * grepping the harness, the real repo or an old result for the answer: the
   * answer only exists in memory while the pair runs.
   */
  fact?: string;
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
  /** Tools the host refused although the harness allowed them. */
  denied: string[];
  tools?: string[];
  toolCalls?: { tool: string; input?: unknown }[];
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
  /** The random value this pair used, for audit after the fact. */
  fact?: string;
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
    if (scenario.fact) assertNoLeak(materialize(scenario).scenario);
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
  if (scenario.fact && !scenario.fact.includes("{{random}}")) {
    throw new Error(`${file}: fact must contain {{random}}, or the answer is static on disk`);
  }
  if (!scenario.fact && JSON.stringify(scenario).includes("{{FACT}}")) {
    throw new Error(`${file}: uses {{FACT}} but has no fact template`);
  }
  if (scenario.probePrompt.includes("{{FACT}}")) {
    throw new Error(`${file}: probePrompt must not contain {{FACT}}; the probe would be told the answer`);
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
    // A template is checked after it is materialized for a pair.
    if (literal.includes("{{FACT}}")) continue;
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

function substitute<T>(value: T, fact: string): T {
  if (typeof value === "string") return value.replaceAll("{{FACT}}", fact) as T;
  if (Array.isArray(value)) return value.map((v) => substitute(v, fact)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substitute(v, fact);
    return out as T;
  }
  return value;
}

/**
 * A pair gets its own random fact. Never reuse a scenario object across pairs:
 * one repeat's answer must not be the next one's.
 */
function materialize(template: Scenario): { scenario: Scenario; fact: string | null } {
  if (!template.fact) return { scenario: template, fact: null };
  const fact = template.fact.replaceAll("{{random}}", randomBytes(4).toString("hex"));
  const scenario = substitute(template, fact);
  // The template's own `fact` is now a rendered value; do not substitute it again.
  scenario.fact = fact;
  return { scenario, fact };
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

function usesAutoMemory(condition: Condition): boolean {
  return condition === "auto" || condition === "both";
}

function envFor(agent: Agent, s: Sandbox, scenario: Scenario, condition: Condition, phase: Phase): NodeJS.ProcessEnv {
  // `$HOME` is the sandbox too. Without this, a probe can read the operator's
  // real ~/.lethe, shell history or projects; with it, `~` means nothing useful.
  const agentHome = join(s.base, `agent-home-${phase}`);
  mkdirSync(agentHome, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: agentHome,
    LETHE_HOME: s.home,
    LETHE_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
  };
  // The harness is started by `npm run` from this repository, so the inherited
  // environment names it. A probe that reads PWD or npm_config_local_prefix can
  // walk straight to the scenarios. The sandbox path is the only one it needs.
  for (const key of Object.keys(env)) {
    if (/^npm_/i.test(key)) delete env[key];
  }
  for (const key of [
    "INIT_CWD",
    "OLDPWD",
    "NODE_PATH",
    "NODE_OPTIONS",
    "ZDOTDIR",
    "BASH_ENV",
    "ENV",
    "CDPATH",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "_",
  ]) {
    delete env[key];
  }
  if (env.PATH) {
    env.PATH = env.PATH.split(":")
      .filter((p) => p && !resolve(p).startsWith(repoRoot))
      .join(":");
  }
  env.PWD = s.repo;
  env.OLDPWD = s.repo;
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
  if (agent === "claude") {
    env.CLAUDE_CONFIG_DIR = s.config;
    if (condition === "lethe" || condition === "cold") env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    else delete env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  }
  if (agent === "opencode") {
    // Per phase, so the probe cannot read the seed's session out of opencode's
    // own database. lethe's memory is LETHE_HOME, which both phases share.
    const oc = join(s.base, `opencode-${phase}`);
    for (const dir of ["data", "config", "cache"]) mkdirSync(join(oc, dir), { recursive: true });
    env.XDG_DATA_HOME = join(oc, "data");
    env.XDG_CONFIG_HOME = join(oc, "config");
    env.XDG_CACHE_HOME = join(oc, "cache");
    // No project config, no global config, no plugins or skills from the
    // operator's machine: only the MCP server this harness injects.
    env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
    env.OPENCODE_PURE = "1";
    env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1";
    env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1";
    env.OPENCODE_CONFIG_CONTENT = opencodeConfig(s, condition);
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  }
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

function opencodeConfig(s: Sandbox, condition: Condition): string {
  const mcp: Record<string, unknown> = {};
  if (usesLethe(condition)) {
    mcp.lethe = {
      type: "local",
      command: [process.execPath, distCli, "mcp"],
      enabled: true,
      environment: { LETHE_HOME: s.home, LETHE_TELEMETRY: "0" },
    };
  }
  return JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp });
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
  if (agent === "opencode") {
    return ["run", "--dir", s.repo, "--format", "json", "--model", model, "--auto", "--pure", prompt];
  }
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
function agentVersion(agent: Agent): string | null {
  if (agent === "mock") return null;
  const bin = agent === "opencode" ? "opencode" : "claude";
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "").trim() || null : null;
}

/** Claude Code's stream-json ends with one `result` event carrying the totals. */
function parseSession(stdout: string): Session | null {
  let last: Record<string, unknown> | null = null;
  const tools: string[] = [];
  const toolCalls: { tool: string; input?: unknown }[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "assistant") {
        const message = (event.message ?? {}) as Record<string, unknown>;
        const content = Array.isArray(message.content) ? message.content : [];
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === "tool_use" && typeof block.name === "string") {
            tools.push(block.name);
            toolCalls.push({ tool: block.name, input: block.input });
          }
        }
      }
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
    denied: Array.isArray(last.permission_denials)
      ? [...new Set((last.permission_denials as { tool_name?: string }[]).map((d) => String(d.tool_name)))]
      : [],
    tools,
    toolCalls,
  };
}

/**
 * These are not scenario failures: every later session will fail the same way,
 * and continuing turns one billing problem into 50 rows of noise.
 */
const FATAL: [RegExp, string][] = [
  [/credit balance is too low/i, "API credit is exhausted"],
  [/invalid x-api-key|invalid api key|"api_error_status":401/i, "the API key was rejected"],
  [/not logged in/i, "the session is not authenticated"],
  [/rate.?limit|too many requests|quota|insufficient_quota/i, "the model provider refused the request (rate limit or quota)"],
  [/unauthorized|\b401\b/i, "the model provider rejected the credential"],
  [/(5-hour|weekly|usage) limit|limit reached|hit your .*limit/i, "the subscription usage limit was reached"],
];

function fatalFrom(text: string): string | null {
  for (const [pattern, reason] of FATAL) if (pattern.test(text)) return reason;
  return null;
}

/**
 * opencode's `--format json` is one event per line. A `step_finish` carries the
 * token and cost totals for one model call, so the number of those events is
 * the turn count; text and tool events are for diagnosis.
 */
function parseOpencodeSession(stdout: string): Session | null {
  let turns = 0;
  let tokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  const texts: string[] = [];
  const tools: string[] = [];
  const toolCalls: { tool: string; input?: unknown }[] = [];
  const errors: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const part = (event.part ?? {}) as Record<string, unknown>;
    if (event.type === "step_finish") {
      turns += 1;
      const counts = (part.tokens ?? {}) as Record<string, unknown>;
      tokens += typeof counts.total === "number" ? counts.total : 0;
      outputTokens += typeof counts.output === "number" ? counts.output : 0;
      costUsd += typeof part.cost === "number" ? part.cost : 0;
    } else if (event.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    } else if (event.type === "tool_use" && typeof part.tool === "string") {
      tools.push(part.tool);
      const state = (part.state ?? {}) as Record<string, unknown>;
      toolCalls.push({ tool: part.tool, input: state.input });
    } else if (event.type === "error") {
      errors.push(JSON.stringify(event).slice(0, 300));
    }
  }
  if (turns === 0) return null;
  return {
    turns,
    tokens,
    outputTokens,
    costUsd,
    text: [...texts, ...errors].join("\n"),
    denied: [],
    tools,
    toolCalls,
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
  model: string,
): { session?: Session; error?: string; fatal?: string } {
  const bin = agent === "mock" ? process.execPath : agent === "opencode" ? "opencode" : "claude";
  // The eval measures memory, not whether an agent can find the harness on the
  // host. State the boundary; outsideSandbox enforces it after the fact.
  const guarded = `Work only inside the current repository. Do not read or search outside it.\n\n${prompt}`;
  const r = spawnSync(bin, argvFor(agent, guarded, condition, s, budget, model), {
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
  const session = agent === "opencode" ? parseOpencodeSession(r.stdout ?? "") : parseSession(r.stdout ?? "");
  if (!session) {
    const tail = (r.stdout ?? "").trim().split("\n").slice(-2).join(" | ");
    return { error: `${phase}: no result event${tail ? ` (${tail})` : ""}`, fatal: fatalFrom(output) ?? undefined };
  }
  // Every tool the agent needs is allowed on the command line, so a denial comes
  // from the host's own policy. The session did not run the condition it claims,
  // and every later session will be refused the same way.
  if (session.denied.length) {
    const tools = session.denied.join(", ");
    return { session, error: `${phase}: tools denied: ${tools}`, fatal: `the host denied tools the harness allows (${tools})` };
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

/**
 * A probe that searches the operator's home, the harness or an old result can
 * find the answer without any memory. The fact is randomized so a grep finds
 * nothing current, but an out-of-sandbox read is still not a fair run: mark it
 * and stop, rather than publish a number produced by an escape.
 */
function outsideSandbox(session: Session | undefined, s: Sandbox): string | null {
  const base = resolve(s.base);
  for (const call of session?.toolCalls ?? []) {
    const input = (call.input ?? {}) as Record<string, unknown>;
    for (const key of ["filePath", "file_path", "path", "command", "workdir", "cwd"]) {
      const value = input[key];
      if (typeof value !== "string") continue;
      const rest = value.split(base).join("SANDBOX");
      const outside =
        /(?:^|[\s"'`=])(?:\/Users\/|\/home\/|\/root\/)/.test(rest) ||
        /(?:^|[\s"'`=])\/(?:\s|$)/.test(rest) ||
        /(?:^|[\s"'`=])\.\.\/\.\./.test(rest);
      if (outside) return `${call.tool} ${key}: ${value.slice(0, 200)}`;
    }
  }
  return null;
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
    for (const template of scenarios) {
      const provenance = template.provenance ?? "synthetic";
      const from = template.harvestedFrom ? ` · ${template.harvestedFrom.date} ${template.harvestedFrom.session}` : "";
      const sample = materialize(template);
      assertNoLeak(sample.scenario);
      const fact = template.fact ? " · random fact per pair" : "";
      console.log(
        `  ${template.id.padEnd(24)} ${provenance.padEnd(10)} ${template.checks.length} check(s), ` +
          `${template.repoMustNotContain?.length ?? 0} leak guard(s)${from}${fact}`,
      );
    }
    console.log("\n  all scenarios are valid and leak-free.");
    return;
  }
  const agent = arg("agent", "claude") as Agent;
  if (agent !== "claude" && agent !== "opencode" && agent !== "mock") {
    throw new Error(`unknown --agent=${agent}`);
  }
  const model = arg("model", "");
  if (agent === "opencode" && !model) {
    throw new Error("--agent=opencode needs an explicit --model=provider/model so the run names its model.");
  }
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasOauthToken = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  if (agent === "claude" && !hasApiKey && !hasOauthToken) {
    throw new Error(
      "no model credential: a fresh CLAUDE_CONFIG_DIR has no login, so the run would fail 24 times.\n" +
        "Set ANTHROPIC_API_KEY for a Console key, or CLAUDE_CODE_OAUTH_TOKEN for a subscription\n" +
        "token from `claude setup-token`. They are not interchangeable.",
    );
  }
  if (agent === "claude" && hasApiKey && hasOauthToken) {
    console.log("both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set; the API key wins.");
    console.log("Unset the one you do not mean to use.");
  }
  // opencode has no automatic cross-session memory, so `auto` and `both` would
  // be the same as `cold` and `lethe`. Refuse them rather than mislabel a run.
  const defaultConditions = agent === "opencode" ? ["cold", "lethe"] : DEFAULT_CONDITIONS;
  const conditions = (arg("conditions", defaultConditions.join(",")).split(",") as Condition[]).filter((c) =>
    CONDITIONS.includes(c),
  );
  if (!conditions.length) throw new Error("no valid conditions");
  if (agent === "opencode") {
    const unsupported = conditions.filter((c) => c === "auto" || c === "both");
    if (unsupported.length) {
      throw new Error(
        `opencode has no Claude auto memory: use --conditions=cold,lethe (got ${unsupported.join(",")}).`,
      );
    }
  }
  const repeats = intArg("repeats", 5);
  const timeoutMs = intArg("timeout-ms", 600_000);
  const budget = arg("budget", "1.00");
  const totalBudgetRaw = Number(arg("total-budget", "0"));
  const totalBudget = Number.isFinite(totalBudgetRaw) && totalBudgetRaw > 0 ? totalBudgetRaw : 0;
  const keep = process.argv.includes("--keep");
  const version = agentVersion(agent);

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
    console.log(`auth: ${hasApiKey ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN"}`);
    console.log("auto memory, lethe and the operator's settings are isolated per run.");
  } else if (agent === "opencode") {
    console.log(`opencode ${version ?? "(version unknown)"}, model ${model}`);
    console.log("project config, global config, plugins and the operator's sessions are isolated per run.");
  }
  if (totalBudget) console.log(`total budget: $${totalBudget.toFixed(2)}; the run stops when it is reached.`);

  const planned = scenarios.length * conditions.length * repeats;
  const records: Run[] = [];
  let aborted: string | null = null;
  outer: for (const template of scenarios) {
    for (const condition of conditions) {
      for (let repeat = 1; repeat <= repeats; repeat++) {
        const { scenario, fact } = materialize(template);
        const s = sandboxFor(scenario);
        const record: Run = { scenario: scenario.id, condition, repeat, solved: false, checks: [] };
        if (fact) record.fact = fact;
        let fatal: string | undefined;
        try {
          const seed = runSession(agent, scenario.seedPrompt, condition, scenario, s, "seed", timeoutMs, budget, model);
          record.seed = seed.session;
          fatal = seed.fatal;
          const seedOutside = outsideSandbox(seed.session, s);
          if (seed.error) record.error = seed.error;
          else if (seedOutside) {
            record.error = `out-of-sandbox access: ${seedOutside}`;
            fatal = "out-of-sandbox access";
          } else {
            // The seed's session is in this directory; the probe must not be
            // able to read the prompt, which contains the answer.
            if (agent === "opencode") rmSync(join(s.base, "opencode-seed"), { recursive: true, force: true });
            rmSync(join(s.base, "agent-home-seed"), { recursive: true, force: true });
            // Auto memory is the thing `auto` and `both` measure, so it stays.
            // For the other conditions the seed's config is only a transcript.
            if (agent === "claude" && !usesAutoMemory(condition)) {
              rmSync(s.config, { recursive: true, force: true });
              mkdirSync(s.config, { recursive: true });
            }
            resetRepo(s, scenario, condition);
            const probe = runSession(agent, scenario.probePrompt, condition, scenario, s, "probe", timeoutMs, budget, model);
            record.probe = probe.session;
            fatal = probe.fatal ?? fatal;
            const probeOutside = outsideSandbox(probe.session, s);
            if (probe.error) record.error = probe.error;
            else if (probeOutside) {
              record.error = `out-of-sandbox access: ${probeOutside}`;
              fatal = "out-of-sandbox access";
            } else {
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
        const spent = records.reduce((sum, r) => sum + (r.seed?.costUsd ?? 0) + (r.probe?.costUsd ?? 0), 0);
        if (totalBudget && spent > totalBudget && records.length < planned) {
          aborted = `total budget of $${totalBudget.toFixed(2)} reached`;
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
        agentVersion: version,
        claudeVersion: agent === "claude" ? version : null,
        model: model || null,
        conditions,
        repeats,
        startedAt: stamp,
        scenarios: scenarios.map((s) => ({
          id: s.id,
          category: s.category,
          provenance: s.provenance ?? "synthetic",
          harvestedFrom: s.harvestedFrom ?? null,
          factTemplate: s.fact ?? null,
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
    console.log(`\n  run aborted: ${aborted}.`);
    if (/credit|key|auth|logged in/i.test(aborted)) {
      console.log("  Check ANTHROPIC_API_KEY (a `claude setup-token` token belongs in CLAUDE_CODE_OAUTH_TOKEN), then retry.");
    } else if (/denied/.test(aborted)) {
      console.log("  Managed settings with allowManagedPermissionRulesOnly ignore --allowedTools, so an");
      console.log("  unattended session cannot use them. Run the eval where that policy does not apply.");
    } else if (/out-of-sandbox/.test(aborted)) {
      console.log("  The agent read outside the sandbox, so this run measures the host, not memory. It is invalid.");
      console.log("  Run the eval in a clean container, or keep every fact randomized and never paste one on disk.");
    } else if (/limit/i.test(aborted)) {
      console.log("  Wait for the 5-hour or weekly reset, or switch to API credit, then retry.");
    } else {
      console.log("  Partial results are saved; raise --total-budget to finish the run.");
    }
    console.log("  The partial results are not a result.");
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
