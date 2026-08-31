#!/usr/bin/env node
/**
 * CLI.
 *
 * `lethe mcp` is the entry point harnesses use; everything else is for
 * inspecting the store by hand while dogfooding.
 */

import { Store, claimDir, episodeDir, findProjectRoot, legacyClaimDir, letheHome, readSource } from "./store.js";
import { composition, formatComposition, formatMetrics, metrics, readLog, since } from "./metrics.js";

/** Mirrors the server's threshold, so status and metrics agree with the trigger. */
function pressureThreshold(): number {
  const n = Number(process.env.LETHE_PRESSURE);
  return Number.isFinite(n) && n > 0 ? n : 6;
}
import { promptHook } from "./hook.js";
import { PLACEMENTS, choose } from "./prompt.js";
import { claimSharing, globalConfigPath, ignoreInGit, shareDefault, staleConfig, staleRootIgnore, writeConfig } from "./config.js";
import { serve } from "./server.js";
import { compact, formatReport } from "./compact.js";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOG_PATH, buildStamp, logging, tail } from "./log.js";
import { human, prune, survey } from "./maintain.js";
import { describeDistiller, resolveDistiller } from "./distil.js";
import { facts, seed, writeWatermark } from "./learn.js";
import { spinning, task } from "./progress.js";

const USAGE = `lethe -- a memory harness for coding agents that forgets on purpose

  lethe mcp                    run the MCP server over stdio (what harnesses call)
  lethe ls                     list stored memories
  lethe recall <query>         search memory
  lethe note <title> [body]    record a memory by hand
  lethe forget <id>            delete a memory
  lethe doctor                 diagnose setup problems
  lethe restart                stop running servers (harness respawns them)
  lethe rules                  append the memory instructions to AGENTS.md
  lethe status                 is it working? counts, pressure, last activity
  lethe metrics [--json]       is it being used? adoption, recall/note balance
       [--since=YYYY-MM-DD]    exclude history you do not trust
  lethe hook prompt            recall for a prompt (for a UserPromptSubmit hook)
  lethe hook show              print the hook config to add to settings.json
  lethe log [-n N]             recent activity
  lethe init                   decide if this project's claims are committed
       [--share] [--private]   answer up front instead of being asked
       [--global]              set the default for projects that have not chosen
       [--debug|--no-debug]    record activity to ~/.lethe/lethe.log (off by default)
  lethe learn [--dry-run]      seed memory from this repo's own conventions
  lethe projects               every project with stored memory
  lethe where                  show where memory is stored
  lethe compact [--dry-run]    consolidate, promote, decay
  lethe gc [--dry-run]         report ~/.lethe and remove what is dead
       [--dead] [--reindex]    also drop projects whose path is gone / the index
       [--log]                 also delete the log file

  memory goes where it belongs without being told. Consolidated claims land in
  <repo>/.lethe/memory/, beside the code they describe; raw episodes land in
  ~/.lethe and are never written to a repository. The only decision is whether
  the claims are committed, and .lethe/.gitignore is where that decision lives.

`;

function flag(args: string[], name: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=")[1];
}

/**
 * Seed memory from the repo, reported the same way from `init` and `learn`.
 *
 * Shared so setup and the standalone command cannot drift into describing the
 * same operation differently -- the whole point of the seed is that a user
 * understands what got written without going to look.
 */
function reportSeed(store: Store, root: string, dryRun: boolean): void {
  const found = facts(root);
  if (!found.length) {
    console.log("memory    nothing recognisable to seed from -- no package.json, Makefile,");
    console.log("          pyproject.toml or CI workflow found. Memory starts empty and");
    console.log("          fills up as work happens.");
    return;
  }

  const t = task("reading this repo", { total: found.length });
  const report = seed(store, root, { dryRun, onFact: () => t.step() });
  t.done();

  const wrote = report.written + report.revised;
  const verb = dryRun ? "would seed" : "seeded";
  console.log(`memory    ${verb} ${wrote} claim(s) from ${report.sources.join(", ")}` +
    `${report.unchanged ? `, ${report.unchanged} already current` : ""}`);
  console.log("          how to build, test and check here -- the things an agent otherwise");
  console.log("          rediscovers by reading three files. Weak on purpose: a seed nobody");
  console.log("          recalls decays out in about two months, so a wrong guess expires.");

  if (!dryRun) {
    writeWatermark(root, {
      at: new Date().toISOString(),
      seeded: wrote,
      // History distillation needs a model and is not built yet; recording null
      // rather than a commit keeps the field honest about what has been read.
      historyThrough: null,
    });
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const store = new Store();

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
      const from = flag(rest, "since");
      const lines = from ? since(readLog(), from) : readLog();
      const m = metrics(lines);
      const c = composition(store.all());

      if (rest.includes("--json")) {
        // For tracking over time: append a line a day and the trend is visible
        // without anyone having to remember what last week's numbers were.
        console.log(JSON.stringify({ at: new Date().toISOString(), ...m, since: from ?? null, composition: c }));
        return;
      }
      console.log(formatMetrics(m) + (from ? `\n\n  counting from ${from} onward.` : ""));
      console.log(formatComposition(c, pressureThreshold()));
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
      console.log(`${ok(true)} claims     ${claimDir()}`);
      console.log(`${ok(true)} episodes   ${episodeDir()}`);
      if (!root) {
        console.log(`     note       not a git repo; both are keyed to this directory`);
      }

      // The removed `scope` setting is the last thing that can make someone
      // believe their memory is somewhere it is not.
      const staleScope = staleConfig();
      if (staleScope.length) {
        console.log(`warn config     ${staleScope.length} file(s) still set \`scope\``);
        problems.push(
          "A config file still sets `scope`, which no longer exists. Where a memory\n" +
          "  goes is derived from what it is, and sharing is decided by\n" +
          "  .lethe/.gitignore. The setting is ignored, so delete the line:\n  " +
          staleScope.join("\n  "),
        );
      }

      // The home directory is the one thing here that grows unattended, so
      // doctor reports its size and names anything dead in it.
      const sw = survey();
      console.log(`ok   home       ${human(sw.totalBytes)} in ${letheHome()}` +
        `  (${sw.live.length} project(s), index ${human(sw.indexBytes)}` +
        `${sw.logBytes ? `, log ${human(sw.logBytes)}` : ""})`);
      if (sw.orphaned.length) {
        const memories = sw.orphaned.reduce((n, o) => n + o.files, 0);
        console.log(`warn projects   ${sw.orphaned.length} keyed to a path that is gone, holding ${memories} memory(ies)`);
        problems.push(
          `${sw.orphaned.length} project director(ies) are keyed to a path that no longer\n` +
          "  exists, but still hold memories, so nothing was removed automatically --\n" +
          "  a missing path is as likely to be an unmounted disk or a moved checkout\n" +
          "  as a deleted repo. Review them with `lethe gc`, then `lethe gc --dead`:\n  " +
          sw.orphaned.map((o) => `${o.source} (${o.files})\n    -> ${o.dir}`).join("\n  "),
        );
      }

      // Claims live in the repo whether or not they are shared, so git-ignored
      // is now a legitimate answer rather than the contradiction it used to be
      // -- that FAIL is gone. The one state still worth flagging is claims that
      // are neither ignored nor committed: sharing is on and nobody ran
      // `git add`.
      if (root) {
        const sh = claimSharing(root);
        const warn = sh.state === "untracked";
        console.log(`${warn ? "warn" : "ok  "} sharing    ${
          sh.state === "shared" ? `${sh.tracked} claim(s) committed`
          : sh.state === "ignored" ? "git-ignored, private to you"
          : sh.state === "untracked" ? `${sh.files} claim(s) written but never committed`
          : sh.state === "empty" ? "no claims yet"
          : "could not ask git"}`);
        if (warn) {
          problems.push(
            `${sh.files} claim(s) are in the repo and not ignored, but have never been\n` +
            "  committed. `git add .lethe/memory` to share what has been learned, or\n" +
            "  `lethe init --private` if they were never meant to be.",
          );
        }
      }

      // Probing costs a few `which` calls and a 1.5s reach for ollama, which
      // until now happened in silence in the middle of doctor's output.
      const d = await spinning("looking for a model", () => resolveDistiller());
      console.log(`${ok(!!d)} distiller  ${d ? d.via : "none"}`);
      if (!d) {
        problems.push(
          "No model available, so consolidation cannot run and episodes will\n" +
          "  accumulate. Install opencode or claude, or set LETHE_API_KEY.",
        );
      }

      // Everything below is derived from the log, so with logging off the
      // honest answer is "not recorded" -- not "zero", which reads as a
      // failure and would send someone hunting for a problem that is really
      // just a setting.
      if (!logging()) {
        console.log("     activity   not recorded (logging is off)");
        console.log("                `lethe init --debug` to record adoption, then re-run this");
        console.log("");
        for (const p of problems) console.log(`- ${p}`);
        if (!problems.length) console.log("No problems found.");
        return;
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
      console.log(`claims     ${claimDir()}`);
      console.log(`episodes   ${episodeDir()}`);
      console.log(`log        ${logging() ? LOG_PATH : "off (`lethe init --debug` to record activity)"}`);
      console.log(`distiller  ${await describeDistiller()}`);
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
      const root = findProjectRoot();
      const isGlobal = rest.includes("--global");

      // Outside a repository there is no sharing decision to make: claims fall
      // back to the same per-project directory as episodes, where git cannot
      // reach them either way. Saying so beats asking a question whose answer
      // could not be applied.
      if (!root && !isGlobal) {
        console.log("not a git repository, so there is nothing to decide here.\n");
        console.log(`memory    ${episodeDir()}`);
        console.log("          keyed to this directory; no repo means nothing to commit to");
        console.log("");
        console.log("run this inside a repository to choose whether its claims are committed,");
        console.log("or `lethe init --global --share` to set the default for new projects.");
        return;
      }

      // Logging is a property of this machine, not of a project, so it goes to
      // the global config wherever it is asked for -- and it is deliberately
      // separable from the sharing question, which is why it returns here.
      if (rest.includes("--debug") || rest.includes("--no-debug")) {
        const on = !rest.includes("--no-debug");
        writeConfig(globalConfigPath(), { log: on });
        console.log(`global config  ${globalConfigPath()}`);
        console.log(`logging        ${on ? `on -- ${LOG_PATH}` : "off"}`);
        console.log("");
        console.log(on
          ? "`lethe metrics` and the activity rows in `status` and `doctor` work from\nthis file. It rotates at 512 KB and keeps one previous copy."
          : "nothing further is written to the log file. `lethe gc --log` deletes it.");
        return;
      }

      const flagged = rest.includes("--share") ? true
        : rest.includes("--private") ? false
        : null;
      let share: boolean;

      // Ask only when nothing was specified and there is someone to ask, so
      // scripts and CI keep working unattended.
      if (flagged === null && !isGlobal && process.stdin.isTTY) {
        const pick = await choose("this project's consolidated claims should be", PLACEMENTS);
        if (pick === null) {
          console.log("\ncancelled; nothing written.");
          return;
        }
        share = PLACEMENTS[pick]!.share;
        console.log("");
      } else {
        share = flagged ?? shareDefault();
      }

      // --global sets what new projects start from and nothing else. It cannot
      // decide for a project that has already chosen, because that project's
      // .gitignore is the choice -- which is why there is no longer a config
      // file to contradict it.
      if (isGlobal) {
        writeConfig(globalConfigPath(), { share });
        console.log(`global config  ${globalConfigPath()}`);
        console.log(`new projects   claims ${share ? "committed" : "git-ignored"} by default`);
        console.log("");
        console.log("that is only the answer `lethe init` starts from in a project that has");
        console.log("not chosen yet; an existing .lethe/.gitignore always wins.");
        return;
      }

      const r = ignoreInGit(root!, share);

      // Say where both kinds land. Leaving the split implicit is what sent
      // people looking for their episodes in a repository that has never held
      // any.
      console.log(`claims    ${claimDir()}`);
      console.log(share
        ? "          committed -- anyone who can clone this repo inherits what has been learned"
        : "          git-ignored -- they stay on this machine and only you can read them");
      // The audience for committed memory is whoever can clone the repo, which
      // in a public one is everybody. Worth one line at the moment the decision
      // is made rather than a paragraph in a README nobody re-reads.
      if (share) {
        console.log("          if this repository is public, so is everything the agent records");
        console.log("          here -- distilled claims name internal services and deploy steps.");
      }
      console.log(`episodes  ${episodeDir()}`);
      console.log("          raw and private to you -- never written to a repo");
      console.log("");
      console.log(`the two !memory/ lines in ${join(root!, ".lethe", ".gitignore")} are the whole`);
      console.log("decision, so changing your mind later moves no files. Commit that file:");
      console.log("it is what keeps the memories out of git, on your machine and everyone else's.");

      if (r === "added") console.log("\nwrote that file; lethe never touches your root .gitignore.");
      else if (r === "updated") console.log("\nflipped the !memory/ lines in the existing file.");
      else if (r === "present") console.log("\nalready set that way; left alone.");
      else if (r === "foreign") {
        console.log("\n.lethe/.gitignore exists but has no !memory/ lines, so it is not one");
        console.log("lethe wrote. Left alone -- edit it by hand or delete it and re-run.");
      } else if (r === "failed") console.log("\ncould not write .lethe/.gitignore.");
      console.log(share
        ? "re-run with --private to keep them out of commits."
        : "re-run with --share to commit them.");

      // Older versions appended to the repository root instead.
      const staleRules = staleRootIgnore(root!);
      if (staleRules.length) {
        console.log(`\nyour root .gitignore still has ${staleRules.length} .lethe/ rule(s) from an older`);
        console.log("version. The nested file overrides them, so nothing is broken, but they");
        console.log("are misleading and safe to delete:");
        for (const l of staleRules) console.log(`  ${l.trim()}`);
      }

      // Seeding runs unconditionally, because it needs no model, no network and
      // no permission beyond the decision just made -- so there is nothing to
      // ask about and nothing that can fail. It is also the whole reason `init`
      // is worth running: without it lethe helps on day 30 and not day 1, and an
      // empty store teaches the agent to stop calling recall.
      console.log("");
      reportSeed(store, root!, false);

      console.log("\n`lethe doctor` will tell you if git ends up disagreeing with this.");
      return;
    }

    case "learn": {
      const root = findProjectRoot();
      if (!root) {
        console.log("not a git repository, so there is no repo to learn from.");
        return;
      }
      const dryRun = rest.includes("--dry-run");
      console.log(`repo      ${root}`);
      reportSeed(store, root, dryRun);
      console.log("");
      console.log("re-runnable: each fact has a stable key, so this revises what it wrote");
      console.log("last time instead of writing a second copy beside it.");
      return;
    }

    case "gc": {
      const dryRun = rest.includes("--dry-run");
      const dead = rest.includes("--dead");
      const sw = survey();

      console.log(`${letheHome()}  ${human(sw.totalBytes)}`);
      console.log(`  index     ${human(sw.indexBytes)}`);
      console.log(`  log       ${sw.logBytes ? human(sw.logBytes) : "none"}${logging() ? "" : "  (logging is off)"}`);
      console.log(`  projects  ${sw.live.length} live, ${sw.empty.length} empty, ${sw.orphaned.length} keyed to a missing path`);
      console.log("");

      if (rest.includes("--log")) {
        // Turning logging off leaves the file behind, and a stale log outliving
        // the setting that created it is exactly the kind of thing nobody
        // remembers to remove by hand.
        const removedLog = [LOG_PATH, `${LOG_PATH}.1`].filter((f) => existsSync(f));
        if (!dryRun) for (const f of removedLog) rmSync(f, { force: true });
        console.log(removedLog.length
          ? `${dryRun ? "would delete" : "deleted"} ${removedLog.length} log file(s), ${human(sw.logBytes)}`
          : "no log file to delete");
        console.log("");
      }

      if (rest.includes("--reindex")) {
        // The escape hatch for the one way the index can go wrong: it decides
        // what to reread from mtime and size, so a filesystem with coarse
        // timestamps could in principle hide an edit that kept the same size.
        // Deleting it costs one rebuild and nothing else -- the markdown is the
        // source of truth and the index holds nothing that is not in it.
        const db = join(letheHome(), "index.db");
        if (!dryRun) for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
        console.log(`${dryRun ? "would delete" : "deleted"} the index; it rebuilds on the next recall`);
        console.log("");
      }

      const removed = prune(sw, { dead, dryRun });
      if (removed.length) {
        console.log(`${dryRun ? "would remove" : "removed"} ${removed.length} director(ies):`);
        for (const d of removed) console.log(`  ${d}`);
      } else {
        console.log("nothing to remove.");
      }

      // Never swept automatically, and never without being named first.
      if (sw.orphaned.length && !dead) {
        console.log("");
        console.log(`${sw.orphaned.length} director(ies) hold memories but are keyed to a path that is gone.`);
        console.log("A missing path is as often an unmounted disk or a moved checkout as a");
        console.log("deleted repo, so these are left alone. Add --dead to remove them:");
        for (const o of sw.orphaned) console.log(`  ${o.source}  (${o.files} memory(ies))\n    -> ${o.dir}`);
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
      console.log("");

      // Two paths, both derived, neither configurable. Listing candidates used
      // to read as "a memory could be in any of these", which was never true.
      console.log(`claims    ${claimDir()}`);
      console.log(root
        ? "          consolidated; committed or not, per .lethe/.gitignore"
        : "          no repo, so nowhere to commit them; same place as episodes");
      console.log("");
      console.log(`episodes  ${episodeDir()}`);
      console.log("          raw and private to you; never written to a repo");

      // Nothing writes here any more, but recall still reads it, so silence
      // would make those claims look lost.
      const legacy = legacyClaimDir();
      const orphans = existsSync(legacy)
        ? readdirSync(legacy).filter((f) => f.endsWith(".md")).length
        : 0;
      if (orphans) {
        console.log("");
        console.log(`legacy    ${legacy}`);
        console.log(`          ${orphans} claim(s) from the old cross-project scope, still read`);
        console.log("          but never written to. Move them into a project to be rid of it.");
      }
      return;
    }

    case "ls": {
      const all = store.all();
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
      const m = store.create({ title, body: body.join(" ") });
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
      // A single model call cannot report a fraction, so this is a spinner with
      // an elapsed clock against the distiller's own timeout -- the number worth
      // seeing is how close it is to giving up, not an invented percentage.
      const r = await spinning("consolidating", () => compact(store, {
        ...(resolved ? { distil: resolved.distil } : {}),
        dryRun: rest.includes("--dry-run"),
        deep: rest.includes("--deep"),
      }), resolved ? { deadline: 90 } : {});
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
