/**
 * MCP server.
 *
 * Tool surface per docs/architecture.md § Integration. The pair that matters and
 * that most memory tools lack is confirm/correct: retrieval returns ids, so an
 * agent that finds a memory has gone stale can fix it rather than leaving the
 * store to accumulate confident falsehoods (docs/brain.md §6).
 */

import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Store, author, claimDir, episodeDir, type Memory } from "./store.js";
import { compact, type Distiller } from "./compact.js";
import { repairLeakedArgs } from "./repair.js";
import { type Brief, brief } from "./brief.js";
import { buildStamp, log } from "./log.js";
import { logResolved, resolveDistiller } from "./distil.js";
import { LEARN_INSTRUCTIONS, gate, seed, seeded, writeWatermark } from "./learn.js";

/**
 * Strength added to each memory a recall returns.
 *
 * A fifth of the old 0.1, matching the hook: retrieval says a memory matched,
 * not that it helped. The strong signal is confirm.
 */
const RECALL_REINFORCEMENT = 0.02;

function render(m: Memory): string {
  const from = m.fromProject ? ` — from ${m.fromProject}` : "";
  return [
    `[${m.id.slice(0, 8)}] (${m.kind})${from} ${m.title}`,
    m.body ? m.body.split("\n").map((l) => `    ${l}`).join("\n") : "",
  ].filter(Boolean).join("\n");
}

/**
 * Compaction fires on pressure, not on a clock (docs/compact.md § When it runs).
 * Sleep pressure builds while awake and discharges once it is high enough; here
 * the episodic buffer plays the same role. Running inside a live session is what
 * lets us borrow the host's model, so there is no key and no cron.
 */
/** Both thresholds are overridable, because the right values are unknown. */
function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Sleep pressure, summed over salience rather than counted.
 *
 * A flat count of episodes is one-dimensional: three genuinely important notes
 * never reach it while twelve trivial ones do. docs/brain.md 4 says replay is
 * selective and driven by significance, so significance is what should build
 * pressure. At the default salience of 0.5 this still fires at twelve episodes,
 * so the familiar behaviour is preserved; a store of high-salience findings
 * consolidates sooner, and a store of noise later.
 */
const PRESSURE_THRESHOLD = num(process.env.LETHE_PRESSURE, 6);
/**
 * However little pressure has built, nothing stays raw longer than this.
 *
 * The failure it fixes: a project where a few notes are written each week never
 * reaches any threshold, so it never consolidates at all and recall keeps
 * serving raw sessions. Checked on write rather than on a clock, because an MCP
 * server has no scheduler and the one lifecycle event that would do -- session
 * end -- does not fire for people who leave sessions open for days.
 */
const MAX_RAW_AGE_MS = num(process.env.LETHE_MAX_RAW_HOURS, 24) * 60 * 60 * 1000;

/**
 * Sent at initialize; hosts such as Claude Code place it in the system prompt.
 *
 * Tool descriptions are read when the model is already choosing a tool, which
 * is too late for the decision that matters -- whether to look before digging.
 * This is the one channel every MCP host reads at session start with nothing to
 * install, so it carries the reminder and the briefing (brief.ts) for anyone,
 * including a repo whose AGENTS.md says nothing about lethe.
 */
const INSTRUCTIONS =
  "lethe is this project's memory across sessions. Before investigating anything " +
  "non-trivial -- a failing test or build, an unfamiliar area, a setup problem -- call " +
  "recall first: it may already be solved. Record durable lessons with note. When a " +
  "recalled memory proved right, confirm it; when it is wrong, correct it.";

/** Exactly what a session starting in this store's directory is told. */
export function sessionInstructions(store: Store): { text: string; briefing: Brief } {
  const briefing = brief(store.all());
  return { text: briefing.text ? `${INSTRUCTIONS}\n\n${briefing.text}` : INSTRUCTIONS, briefing };
}

export function createServer(cwd = process.cwd()): McpServer {
  let store = new Store(cwd);
  let root = cwd;
  /** The directory the store resolves paths against. */
  const workspace = () => root;
  // Built from the cwd store: instructions go out in the initialize reply, before
  // the client can be asked for its roots. A host that starts the server outside
  // the project gets the reminder without a briefing, never another project's.
  const { text: instructions, briefing } = sessionInstructions(store);
  if (briefing.listed.length) {
    log("start", "briefed", {
      listed: briefing.listed.length,
      omitted: briefing.omitted,
      ids: briefing.listed.map((m) => m.id.slice(0, 8)).join(","),
    });
  }
  const server = new McpServer({ name: "lethe", version: "0.0.1" }, { instructions });

  /**
   * Bind the store to the workspace the client is actually in.
   *
   * The server's cwd is set by the harness and need not be the project: it has
   * been observed as /private/tmp and as a parent directory of the repo being
   * worked on, which silently splits reads and writes across different stores --
   * memories written in one session are invisible in the next, and ids resolve
   * to nothing. MCP roots is the client telling us where it is, so prefer it.
   */
  let bound = false;
  /** Lazy: client capabilities are only populated after initialize completes. */
  async function ensureBound(): Promise<void> {
    if (bound) return;
    bound = true;
    try {
      const caps = server.server.getClientCapabilities();
      if (!caps?.roots) return;
      const { roots } = await server.server.listRoots();
      const first = roots.find((r) => r.uri.startsWith("file://"));
      if (!first) return;
      const dir = fileURLToPath(first.uri);
      if (dir === cwd) return;
      store = new Store(dir);
      root = dir;
      log("start", "bound to workspace root", { root: dir, store: episodeDir(dir) });
    } catch {
      // Client does not implement roots; the cwd-based store stands.
    }
  }

  /** The host's own model, when it advertises sampling. */
  function hostSampling(): Distiller | undefined {
    const caps = server.server.getClientCapabilities();
    if (!caps?.sampling) return undefined;
    return async (prompt: string) => {
      const res = await server.server.createMessage({
        messages: [{ role: "user", content: { type: "text", text: prompt } }],
        maxTokens: 400,
      });
      return res.content.type === "text" ? res.content.text : "";
    };
  }

  let compacting = false;

  /**
   * Fire-and-forget. Compaction may spawn a CLI and take tens of seconds, and
   * awaiting it here would stall the tool call that triggered it -- exactly the
   * latency path compaction is supposed to stay off. Results go to the log.
   */
  function relievePressure(): void {
    if (compacting) return;
    const episodes = store.all().filter((m) => m.kind === "episode" && !m.supersededBy);
    if (!episodes.length) return;

    const pressure = episodes.reduce((sum, m) => sum + m.salience, 0);
    const oldest = episodes.reduce(
      (min, m) => Math.min(min, Date.parse(m.created) || Infinity),
      Infinity,
    );
    const stale = Number.isFinite(oldest) && Date.now() - oldest > MAX_RAW_AGE_MS;
    if (pressure < PRESSURE_THRESHOLD && !stale) return;
    compacting = true;

    void (async () => {
      try {
        const resolved = await resolveDistiller(hostSampling());
        logResolved(resolved);
        if (!resolved) return; // episodes wait for a session that can distil
        log("compact", stale ? "raw episodes went stale" : "pressure threshold reached", {
          episodes: episodes.length,
          pressure: pressure.toFixed(2),
        });
        const r = await compact(store, { distil: resolved.distil });
        log("compact", "done", {
          via: resolved.via,
          claims: r.claimsWritten,
          consumed: r.episodesConsumed,
          promoted: r.promoted,
          decayed: r.decayed,
        });
      } catch (err) {
        log("error", `compaction failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        compacting = false;
      }
    })();
  }

  server.tool(
    "recall",
    "Retrieve what is already known about this codebase before working. Call this " +
      "FIRST, unprompted, at the start of any task and whenever you hit something " +
      "non-obvious: a failing test or build, an unfamiliar file, a setup or config " +
      "problem, a 'why is it done this way' question, or an error you have not seen " +
      "here before. It is cheap and usually saves rediscovering something already " +
      "solved. Do not wait to be asked. Returns memories with ids -- use confirm or " +
      "correct on them.",
    {
      query: z.string().describe("what you are trying to find out"),
      paths: z.array(z.string()).default([])
        .describe("files or directories you are working in; memories about them rank higher"),
      limit: z.number().int().min(1).max(25).default(8),
    },
    async ({ query, paths, limit }) => {
      await ensureBound();
      const hits = store.recall(query, limit, paths);
      // Borrowed memories belong to another project; reinforcing them here
      // would let one project's usage distort another's decay.
      // Weakly, and the same as the prompt hook. Every returned hit used to get
      // the full 0.1, and strength multiplies rank, so whatever came back once
      // ranked higher and came back again: measured, the top three memories in
      // one project had each been reinforced ~9 times -- once per recall --
      // and one of them was in all 8 real recalls, on any topic. Being returned
      // is not evidence of being useful; confirm is (0.4). accessCount still
      // moves, which frequency-driven consolidation depends on.
      for (const m of hits) if (!m.fromProject) store.touch(m, RECALL_REINFORCEMENT);
      log("recall", JSON.stringify(query), {
        hits: hits.length,
        // Lets a later confirm be matched back to the recall that surfaced it --
        // see harvest.ts, which turns that pairing into a real eval task.
        ...(hits.length ? { ids: hits.map((m) => m.id.slice(0, 8)).join(",") } : {}),
      });
      // The empty branch has always named its next tool, and notes duly get
      // written; the branch that found something named none, and confirm was
      // called zero times in 111 sessions. Close the asymmetry -- the model
      // does what the tool result asks it to do, and nothing was asking.
      const footer = "Once you know whether one of these was right, confirm <id> — " +
        "or correct <id> if it is out of date.";
      return {
        content: [{
          type: "text",
          text: hits.length
            ? `${hits.map(render).join("\n\n")}\n\n${footer}`
            : "No memories matched. If you learn something durable, record it with the note tool.",
        }],
      };
    },
  );

  server.tool(
    "note",
    "Record something that happened: a fix, a gotcha, a decision and its reasoning, a " +
      "dead end worth not repeating. Cheap and fire-and-forget -- write freely, since " +
      "compaction later distils these and discards what did not matter. Do NOT record " +
      "secrets, transient state, or anything trivially re-derivable from the code.",
    {
      title: z.string().describe("one line, specific"),
      body: z.string().default("").describe("what happened, and why it matters next time"),
      tags: z.array(z.string()).default([]),
      files: z.array(z.string()).default([]).describe("relevant paths"),
      salience: z.number().min(0).max(1).default(0.5)
        .describe("how much this deserves to survive. Resolved failures and surprises rank high."),
    },
    async (args) => {
      await ensureBound();
      const m = store.create({ ...args, ...repairLeakedArgs(args) });
      log("note", m.title, { id: m.id.slice(0, 8), kind: m.kind });
      relievePressure();
      return { content: [{ type: "text", text: `recorded [${m.id.slice(0, 8)}] ${m.title}` }] };
    },
  );

  server.tool(
    "learn",
    "Seed this project's memory from what the repository already says about itself -- " +
      "how to install, build, test and run it, what CI does, which services the tests " +
      "expect. Call this with no arguments in a project whose memory is empty, or when " +
      "recall returns nothing: you get instructions, you read the repo with your own " +
      "tools, then you call learn again with the facts. Seeded claims start weak and " +
      "decay unless they prove useful, so it is safe to seed what the repo states -- but " +
      "do NOT summarise the source code, which is re-derivable and crowds out real " +
      "lessons. Facts citing files that do not exist, quoting values not in those files, " +
      "or naming a publish or deploy command are rejected.",
    {
      facts: z.array(z.object({
        key: z.string().describe(
          "short stable slug for the SUBJECT -- install, test, runtime, services, ci. " +
          "The same subject must get the same key every run: that is what revises a " +
          "claim rather than writing a second one beside it.",
        ),
        title: z.string().describe("one line, the rule itself, not a description of the repo"),
        body: z.string().describe("one to four lines; commands, paths and versions exactly as written"),
        files: z.array(z.string()).describe("repo-relative paths this came from"),
        quoted: z.array(z.string()).default([]).describe(
          "strings copied VERBATIM from those files. Each is checked against the file " +
          "and the fact is discarded if absent, so quote what is really there rather " +
          "than a command you inferred.",
        ),
        salience: z.number().min(0).max(1).default(0.6),
      })).default([]).describe("omit on the first call to receive instructions"),
    },
    async ({ facts }) => {
      await ensureBound();

      // Two phases, one tool. Called empty it is a request for instructions;
      // called with facts it is the write. A second tool would let an agent
      // discover the writer without ever seeing the rules it has to satisfy.
      if (!facts.length) {
        const already = seeded(store);
        const preamble = already.length
          ? `This project already has ${already.length} seeded claim(s): ` +
            `${already.map((m) => m.title).join("; ")}.\nRe-seeding revises them in place, ` +
            "so use the same key for the same subject.\n\n"
          : "";
        log("learn", "instructions requested", { seeded: already.length });
        return { content: [{ type: "text", text: preamble + LEARN_INSTRUCTIONS }] };
      }

      const { kept, rejected } = gate(facts, workspace());
      const report = seed(store, kept);
      const wrote = report.written + report.revised;
      if (wrote) {
        writeWatermark(workspace(), { at: new Date().toISOString(), seeded: wrote });
      }
      log("learn", "seeded from the repository", {
        given: facts.length,
        kept: kept.length,
        rejected: rejected.length,
      });

      // Rejections are returned, not swallowed: the agent can fix a bad citation
      // and call again, which it cannot do if the failure is silent.
      const lines = [
        `seeded ${report.written} new, revised ${report.revised}, ` +
        `${report.unchanged} already current.`,
      ];
      if (rejected.length) {
        lines.push("", `rejected ${rejected.length}:`);
        for (const r of rejected) lines.push(`  ${r.fact.title}\n    -> ${r.reason}`);
        lines.push("", "Fix the citation and call learn again with just those facts.");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "confirm",
    "Call this the moment a recalled memory turns out to have been right: you acted on " +
      "it, it saved you a step, or what you found in the code matched it. Pass the id " +
      "from recall. One call, no other arguments, and it is the only thing that tells " +
      "lethe which memories are worth keeping -- without it a memory can only decay, " +
      "however often it proves correct.",
    { id: z.string() },
    async ({ id }) => {
      await ensureBound();
      const m = store.get(id);
      if (!m) {
        return {
          content: [{ type: "text", text: `no memory ${id} — it may have been compacted; recall again for current ids` }],
          isError: true,
        };
      }
      store.touch(m, 0.4);
      log("confirm", m.title, { id: m.id.slice(0, 8), strength: m.strength.toFixed(2) });
      return { content: [{ type: "text", text: `confirmed [${m.id.slice(0, 8)}]` }] };
    },
  );

  server.tool(
    "correct",
    "This memory is now wrong or out of date. Writes a corrected memory and marks the " +
      "old one superseded rather than destroying it, so the history stays auditable.",
    {
      id: z.string(),
      title: z.string(),
      body: z.string().default(""),
    },
    async ({ id, title, body }) => {
      await ensureBound();
      const old = store.get(id);
      if (!old) {
        return {
          content: [{ type: "text", text: `no memory ${id} — it may have been compacted; recall again for current ids` }],
          isError: true,
        };
      }
      const next = store.create({
        title,
        body,
        kind: old.kind,
        tags: old.tags,
        files: old.files,
        salience: Math.max(old.salience, 0.7), // a correction is itself high signal
        provenance: [old.id],
      });
      log("correct", `${old.title} -> ${next.title}`, { old: old.id.slice(0, 8) });
      old.supersededBy = next.id;
      old.updated = new Date().toISOString();
      store.write(old);
      return {
        content: [{
          type: "text",
          text: `[${old.id.slice(0, 8)}] superseded by [${next.id.slice(0, 8)}]`,
        }],
      };
    },
  );

  server.tool(
    "forget",
    "Delete a memory outright. Use only when it should never have been recorded -- " +
      "for anything merely outdated, prefer the correct tool.",
    { id: z.string() },
    async ({ id }) => {
      await ensureBound();
      const removed = store.remove(id);
      // Logged so metrics can see it at all: forget was the one tool call that
      // left no trace, which made "never called" unfalsifiable.
      if (removed) log("forget", id.slice(0, 8), { id: id.slice(0, 8) });
      return ({
      content: [{
        type: "text",
        text: removed ? `forgot ${id}` : `no memory ${id} — recall again for current ids`,
      }],
    });
    },
  );

  return server;
}

export async function serve(): Promise<void> {
  // Refuse to start inside a distiller subprocess. Agent CLIs used for
  // distillation load their own MCP config, so the child would otherwise get
  // lethe's tools and write to the very store being compacted -- observed in
  // practice: a child wrote a memory mid-compaction.
  if (process.env.LETHE_CHILD === "1") {
    log("start", "refusing to start inside a distiller subprocess");
    return;
  }
  const server = createServer();
  await server.connect(new StdioServerTransport());
  log("start", "mcp server connected", {
    cwd: process.cwd(),
    store: claimDir(),
    build: buildStamp(),
  });
}
