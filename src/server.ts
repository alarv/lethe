/**
 * MCP server.
 *
 * Tool surface per docs/architecture.md § Integration. The pair that matters and
 * that most memory tools lack is confirm/correct: retrieval returns ids, so an
 * agent that finds a memory has gone stale can fix it rather than leaving the
 * store to accumulate confident falsehoods (docs/brain.md §6).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Store, type Memory } from "./store.js";
import { compact, type Distiller } from "./compact.js";
import { log } from "./log.js";

const scopeSchema = z.enum(["local", "team", "personal"]).default("local")
  .describe(
    "local = this repo, private to you (default) | " +
    "team = committed to the repo and shared | " +
    "personal = you, across every repo",
  );

function render(m: Memory): string {
  const age = m.kind === "claim" ? "claim" : m.kind === "pattern" ? "pattern" : "episode";
  return [
    `[${m.id.slice(0, 8)}] (${age}) ${m.title}`,
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
  const store = new Store(cwd);
  const server = new McpServer({ name: "lethe", version: "0.0.1" });

  /** Sampling if the host offers it; otherwise compaction degrades to extractive. */
  function distiller(): Distiller | undefined {
    const caps = server.server.getClientCapabilities();
    if (!caps?.sampling) {
      log("sampling", "host does not support sampling; compaction will be extractive");
      return undefined;
    }
    return async (prompt: string) => {
      const res = await server.server.createMessage({
        messages: [{ role: "user", content: { type: "text", text: prompt } }],
        maxTokens: 400,
      });
      return res.content.type === "text" ? res.content.text : "";
    };
  }

  let compacting = false;
  async function relievePressure(): Promise<string | null> {
    if (compacting) return null;
    const episodes = store.all().filter((m) => m.kind === "episode" && !m.supersededBy);
    if (episodes.length < PRESSURE_THRESHOLD) return null;
    compacting = true;
    try {
      log("compact", "pressure threshold reached", { episodes: episodes.length });
      const r = await compact(store, { distil: distiller() });
      log("compact", r.extractive ? "done (extractive)" : "done (model)", {
        claims: r.claimsWritten,
        consumed: r.episodesConsumed,
        promoted: r.promoted,
        decayed: r.decayed,
      });
      if (!r.claimsWritten) return null;
      return `compacted ${r.episodesConsumed} episodes into ${r.claimsWritten} claim(s)`;
    } catch (err) {
      log("error", `compaction failed: ${err instanceof Error ? err.message : String(err)}`);
      return null; // never fail a user-facing call because maintenance failed
    } finally {
      compacting = false;
    }
  }

  server.tool(
    "lethe_recall",
    "Search memory for anything already known about this task, codebase, or problem. " +
      "Call this BEFORE investigating something that may have been solved before. " +
      "Returns memories with ids -- use lethe_confirm or lethe_correct on them.",
    {
      query: z.string().describe("what you are trying to find out"),
      limit: z.number().int().min(1).max(25).default(8),
    },
    async ({ query, limit }) => {
      const hits = store.search(query, limit);
      for (const m of hits) store.touch(m);
      log("recall", JSON.stringify(query), { hits: hits.length });
      return {
        content: [{
          type: "text",
          text: hits.length
            ? hits.map(render).join("\n\n")
            : "No memories matched. If you learn something durable, record it with lethe_note.",
        }],
      };
    },
  );

  server.tool(
    "lethe_note",
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
      const m = store.create(args);
      log("note", m.title, { id: m.id.slice(0, 8), scope: m.scope });
      const note = await relievePressure();
      return {
        content: [{
          type: "text",
          text: `recorded [${m.id.slice(0, 8)}] ${m.title}${note ? `\n${note}` : ""}`,
        }],
      };
    },
  );

  server.tool(
    "lethe_confirm",
    "This memory was accurate and useful. Strengthens it so it survives decay.",
    { id: z.string() },
    async ({ id }) => {
      const m = store.get(id);
      if (!m) return { content: [{ type: "text", text: `no memory ${id}` }], isError: true };
      store.touch(m, 0.4);
      log("confirm", m.title, { id: m.id.slice(0, 8), strength: m.strength.toFixed(2) });
      return { content: [{ type: "text", text: `confirmed [${m.id.slice(0, 8)}]` }] };
    },
  );

  server.tool(
    "lethe_correct",
    "This memory is now wrong or out of date. Writes a corrected memory and marks the " +
      "old one superseded rather than destroying it, so the history stays auditable.",
    {
      id: z.string(),
      title: z.string(),
      body: z.string().default(""),
    },
    async ({ id, title, body }) => {
      const old = store.get(id);
      if (!old) return { content: [{ type: "text", text: `no memory ${id}` }], isError: true };
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
    "lethe_forget",
    "Delete a memory outright. Use only when it should never have been recorded -- " +
      "for anything merely outdated, prefer lethe_correct.",
    { id: z.string() },
    async ({ id }) => ({
      content: [{ type: "text", text: store.remove(id) ? `forgot ${id}` : `no memory ${id}` }],
    }),
  );

  return server;
}

export async function serve(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  log("start", "mcp server connected", { cwd: process.cwd() });
}
