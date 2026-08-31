/**
 * Progress reporting on stderr.
 *
 * One rule dominates the design: **nothing here may write to stdout.** Stdout is
 * the MCP transport, so a single stray byte corrupts the protocol for the whole
 * session; it is also what `lethe status | grep` reads, so writing there would
 * put spinner frames into anyone's pipeline. Stderr is free of both jobs, which
 * is why progress goes there even though it is not an error.
 *
 * Two shapes of work, because the store has two:
 *
 *   - countable work -- 312 commits, 14 claims, a cold index rebuild -- gets a
 *     determinate bar, because the fraction is knowable and therefore honest.
 *   - a single model call gets a spinner and elapsed seconds. A percentage there
 *     would be invented, and the number the user actually wants is how close it
 *     is to giving up, so `deadline` renders `41s / 90s` instead.
 *
 * Animation is suppressed outside a TTY and under CI, where `\r` produces a
 * megabyte of redraws in a build log rather than a moving bar. In that mode each
 * label still prints once, so a non-interactive run says what it is doing
 * without pretending to animate.
 */

/** Braille reads better but is not safe everywhere; see `unicode()`. */
const FRAMES_UNICODE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAMES_ASCII = ["-", "\\", "|", "/"];
const FILL_UNICODE = ["█", "░"];
const FILL_ASCII = ["#", "-"];

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
/** Carriage return, then clear to end of line -- redraw without leaving tails. */
const CLEAR = "\r\x1b[K";

const FRAME_MS = 90;

/**
 * Windows terminals and a C locale render braille and block glyphs as boxes,
 * which is worse than plain ASCII. Detected from the locale rather than assumed,
 * since a UTF-8 locale is the honest signal that the terminal can draw this.
 */
function unicode(): boolean {
  if (process.platform === "win32") return false;
  const locale = process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? "";
  return /UTF-?8/i.test(locale);
}

/**
 * Whether to animate.
 *
 * LETHE_PROGRESS is an explicit override in both directions: `0` for anyone
 * scripting against the output, `1` to see a bar in a captured run while
 * debugging. Everything else follows the terminal.
 */
export function animated(stream: NodeJS.WriteStream = process.stderr): boolean {
  if (process.env.LETHE_PROGRESS === "0") return false;
  if (process.env.LETHE_PROGRESS === "1") return true;
  if (process.env.CI) return false;
  return !!stream.isTTY;
}

export interface Task {
  /** Change what the work is called. Restarts the elapsed clock for a phase. */
  label(text: string): void;
  /** Declare or raise the denominator, switching to a determinate bar. */
  total(n: number): void;
  /** Advance the numerator. */
  step(by?: number): void;
  /** Finish, optionally leaving one summary line behind. */
  done(summary?: string): void;
  /** Finish having failed, always leaving the reason behind. */
  fail(reason: string): void;
}

export interface TaskOptions {
  /** Total if it is known up front. */
  total?: number;
  /** Seconds after which the work gives up, rendered beside the elapsed time. */
  deadline?: number;
  /** Injectable so this is testable without a pty. */
  stream?: NodeJS.WriteStream;
}

/**
 * Restoring the cursor is not optional.
 *
 * Hiding it is a terminal-wide side effect: a crash or a Ctrl+C mid-bar leaves
 * the user with an invisible cursor in their shell until they run `reset`. The
 * `exit` handler covers throws and normal exits; `exit` does NOT fire on a
 * signal, so SIGINT is handled separately and re-raised so Ctrl+C still means
 * Ctrl+C. Registered lazily, so importing this module adds no listeners -- the
 * MCP server imports the CLI's dependencies and must not accumulate handlers.
 */
let guarded = false;
const live = new Set<() => void>();

function guard(): void {
  if (guarded) return;
  guarded = true;
  const restore = () => {
    for (const erase of [...live]) erase();
    live.clear();
  };
  process.on("exit", restore);
  process.once("SIGINT", () => {
    restore();
    // The listener was `once`, so it is already removed and re-raising gets
    // node's default handling -- the right exit code, not a swallowed Ctrl+C.
    process.kill(process.pid, "SIGINT");
  });
}

/**
 * Start reporting a piece of work.
 *
 * Always returns a Task, animated or not, so callers never branch on whether
 * there is a terminal. `done()` is idempotent: calling it in a `finally` after
 * an early `fail()` is the expected shape, not a bug.
 */
export function task(name: string, opts: TaskOptions = {}): Task {
  const stream = opts.stream ?? process.stderr;
  const on = animated(stream);
  const frames = unicode() ? FRAMES_UNICODE : FRAMES_ASCII;
  const [full, empty] = unicode() ? FILL_UNICODE : FILL_ASCII;

  let label = name;
  let total = opts.total ?? 0;
  let at = 0;
  let frame = 0;
  let started = Date.now();
  let finished = false;
  let timer: NodeJS.Timeout | null = null;

  const write = (s: string) => {
    try {
      stream.write(s);
    } catch {
      // A closed or full stderr must never take down the work being reported.
    }
  };

  const bar = (): string => {
    const width = Math.max(8, Math.min(24, (stream.columns ?? 80) - label.length - 22));
    const filled = total > 0 ? Math.round((Math.min(at, total) / total) * width) : 0;
    return full!.repeat(filled) + empty!.repeat(width - filled);
  };

  const elapsed = (): string => {
    const s = Math.round((Date.now() - started) / 1000);
    return opts.deadline ? `${s}s / ${opts.deadline}s` : `${s}s`;
  };

  const render = () => {
    if (finished) return;
    const body = total > 0 ? `${bar()}  ${Math.min(at, total)}/${total}` : `${frames[frame]}  ${elapsed()}`;
    write(`${CLEAR}${label}  ${body}`);
  };

  const erase = () => write(`${CLEAR}${SHOW}`);

  if (on) {
    guard();
    live.add(erase);
    write(HIDE);
    render();
    timer = setInterval(() => {
      frame = (frame + 1) % frames.length;
      render();
    }, FRAME_MS);
    // Never let a task nobody finished hold the process open.
    timer.unref();
  } else {
    write(`${label}...\n`);
  }

  const stop = () => {
    finished = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (on) {
      erase();
      live.delete(erase);
    }
  };

  return {
    label(text) {
      if (finished || text === label) return;
      label = text;
      started = Date.now();
      at = 0;
      total = 0;
      if (on) render();
      else write(`${label}...\n`);
    },
    total(n) {
      total = Math.max(total, n);
      if (on) render();
    },
    step(by = 1) {
      at += by;
      if (on) render();
    },
    done(summary) {
      if (finished) return;
      stop();
      if (summary) write(`${summary}\n`);
    },
    fail(reason) {
      if (finished) return;
      stop();
      write(`${reason}\n`);
    },
  };
}

/**
 * Report a promise that cannot be broken into steps -- a model call, a fetch.
 *
 * Exists so the common case is one line at the call site and the `finally` can
 * never be forgotten, which is how a hidden cursor escapes into a shell.
 */
export async function spinning<T>(
  name: string,
  work: () => Promise<T>,
  opts: TaskOptions = {},
): Promise<T> {
  const t = task(name, opts);
  try {
    return await work();
  } finally {
    t.done();
  }
}
