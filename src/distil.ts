/**
 * Finding a model to distil with.
 *
 * MCP sampling is the ideal path -- the host's own model, no key, no cost beyond
 * what the user is already spending. In practice hosts largely do not implement
 * it yet, which left consolidation unable to run at all, and consolidation is
 * the entire point of the project.
 *
 * So: try sampling, then anything else the machine already has. Order is by
 * decreasing preference, and every option is something the user has already set
 * up for themselves -- we never ask for a key we could avoid asking for.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Distiller } from "./compact.js";
import { log } from "./log.js";

const run = promisify(execFile);

/** Long enough for a small model on a slow day, short enough to give up. */
const TIMEOUT_MS = 90_000;

/**
 * Set in spawned children so a nested harness cannot start its own compaction
 * and spawn a further child. Without this, one compaction can fork indefinitely.
 */
const GUARD = "LETHE_CHILD";

export interface Resolved {
  distil: Distiller;
  via: string;
}

async function onPath(cmd: string): Promise<boolean> {
  try {
    await run("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

/** Any OpenAI-compatible endpoint: LETHE_API_KEY, optionally LETHE_API_URL. */
function fromApi(): Resolved | null {
  const key = process.env.LETHE_API_KEY;
  if (!key) return null;
  const url = process.env.LETHE_API_URL ?? "https://api.openai.com/v1/chat/completions";
  const model = process.env.LETHE_MODEL ?? "gpt-4o-mini";
  return {
    via: `api ${model}`,
    distil: async (prompt) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return json.choices?.[0]?.message?.content ?? "";
    },
  };
}

async function fromOllama(): Promise<Resolved | null> {
  const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const json = (await res.json()) as { models?: { name: string }[] };
    const model = process.env.LETHE_MODEL ?? json.models?.[0]?.name;
    if (!model) return null;
    return {
      via: `ollama ${model}`,
      distil: async (prompt) => {
        const r = await fetch(`${host}/api/generate`, {
          method: "POST",
          body: JSON.stringify({ model, prompt, stream: false }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const j = (await r.json()) as { response?: string };
        return j.response ?? "";
      },
    };
  } catch {
    return null;
  }
}

// CSI sequences (colours, cursor moves) and OSC sequences (titles, links).
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

/**
 * What to say when a distiller CLI exits non-zero.
 *
 * Built from stderr alone this logged `opencode exited 1: [0m` -- a colour reset
 * and nothing else. Escapes are stripped, and when stderr has nothing left the
 * tail of stdout is used, since some CLIs print their errors there.
 */
export function failureDetail(stderr: string, stdout: string, max = 300): string {
  const clean = (s: string) => s.replace(ANSI, "").trim();
  // An error line beats a banner. opencode prints "> build · <model>" first and
  // the reason after it, so the first 300 characters reported the banner and a
  // week of "monthly quota exceeded" was logged as "exited 1: > build".
  const lines = (s: string) => clean(s).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const isReason = (l: string) =>
    /error|fail|denied|exceeded|quota|unauthori[sz]ed|forbidden|not found|invalid|refused|timed? ?out/i.test(l);
  const fromErr = lines(stderr).filter(isReason).join(" | ");
  if (fromErr) return fromErr.slice(0, max);
  // stdout is read from the end, where a CLI puts the line that ended it.
  const fromOut = lines(stdout).filter(isReason).join(" | ");
  if (fromOut) return fromOut.length > max ? fromOut.slice(-max).trim() : fromOut;
  const err = clean(stderr);
  if (err) return err.replace(/\s*\n\s*/g, " | ").slice(0, max);
  const out = clean(stdout).replace(/\s*\n\s*/g, " | ");
  return out.length > max ? out.slice(-max).trim() : out;
}

/**
 * Run a command with stdin closed.
 *
 * execFile leaves stdin as an open pipe, and a CLI that reads stdin will wait on
 * it forever -- which looked exactly like the model being slow, and cost a
 * ninety-second timeout per attempt.
 */
function capture(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else {
        const detail = failureDetail(err, out);
        reject(new Error(`${cmd} exited ${code}` + (detail ? `: ${detail}` : " with no output")));
      }
    });
  });
}

/**
 * Harness CLIs the user already has installed and authenticated.
 *
 * `--pure` keeps plugins out of the child, which matters because the child would
 * otherwise load this very server.
 */
async function fromCli(): Promise<Resolved | null> {
  const env = { ...process.env, [GUARD]: "1" };

  // No model is named unless LETHE_MODEL says so: a hardcoded one ages out, or is
  // not on the user's plan, and the CLI already knows what its user has access to.
  const model = process.env.LETHE_MODEL;

  if (await onPath("opencode")) {
    return {
      via: `opencode ${model ?? "(default model)"}`,
      distil: (prompt) => capture("opencode", ["run", "--pure", ...(model ? ["-m", model] : []), prompt], env),
    };
  }

  if (await onPath("claude")) {
    return {
      via: `claude ${model ?? "(default model)"}`,
      distil: (prompt) => capture("claude", ["-p", ...(model ? ["--model", model] : []), prompt], env),
    };
  }
  return null;
}

/**
 * Every distiller this machine can offer, in preference order.
 *
 * resolveDistiller takes the first; doctor probes down the list when the
 * first cannot distil, so a broken default does not hide a working fallback.
 *
 * @param sampling supplied by the MCP server when the host advertises it.
 */
export async function listDistillers(
  sampling?: Distiller | undefined,
): Promise<Resolved[]> {
  const mode = process.env.LETHE_DISTILLER ?? "auto";
  if (mode === "off") return [];

  // A distiller running inside a spawned child would fork again.
  if (process.env[GUARD] === "1") return [];

  if (sampling) return [{ distil: sampling, via: "host sampling" }];
  if (mode === "sampling") return [];

  const out: Resolved[] = [];
  const api = fromApi();
  if (api) out.push(api);

  const ollama = await fromOllama();
  if (ollama) out.push(ollama);

  const cli = await fromCli();
  if (cli) out.push(cli);

  return out;
}

/**
 * @param sampling supplied by the MCP server when the host advertises it.
 */
export async function resolveDistiller(
  sampling?: Distiller | undefined,
): Promise<Resolved | null> {
  return (await listDistillers(sampling))[0] ?? null;
}

export async function describeDistiller(): Promise<string> {
  const r = await resolveDistiller();
  return r ? r.via : "none — consolidation will be skipped";
}

export function logResolved(r: Resolved | null): void {
  log("sampling", r ? `distilling via ${r.via}` : "no model available; consolidation skipped");
}

export interface ProbeResult {
  via: string;
  ok: boolean;
  /** Why it failed: the distiller's own error, or "empty reply". */
  reason: string | null;
}

/**
 * Is the distiller working right now, not merely installed?
 *
 * Resolving only answers "found": a CLI on PATH with an expired login, or an
 * opencode account over quota, resolves fine and then fails every call --
 * which went unnoticed for weeks because nothing ever asked it to distil
 * outside a real compaction. The prompt is four words so the check costs
 * almost nothing, and it never touches the log or telemetry: a diagnosis is
 * not activity.
 */
export async function probeDistiller(r: Resolved): Promise<ProbeResult> {
  try {
    const out = await r.distil("Reply with exactly: ok");
    if (!out.trim()) return { via: r.via, ok: false, reason: "empty reply" };
    return { via: r.via, ok: true, reason: null };
  } catch (e) {
    return { via: r.via, ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
