#!/usr/bin/env node
/**
 * CLI.
 *
 * `lethe mcp` is the entry point harnesses use; everything else is for
 * inspecting the store by hand while dogfooding.
 */

import { Store, findProjectRoot, memoryDir, type Scope } from "./store.js";
import { serve } from "./server.js";

const USAGE = `lethe -- a memory harness for coding agents that forgets on purpose

  lethe mcp                    run the MCP server over stdio (what harnesses call)
  lethe ls [--scope=S]         list stored memories
  lethe recall <query>         search memory
  lethe note <title> [body]    record a memory by hand
  lethe forget <id>            delete a memory
  lethe where                  show where memory is stored
  lethe compact [--dry-run]    consolidate and decay        (not implemented yet)

  scopes: project (shared via the repo) | personal (yours only)
`;

function flag(args: string[], name: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=")[1];
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const store = new Store();
  const scope = (flag(rest, "scope") ?? "project") as Scope;

  switch (cmd) {
    case "mcp":
      await serve();
      return;

    case "where": {
      const root = findProjectRoot();
      console.log(`project root : ${root ?? "(not in a git repo)"}`);
      if (root) console.log(`project      : ${memoryDir("project")}`);
      console.log(`personal     : ${memoryDir("personal")}`);
      return;
    }

    case "ls": {
      const all = scope === "project" || scope === "personal"
        ? store.list(scope)
        : store.all();
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

    case "compact":
      console.error(
        "not implemented.\n\n" +
          "Compaction is the point of the project and is deliberately not stubbed:\n" +
          "an implementation that silently does nothing is worse than one that says so.\n" +
          "Capture first, then evaluate whether distillation beats raw logs.\n" +
          "See docs/compact.md.",
      );
      process.exit(1);
      return;

    default:
      console.log(USAGE);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
