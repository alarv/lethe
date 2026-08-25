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
import { Store, memoryDir, type Memory, type Scope } from "./store.js";
import { defaultScope } from "./config.js";
import { compact, type Distiller } from "./compact.js";
import { buildStamp, log } from "./log.js";
import { logResolved, resolveDistiller } from "./distil.js";

/**
 * Left optional rather than defaulted, so the configured scope applies. A zod
 * default is fixed when the tool is registered, which would override config.
 */
const scopeSchema = z.enum(["local", "team", "personal"]).optional()
  .describe(
    "omit to use the configured default | " +
    "where consolidated claims from this memory should eventually live. " +
    "Episodes are always private to you regardless. " +
    "team = shared via the repo (default) | local = this machine | personal = you, everywhere",
  );

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
const PRESSURE_THRESHOLD = 12;

export function createServer(cwd = process.cwd()): McpServer {
  let store = new Store(cwd);
  let root = cwd;
  /** The directory config and scope resolve against. */
  const workspace = () => root;
  const server = new McpServer({ name: "lethe", version: "0.0.1" });

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
      log("start", "bound to workspace root", { root: dir, store: memoryDir("local", dir) });
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
    if (episodes.length < PRESSURE_THRESHOLD) return;
    compacting = true;

    void (async () => {
      try {
        const resolved = await resolveDistiller(hostSampling());
        logResolved(resolved);
        if (!resolved) return; // episodes wait for a session that can distil
        log("compact", "pressure threshold reached", { episodes: episodes.length });
        const r = await compact(store, {
          distil: resolved.distil,
          claimScope: defaultScope(workspace()),
        });
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
    "Search memory for anything already known about this task, codebase, or problem. " +
      "Call this BEFORE investigating something that may have been solved before. " +
      "Returns memories with ids -- use the confirm or correct tools on them.",
    {
      query: z.string().describe("what you are trying to find out"),
      paths: z.array(z.string()).default([])
        .describe("files or directories you are working in; memories about them rank higher"),
      limit: z.number().int().min(1).max(25).default(8),
    },
    async ({ query, paths, limit }) => {
      await ensureBound();
      const hits = store.search(query, limit, paths);
      // Borrowed memories belong to another project; reinforcing them here
      // would let one project's usage distort another's decay.
      for (const m of hits) if (!m.fromProject) store.touch(m);
      log("recall", JSON.stringify(query), { hits: hits.length });
      return {
        content: [{
          type: "text",
          text: hits.length
            ? hits.map(render).join("\n\n")
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
      scope: scopeSchema,
      tags: z.array(z.string()).default([]),
      files: z.array(z.string()).default([]).describe("relevant paths"),
      salience: z.number().min(0).max(1).default(0.5)
        .describe("how much this deserves to survive. Resolved failures and surprises rank high."),
    },
    async (args) => {
      await ensureBound();
      const m = store.create({ ...args, scope: args.scope ?? defaultScope(workspace()) });
      log("note", m.title, { id: m.id.slice(0, 8), scope: m.scope });
      relievePressure();
      return { content: [{ type: "text", text: `recorded [${m.id.slice(0, 8)}] ${m.title}` }] };
    },
  );

  server.tool(
    "confirm",
    "This memory was accurate and useful. Strengthens it so it survives decay.",
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
        scope: old.scope,
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
      return ({
      content: [{
        type: "text",
        text: store.remove(id) ? `forgot ${id}` : `no memory ${id} — recall again for current ids`,
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
    store: memoryDir("local"),
    build: buildStamp(),
  });
}
