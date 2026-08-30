/**
 * Interactive setup.
 *
 * Separate from cli.ts because that module runs `main()` on import, so nothing
 * in it can be unit tested. The questions `lethe init` asks are worth testing:
 * they are the only place a user is told where their memory goes.
 */

import type { Scope } from "./store.js";

/**
 * The four things someone can actually want, named by outcome.
 *
 * Scope alone describes none of them: "in the repo, committed" and "in the
 * repo, git-ignored" are the same scope and differ only in .gitignore. That is
 * precisely the distinction people were losing, so the question is asked in
 * terms of who ends up able to read the files rather than in terms of a word
 * that has to be looked up first.
 */
export interface Placement {
  label: string;
  detail: string;
  scope: Scope;
  share: boolean;
  needsRepo: boolean;
}

export const PLACEMENTS: Placement[] = [
  {
    label: "in this repo, committed",
    detail: "your team inherits them; you review them in diffs",
    scope: "team", share: true, needsRepo: true,
  },
  {
    label: "in this repo, git-ignored",
    detail: "you read them in your editor; nobody else sees them",
    scope: "team", share: false, needsRepo: true,
  },
  {
    label: "outside the repo",
    detail: "in ~/.lethe, keyed to this project; the repo is left alone",
    scope: "local", share: false, needsRepo: false,
  },
  {
    label: "with you, in every project",
    detail: "in ~/.lethe/memory; follows you rather than the code",
    scope: "personal", share: false, needsRepo: false,
  },
];

/**
 * Ask a numbered question and return the chosen index.
 *
 * Streams are injectable so this is testable without a pty. Closing stdin --
 * Ctrl+D, or a pipe running dry -- returns null rather than throwing: setup
 * being cancelled is an ordinary outcome, not a crash.
 */
export async function choose(
  question: string,
  options: { label: string; detail: string }[],
  io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Promise<number | null> {
  const { createInterface } = await import("node:readline/promises");
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const rl = createInterface({ input, output });
  const say = (s = "") => output.write(s + "\n");

  // A question asked after the input has ended never settles -- readline has
  // nothing left to give it and rejects nothing. Racing the close event turns
  // a hung process into a cancelled setup.
  const CLOSED = Symbol("closed");
  const closed = new Promise<typeof CLOSED>((resolve) => rl.once("close", () => resolve(CLOSED)));

  try {
    say(question);
    say();
    const w = Math.max(...options.map((o) => o.label.length));
    options.forEach((o, i) => say(`  ${i + 1}  ${o.label.padEnd(w)}   ${o.detail}`));
    say();
    for (;;) {
      let raw: string | typeof CLOSED;
      try {
        raw = await Promise.race([rl.question(`choose 1-${options.length} [1]: `), closed]);
      } catch {
        return null;
      }
      if (raw === CLOSED) return null;
      const answer = raw.trim() || "1";
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
      say(`not a choice -- enter a number from 1 to ${options.length}.`);
    }
  } finally {
    rl.close();
  }
}

