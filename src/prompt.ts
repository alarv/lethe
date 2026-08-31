/**
 * Interactive setup.
 *
 * Separate from cli.ts because that module runs `main()` on import, so nothing
 * in it can be unit tested. The questions `lethe init` asks are worth testing:
 * they are the only place a user is told where their memory goes.
 */

/**
 * The only decision left, named by outcome.
 *
 * Both options write to the same directory -- `<repo>/.lethe/memory/` -- and
 * differ solely in whether git carries the files. That is why there is nothing
 * else to ask: where a memory goes is derived from what it is, so the one
 * remaining question is who gets to read the claims.
 *
 * This used to be four options spanning three scope words, two of which were
 * the same scope differing only by a .gitignore line. Nobody could keep that
 * straight, the author included.
 *
 * "best for a private repo" is in the first option because the audience for
 * committed memory is whoever can clone the repository, which in a public one is
 * everybody. Claims are distilled from sessions and routinely name internal
 * services, deploy steps and the shape of decisions -- none of it secret, all of
 * it context you probably did not mean to publish. lethe cannot check visibility
 * for you: it is a property of the host, not of the checkout, and asking GitHub
 * would mean a network call and a token during setup. So it says so and lets you
 * decide.
 */
export interface Placement {
  label: string;
  detail: string;
  share: boolean;
}

export const PLACEMENTS: Placement[] = [
  {
    label: "committed",
    detail: "anyone who can clone this repo inherits them; best for a private repo",
    share: true,
  },
  {
    label: "git-ignored",
    detail: "you read them in your editor; nobody else ever sees them",
    share: false,
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

