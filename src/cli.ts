#!/usr/bin/env node
/**
 * CLI.
 *
 * `lethe mcp` is the entry point harnesses use; everything else is for
 * inspecting the store by hand while dogfooding.
 */

import { Store, findProjectRoot, letheHome, memoryDir, readSource, type Scope } from "./store.js";
import { composition, formatComposition, formatMetrics, metrics, readLog } from "./metrics.js";

/** Mirrors the server's threshold, so status and metrics agree with the trigger. */
function pressureThreshold(): number {
  const n = Number(process.env.LETHE_PRESSURE);
  return Number.isFinite(n) && n > 0 ? n : 6;
}
import { promptHook } from "./hook.js";
import { defaultScope, globalConfigPath, ignoreInGit, loadConfig, projectConfigPath, writeConfig } from "./config.js";
import { serve } from "./server.js";
import { compact, formatReport } from "./compact.js";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOG_PATH, buildStamp, tail } from "./log.js";
import { describeDistiller, resolveDistiller } from "./distil.js";

const USAGE = `lethe -- a memory harness for coding agents that forgets on purpose

  lethe mcp                    run the MCP server over stdio (what harnesses call)
  lethe ls [--scope=S]         list stored memories
  lethe recall <query>         search memory
  lethe note <title> [body]    record a memory by hand
  lethe forget <id>            delete a memory
  lethe doctor                 diagnose setup problems
  lethe restart                stop running servers (harness respawns them)
  lethe rules                  append the memory instructions to AGENTS.md
  lethe status                 is it working? counts, pressure, last activity
  lethe metrics                is it being used? adoption, recall/note balance
  lethe hook prompt            recall for a prompt (for a UserPromptSubmit hook)
  lethe hook show              print the hook config to add to settings.json
  lethe log [-n N]             recent activity
  lethe init [--private]       set up memory for this project
       [--scope=S] [--global]
  lethe projects               every project with stored memory
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
  const scope = (flag(rest, "scope") as Scope | undefined) ?? defaultScope();

  switch (cmd) {
    case "mcp":
      await serve();
      return;

    case "rules": {
      // The tool descriptions carry the "when to call" guidance to every host,
      // but a project with its own AGENTS.md overrides the global one, so the
      // reminder to use memory at all can go missing exactly where it is needed.
      const root = findProjectRoot();
      const target = root ? join(root, "AGENTS.md") : null;
      if (!target) {
        console.error("not inside a git repository");
        process.exit(1);
      }
      const block = [
        "",
        "## Memory (lethe)",
        "",
        "Before investigating anything non-trivial, call lethe's `recall` first — a",
        "failing test, a build error, an unfamiliar area, a setup problem. It may",
        "already be solved. When you learn something durable, record it with `note`.",
        "If a recalled memory is wrong, fix it with `correct`; if it was right and",
        "useful, `confirm` it.",
        "",
      ].join("\n");
      const current = existsSync(target) ? readFileSync(target, "utf8") : "";
      if (current.includes("## Memory (lethe)")) {
        console.log(`${target} already has the lethe section.`);
        return;
      }
      writeFileSync(target, current + block, "utf8");
      console.log(`appended the lethe section to ${target}`);
      return;
    }

    case "hook": {
      const which = rest[0];
      if (which === "prompt") {
        await promptHook();
        return;
      }
      if (which === "show") {
        // Printed rather than written. Editing someone's settings.json without
        // being asked is not a thing a memory tool should do on its own.
        const bin = process.argv[1] ?? "lethe";
        console.log(`Add this to ~/.claude/settings.json to have every prompt recall first:

  {
    "hooks": {
      "UserPromptSubmit": [
        {
          "hooks": [
            { "type": "command", "command": ${JSON.stringify(`node --disable-warning=ExperimentalWarning ${bin} hook prompt`)} }
          ]
        }
      ]
    }
  }

It prints recalled memories on stdout, which the host adds to the context, so
recall happens whether or not the model thinks to ask. It stays silent when it
finds nothing, skips slash commands and one-word prompts, and exits 0 on any
failure -- a memory tool must never be why a session breaks.

Recalls it performs are logged with via=hook, so \`lethe metrics\` can show
whether this is what moved adoption.`);
        return;
      }
      console.error("usage: lethe hook prompt | lethe hook show");
      process.exit(1);
    }

    case "metrics": {
      console.log(formatMetrics(metrics(readLog())));
      console.log(formatComposition(composition(store.all()), pressureThreshold()));
      return;
    }

    case "restart": {
      // MCP servers are per-session children of the harness; killing them makes
      // the harness spawn fresh ones on its next call. This exists because a
      // rebuild does not reach a running server, and stale servers have
      // repeatedly caused bugs that look like data loss.
      const { execFileSync } = await import("node:child_process");
      let out = "";
      try {
        out = execFileSync("pgrep", ["-f", "lethe/dist/cli.js mcp"], { encoding: "utf8" });
      } catch {
        console.log("no lethe servers running");
        return;
      }
      const pids = out.split("\n").map((l) => l.trim()).filter(Boolean)
        .filter((pid) => pid !== String(process.pid));
      for (const pid of pids) {
        try { process.kill(Number(pid)); } catch { /* already gone */ }
      }
      console.log(`stopped ${pids.length} server(s). Your harness will spawn a fresh one.`);
      return;
    }

    case "doctor": {
      const ok = (b: boolean) => (b ? "ok  " : "FAIL");
      const lines = tail(500);
      const problems: string[] = [];

      const root = findProjectRoot();
      console.log(`${ok(true)} store      ${memoryDir("local")}`);
      if (!root) {
        console.log(`     note       not a git repo; memory is keyed to this directory`);
      }

      const d = await resolveDistiller();
      console.log(`${ok(!!d)} distiller  ${d ? d.via : "none"}`);
      if (!d) {
        problems.push(
          "No model available, so consolidation cannot run and episodes will\n" +
          "  accumulate. Install opencode or claude, or set LETHE_API_KEY.",
        );
      }

      const lastStart = [...lines].reverse().find((l) => l.includes(" start "));
      const stale = lastStart && !lastStart.includes(`build=${buildStamp()}`);
      console.log(`${ok(!stale)} build      ${stale ? "running server is older than the built code" : "current"}`);
      if (stale) {
        problems.push("Start a new session; the server is spawned per session and yours predates the last build.");
      }

      const notes = lines.filter((l) => l.includes(" note ")).length;
      const recalls = lines.filter((l) => l.includes(" recall ")).length;
      console.log(`${ok(notes > 0)} writing    ${notes} note(s) recorded`);
      if (!notes) {
        problems.push(
          "Nothing has been recorded. Either the harness never started the\n" +
          "  server, or nothing tells the agent to use it -- check that your\n" +
          "  AGENTS.md or CLAUDE.md mentions lethe.",
        );
      }
      console.log(`${ok(recalls > 0)} reading    ${recalls} recall(s)`);
      if (notes > 0 && recalls === 0) {
        problems.push("Memories are being written but never read back. The rules file needs to push recall before investigating.");
      }

      // Different repositories legitimately have different stores. What matters
      // is a store keyed to somewhere that is not a project at all -- a temp
      // directory, your home directory, or a parent folder that merely contains
      // repositories. Those are the sessions whose memories nobody will find.
      const seen = new Map<string, string>();
      for (const l of lines) {
        if (!l.includes(" start ")) continue;
        const cwd = /cwd=(\S+)/.exec(l)?.[1];
        const st = /store=(\S+)/.exec(l)?.[1];
        if (cwd && st) seen.set(cwd, st);
      }
      const orphans = [...seen].filter(([cwd]) => !existsSync(join(cwd, ".git")));
      const withContent = orphans.filter(([, st]) =>
        existsSync(st) && readdirSync(st).some((f) => f.endsWith(".md")));

      const bindState = withContent.length ? "FAIL" : orphans.length ? "warn" : "ok  ";
      console.log(`${bindState} binding    ${seen.size} workspace(s)${orphans.length ? `, ${orphans.length} outside a repo` : ""}`);
      if (withContent.length) {
        problems.push(
          "Memories were written from directories that are not repositories, so\n" +
          "  they are keyed somewhere nothing will look again:\n  " +
          withContent.map(([cwd, st]) => `${cwd}\n    -> ${st}`).join("\n  "),
        );
      } else if (orphans.length) {
        problems.push(
          "Some sessions ran outside a repository, but those stores are empty --\n" +
          "  nothing was lost. Newer builds ask the client for its workspace root,\n" +
          "  so this should not recur.",
        );
      }

      if (!problems.length) {
        console.log("\nNo problems found.");
        return;
      }
      console.log("");
      for (const p of problems) console.log(`- ${p}`);
      return;
    }

    case "status": {
      const all = store.all();
      const by = (k: string) => all.filter((m) => m.kind === k && !m.supersededBy).length;
      const episodes = by("episode");
      const lines = tail(500);
      const last = (e: string) => [...lines].reverse().find((l) => l.includes(` ${e} `));

      console.log(`memories   ${all.length}  (${episodes} episode, ${by("claim")} claim, ${by("pattern")} pattern)`);
      const threshold = pressureThreshold();
      const pressure = store.all()
        .filter((m) => m.kind === "episode" && !m.supersededBy)
        .reduce((sum, m) => sum + m.salience, 0);
      console.log(
        `pressure   ${pressure.toFixed(1)}/${threshold} salience across ${episodes} raw episode(s)` +
          `${pressure >= threshold ? " — compaction due" : ""}`,
      );
      const root = findProjectRoot();
      console.log(`store      ${root ? memoryDir("local") : "(not in a git repo — local scope unavailable)"}`);
      console.log(`log        ${LOG_PATH}`);
      console.log(`distiller  ${await describeDistiller()}`);
      console.log(`scope      ${defaultScope()}${loadConfig().scope ? " (configured)" : " (default)"}`);
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

    case "init": {
      const want = (flag(rest, "scope") as Scope | undefined) ?? "team";
      const isGlobal = rest.includes("--global");
      const root = findProjectRoot();

      if (want === "team" && !root && !isGlobal) {
        console.error("team scope stores memory in the repository, and this is not one.");
        process.exit(1);
      }

      const path = isGlobal ? globalConfigPath() : projectConfigPath();
      if (!path) {
        console.error("not inside a git repository; use --global");
        process.exit(1);
      }
      writeConfig(path, { scope: want });
      console.log(`${isGlobal ? "global" : "project"} config  ${path}`);
      console.log(`default scope  ${want}`);
      console.log(`memory goes to ${memoryDir(want)}`);

      // Storing in the repo and committing it are separate choices.
      if (want === "team" && root) {
        const share = !rest.includes("--private");
        const r = ignoreInGit(root, share);
        console.log("");
        console.log("episodes   private to you, never committed");
        console.log(share
          ? "claims     committed — the team inherits what has been learned"
          : "claims     kept local — uncomment .lethe/memory/ in .gitignore to share");
        if (r === "present") console.log("\n.gitignore already had a lethe section; left alone.");
        else if (r === "failed") console.log("\ncould not write .gitignore.");
        if (share) console.log("\nre-run with --private to keep claims off the repo.");
      }
      return;
    }

    case "projects": {
      const dir = join(letheHome(), "projects");
      if (!existsSync(dir)) {
        console.log("no projects yet");
        return;
      }
      const rows = readdirSync(dir)
        .map((key) => {
          const mem = join(dir, key, "memory");
          const files = existsSync(mem) ? readdirSync(mem).filter((f) => f.endsWith(".md")) : [];
          return { path: readSource(join(dir, key)) ?? key, n: files.length };
        })
        .filter((r) => r.n > 0)
        .sort((a, b) => b.n - a.n);
      if (!rows.length) {
        console.log("no memories stored yet");
        return;
      }
      for (const r of rows) console.log(`${String(r.n).padStart(4)}  ${r.path}`);
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
        const from = m.fromProject ? `  (from ${m.fromProject})` : "";
        console.log(`\n[${m.id.slice(0, 8)}] ${m.title}${from}`);
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
      const resolved = await resolveDistiller();
      if (resolved) console.log(`distilling via ${resolved.via}\n`);
      const r = await compact(store, {
        claimScope: defaultScope(),
        ...(resolved ? { distil: resolved.distil } : {}),
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
