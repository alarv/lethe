/**
 * What a session in this project starts out knowing.
 *
 * Recall only helps if the model calls it, and measured it did in about a third
 * of sessions. The MCP server's instructions are read at session start by every
 * host, with no hook or setting to install, so the distilled memory goes there
 * rather than behind configuration most people will never add: titles and ids only,
 * because the point is to show the model what exists and that it is worth a
 * recall -- not to spend its context on bodies it may never need.
 *
 * Claims and patterns only. Episodes are raw and unvetted; the briefing is what
 * consolidation has already judged durable.
 */
import type { Memory } from "./store.js";

/**
 * Characters the briefing may use.
 *
 * Kept well inside what a system prompt will tolerate from one server, so the
 * list is a table of contents rather than a second CLAUDE.md.
 */
export const BRIEF_BUDGET = 1500;

export interface Brief {
  /** Memories listed, in order. */
  listed: Memory[];
  /** Live claims and patterns that did not fit. */
  omitted: number;
  text: string;
}

function rank(m: Memory): number {
  // Salience leads; each confirmation (up to three) adds half again, since a
  // confirmed memory is the only kind known to have helped. Strength is capped as rank.ts caps it, so a memory inflated by being
  // returned often does not crowd out the rest.
  return (m.kind === "pattern" ? 1.2 : 1) * m.salience * Math.min(m.strength, 1) *
    (1 + Math.min(m.confirmedBy.length, 3) * 0.5);
}

export function brief(memories: Memory[], budget = BRIEF_BUDGET): Brief {
  const live = memories
    .filter((m) => (m.kind === "claim" || m.kind === "pattern") && !m.supersededBy && !m.fromProject)
    .sort((a, b) => rank(b) - rank(a) || b.updated.localeCompare(a.updated));
  if (!live.length) return { listed: [], omitted: 0, text: "" };

  const head = "What this project's memory already holds (titles only -- recall for the detail):";
  const listed: Memory[] = [];
  let text = head;
  for (const m of live) {
    const line = `\n- [${m.id.slice(0, 8)}] ${m.title}`;
    if (text.length + line.length > budget) break;
    text += line;
    listed.push(m);
  }
  const omitted = live.length - listed.length;
  if (omitted) text += `\n(${omitted} more; recall searches all of them)`;
  return { listed, omitted, text };
}
