#!/usr/bin/env node
/**
 * CLI.
 *
 * `lethe mcp` is the entry point harnesses use; everything else is for
 * inspecting the store by hand while dogfooding.
 */

import { Store, findProjectRoot, memoryDir, type Scope } from "./store.js";
import { serve } from "./server.js";
import { compact, formatReport } from "./compact.js";
import { LOG_PATH, buildStamp, tail } from "./log.js";

const USAGE = `lethe -- a memory harness for coding agents that forgets on purpose

  lethe mcp                    run the MCP server over stdio (what harnesses call)
  lethe ls [--scope=S]         list stored memories
  lethe recall <query>         search memory
  lethe note <title> [body]    record a memory by hand
  lethe forget <id>            delete a memory
  lethe status                 is it working? counts, pressure, last activity
  lethe log [-n N]             recent activity
  lethe where                  show where memory is stored
  lethe compact [--dry-run]    consolidate, promote, decay

  scopes:
    local     this repo, private to you, in ~/.lethe   (default)
    team      committed to the repo, shared
    personal  you, across every repo

`;

function flag(args: string[], name: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=")[1];
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const store = new Store();
  const scope = (flag(rest, "scope") ?? "local") as Scope;

  switch (cmd) {
    case "mcp":
      await serve();
      return;

    case "status": {
      const all = store.all();
      const by = (k: string) => all.filter((m) => m.kind === k && !m.supersededBy).length;
      const episodes = by("episode");
      const lines = tail(500);
      const last = (e: string) => [...lines].reverse().find((l) => l.includes(` ${e} `));

      console.log(`memories   ${all.length}  (${episodes} episode, ${by("claim")} claim, ${by("pattern")} pattern)`);
      console.log(`pressure   ${episodes}/12 ${episodes >= 12 ? "— compaction due" : ""}`);
      const root = findProjectRoot();
      console.log(`store      ${root ? memoryDir("local") : "(not in a git repo — local scope unavailable)"}`);
      console.log(`log        ${LOG_PATH}`);
      console.log("");
      if (!lines.length) {
        console.log("No activity logged yet.");
        console.log("If you expected some: the harness may not have started the server,");
        console.log("or the agent was never told to call the tools. Check `lethe log`");
        console.log("after a session, and that your AGENTS.md/CLAUDE.md mentions lethe.");
        return;
      }
      const lastStart = last("start");
      if (lastStart) {
        const m = /build=(\S+)/.exec(lastStart);
        if (m && m[1] !== buildStamp()) {
          console.log(`WARNING  the running server is older than the built code.`);
          console.log(`         restart your harness, or it keeps using the old version.`);
          console.log("");
        }
      }
      for (const [label, ev] of [["server start", "start"], ["last recall", "recall"], ["last note", "note"], ["last compact", "compact"]] as const) {
        const l = last(ev);
        // log line: <24-char ISO><2sp><8-char event><2sp><detail>
        console.log(`${label.padEnd(13)} ${l ? `${l.slice(0, 19)}  ${l.slice(36)}` : "never"}`);
      }
      return;
    }

    case "log": {
      const i = rest.indexOf("-n");
      const n = i >= 0 ? Number(rest[i + 1] ?? 40) : 40;
      const lines = tail(n);
      console.log(lines.length ? lines.join("\n") : `nothing logged yet (${LOG_PATH})`);
      return;
    }

    case "where": {
      const root = findProjectRoot();
      console.log(`repo      ${root ?? "(not in a git repo)"}`);
      if (root) {
        console.log(`local     ${memoryDir("local")}`);
        console.log(`team      ${memoryDir("team")}`);
      }
      console.log(`personal  ${memoryDir("personal")}`);
      return;
    }

    case "ls": {
      const all = rest.some((a) => a.startsWith("--scope=")) ? store.list(scope) : store.all();
      if (!all.length) {
        console.log("no memories yet");
        return;
      }
      for (const m of all.sort((a, b) => b.updated.localeCompare(a.updated))) {
        const dead = m.supersededBy ? " (superseded)" : "";
        console.log(
          `${m.id.slice(0, 8)}  ${m.kind.padEnd(8)}  s=${m.strength.toFixed(2)}  ${m.title}${dead}`,
        );
      }
      return;
    }

    case "recall": {
      // Deliberately does not reinforce. This is you inspecting the store by
      // hand; counting it as use would inflate the very signal decay and
      // promotion are meant to measure. Only agent recall, via MCP, reinforces.
      const hits = store.search(rest.filter((a) => !a.startsWith("--")).join(" "));
      if (!hits.length) {
        console.log("nothing matched");
        return;
      }
      for (const m of hits) {
        console.log(`\n[${m.id.slice(0, 8)}] ${m.title}`);
        if (m.body) console.log(m.body.split("\n").map((l) => `  ${l}`).join("\n"));
      }
      return;
    }

    case "note": {
      const args = rest.filter((a) => !a.startsWith("--"));
      const [title, ...body] = args;
      if (!title) {
        console.error("usage: lethe note <title> [body]");
        process.exit(1);
      }
      const m = store.create({ title, body: body.join(" "), scope });
      console.log(`recorded ${m.id.slice(0, 8)}`);
      return;
    }

    case "forget": {
      const id = rest[0];
      if (!id) {
        console.error("usage: lethe forget <id>");
        process.exit(1);
      }
      console.log(store.remove(id) ? "forgotten" : "not found");
      return;
    }

    case "compact": {
      const r = await compact(store, {
        dryRun: rest.includes("--dry-run"),
        deep: rest.includes("--deep"),
      });
      console.log(formatReport(r));
      if (rest.includes("--dry-run")) console.log("\n  (dry run -- nothing was written)");
      return;
    }

    default:
      console.log(USAGE);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
