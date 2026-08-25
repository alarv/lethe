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
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 300)}`));
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

  if (await onPath("opencode")) {
    const model = process.env.LETHE_MODEL ?? "github-copilot/claude-haiku-4.5";
    return {
      via: `opencode ${model}`,
      distil: (prompt) => capture("opencode", ["run", "--pure", "-m", model, prompt], env),
    };
  }

  if (await onPath("claude")) {
    const model = process.env.LETHE_MODEL ?? "haiku";
    return {
      via: `claude ${model}`,
      distil: (prompt) => capture("claude", ["-p", "--model", model, prompt], env),
    };
  }
  return null;
}

/**
 * @param sampling supplied by the MCP server when the host advertises it.
 */
export async function resolveDistiller(
  sampling?: Distiller | undefined,
): Promise<Resolved | null> {
  const mode = process.env.LETHE_DISTILLER ?? "auto";
  if (mode === "off") return null;

  // A distiller running inside a spawned child would fork again.
  if (process.env[GUARD] === "1") return null;

  if (sampling) return { distil: sampling, via: "host sampling" };
  if (mode === "sampling") return null;

  const api = fromApi();
  if (api) return api;

  const ollama = await fromOllama();
  if (ollama) return ollama;

  const cli = await fromCli();
  if (cli) return cli;

  return null;
}

export async function describeDistiller(): Promise<string> {
  const r = await resolveDistiller();
  return r ? r.via : "none — consolidation will be skipped";
}

export function logResolved(r: Resolved | null): void {
  log("sampling", r ? `distilling via ${r.via}` : "no model available; consolidation skipped");
}
