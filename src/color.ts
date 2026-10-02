/**
 * Colour for the CLI, and only where someone is looking.
 *
 * Off whenever stdout is not a terminal, so `lethe status | grep`, captured
 * output and the test suite see plain text. NO_COLOR (no-color.org) turns it
 * off and FORCE_COLOR turns it on, as every other tool reads them. Never used
 * by the MCP server, whose stdout is the JSON-RPC stream.
 *
 * Pad before painting: escape codes have length but no width, so a padded
 * coloured string comes out short.
 */

export function colorOn(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env.NO_COLOR) return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== "" && force !== "0" && force !== "false") return true;
  if (process.env.TERM === "dumb") return false;
  return !!stream.isTTY;
}

const wrap = (open: number, close: number) => (s: string): string =>
  colorOn() ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
};

/** A doctor verdict, four columns wide whether or not it is coloured. */
export function badge(state: "ok" | "warn" | "FAIL"): string {
  const word = state.padEnd(4);
  if (state === "ok") return c.green(word);
  if (state === "warn") return c.yellow(word);
  return c.bold(c.red(word));
}

/** The "<- something is wrong" notes metrics prints beside a figure. */
export function note(s: string): string {
  return s.startsWith("<-") ? c.yellow(s) : c.dim(s);
}

/** A section heading: the name bold, the explanation after the dash dimmed. */
export function heading(s: string): string {
  const i = s.indexOf(" — ");
  return i < 0 ? c.bold(s) : `${c.bold(s.slice(0, i))}${c.dim(s.slice(i))}`;
}

const EVENT_COLOURS: Record<string, (s: string) => string> = {
  recall: c.cyan, note: c.green, confirm: c.green, correct: c.yellow, forget: c.yellow,
  learn: c.blue, compact: c.magenta, sampling: c.magenta, error: c.red, start: c.dim, index: c.dim,
};

/** One activity-log line, timestamp dimmed and the event coloured by kind. */
export function logLine(line: string): string {
  if (!colorOn()) return line;
  const m = /^(\S+)(\s+)(\S+)(\s+)(.*)$/.exec(line);
  if (!m) return line;
  const [, ts, gap1, event, gap2, rest] = m as unknown as [string, string, string, string, string, string];
  const paint = EVENT_COLOURS[event] ?? ((s: string) => s);
  const body = event === "error" ? c.red(rest) : rest.replace(/(\s)(\w+=)/g, (_, sp, k) => sp + c.dim(k));
  return `${c.dim(ts)}${gap1}${paint(event)}${gap2}${body}`;
}
