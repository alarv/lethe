#!/usr/bin/env node
/**
 * A stand-in for a coding agent, so the harness can be tested without a model.
 *
 * It behaves the way the conditions are meant to differ: the seed session saves
 * what it learned to whichever memory system the condition has, and the probe
 * session is quick if it can read it back and slow (and wrong) if it cannot.
 *
 * The turns and token counts are invented. The only thing this proves is that
 * the harness isolates conditions, carries memory across the two sessions, and
 * grades the result. It is never evidence about lethe.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const prompt = process.argv[2] ?? "";
const phase = process.env.LETHE_EVAL_PHASE === "seed" ? "seed" : "probe";
const condition = process.env.LETHE_EVAL_CONDITION ?? "auto";
const answer = process.env.LETHE_EVAL_ANSWER ?? "";
const cli = process.env.LETHE_CLI ?? "";
const mcp = process.env.LETHE_EVAL_MCP === "1";
const config = process.env.CLAUDE_CONFIG_DIR ?? ".";
const autoMemory = join(config, "auto-memory.txt");

function emit(turns, tokens, output) {
  const usage = { input_tokens: Math.max(0, tokens - output), output_tokens: output };
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      num_turns: turns,
      total_cost_usd: 0,
      usage,
      result: `mock ${phase}`,
    }) + "\n",
  );
}

if (!answer) {
  console.error("mock: LETHE_EVAL_ANSWER is empty; the scenario must set seedAnswer");
  process.exit(1);
}

if (phase === "seed") {
  if (mcp && cli) {
    const r = spawnSync(process.execPath, [cli, "note", "fixture database must be started first", answer], {
      encoding: "utf8",
      env: process.env,
    });
    if (r.status !== 0) console.error(`mock: note failed: ${(r.stderr ?? "").trim()}`);
  }
  if (condition === "auto" || condition === "both") {
    appendFileSync(autoMemory, `seed: ${answer}\n`);
  }
  emit(2, 900, 140);
} else {
  let known = false;
  if (mcp && cli) {
    const r = spawnSync(process.execPath, [cli, "recall", "tests failing fixture database"], {
      encoding: "utf8",
      env: process.env,
    });
    known = r.status === 0 && (r.stdout ?? "").includes(answer);
  }
  if (!known && (condition === "auto" || condition === "both") && existsSync(autoMemory)) {
    known = readFileSync(autoMemory, "utf8").includes(answer);
  }
  if (known) {
    writeFileSync("SOLVED", `${answer}\n`);
    emit(2, 1600, 180);
  } else {
    emit(6, 5200, 640);
  }
}
