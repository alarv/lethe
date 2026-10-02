/**
 * Undo a tool call whose later arguments were serialised into the body.
 *
 * Seen in 9 real memories: the model closed `body` with a literal `</body>` and
 * carried on writing `<parameter name="files">[...]`, or `<files>[...]</files>
 * <tags>[...]</tags>`, so the whole tail arrived as body text. The memory was
 * stored with no files and no tags -- which path ranking and consolidation rely
 * on -- and with markup that the evidence gate then read as the episode's
 * content. Only a tail made entirely of such markup is cut; a body that merely
 * mentions `<files>` in prose is left alone.
 */

export interface NoteArgs {
  body: string;
  files: string[];
  tags: string[];
}

const START = /(?:<\/body>|<\/invoke>|<parameter name="\w+">|<(?:files|tags|salience|title)>)/;
const PIECE =
  /^\s*(?:<\/body>|<\/invoke>|<\/parameter>|<parameter name="(\w+)">([\s\S]*?)(?=<\/?parameter|<\/invoke>|$)|<(files|tags|salience|title)>([\s\S]*?)<\/\3>)/;

function list(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function repairLeakedArgs(args: NoteArgs): NoteArgs {
  const at = args.body.search(START);
  if (at < 0) return args;

  let rest = args.body.slice(at);
  const found: Record<string, string[]> = {};
  while (rest.trim()) {
    const m = PIECE.exec(rest);
    if (!m) return args; // something other than markup follows: not a leak
    const name = m[1] ?? m[3];
    const value = m[2] ?? m[4];
    if (name === "files" || name === "tags") found[name] = list(value);
    rest = rest.slice(m[0].length);
  }

  const merge = (a: string[], b: string[] = []) => [...new Set([...a, ...b])];
  return {
    body: args.body.slice(0, at).trimEnd(),
    files: merge(args.files, found.files),
    tags: merge(args.tags, found.tags),
  };
}
