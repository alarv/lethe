/**
 * What a claim is not allowed to lose.
 *
 * The eval said compaction retrieves worse than the raw episodes it consumed,
 * and the reason was that distillation paraphrases away the exact strings
 * retrieval matches on: a claim reading "start the containers before running
 * the suite" cannot be found by someone searching `docker compose up`. The
 * knowledge survived and the handle on it did not.
 *
 * So consolidation is gated mechanically rather than on judgement. Only
 * literal, matchable strings count as evidence -- commands, paths, environment
 * variables. Whether a claim captured every lesson is a question for a model,
 * and putting a nondeterministic gate in front of a destructive operation is
 * how consolidation starts failing silently.
 */

const KNOWN_EXTENSIONS =
  /\.(ts|js|mjs|cjs|tsx|jsx|json|ya?ml|toml|md|sh|py|go|rs|sql|env|lock|txt|ini|conf)$/i;

/**
 * Is this code span load-bearing, or just a word in backticks?
 *
 * Calibrated against a real run where the gate rejected six correctly-scoped
 * claims. It had demanded `recall` (a tool name), `/body` (a fragment), `src/`
 * (a bare directory) and `strength/kind/path` (prose that happens to contain
 * slashes). None of those is a command anyone would search for, and requiring
 * them made every compression fail.
 *
 * A command has whitespace, or is a filename, or is a flag. A bare identifier
 * is terminology.
 */
function isLoadBearing(span: string): boolean {
  if (span.length < 4) return false;
  if (/\s/.test(span)) return true;              // a command has arguments
  if (KNOWN_EXTENSIONS.test(span)) return true;  // a filename
  if (/^-{1,2}[a-z]/i.test(span)) return true;   // a flag
  if (/^[A-Z][A-Z0-9_]{2,}=/.test(span)) return true; // an assignment
  return false;
}

export function evidence(text: string): string[] {
  const found: string[] = [];

  for (const [, block] of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    const trimmed = block?.trim();
    if (trimmed) found.push(trimmed);
  }
  for (const [, span] of text.matchAll(/`([^`\n]+)`/g)) {
    const trimmed = span?.trim();
    if (trimmed && isLoadBearing(trimmed)) found.push(trimmed);
  }
  for (const [, assignment] of text.matchAll(/\b([A-Z][A-Z0-9_]{2,}=[^\s`,;]+)/g)) {
    if (assignment) found.push(assignment.replace(/[.,;:]+$/, ""));
  }
  for (const word of text.split(/[\s`,;()[\]{}<>"']+/)) {
    // Trailing sentence punctuation is not part of a path.
    const token = word.replace(/[.:!?]+$/, "");
    if (!token || /^https?:\/\//.test(token)) continue;
    // A known extension, not merely a slash. "strength/kind/path" is prose and
    // "src/" is a directory; neither is a string anyone retrieves by.
    if (KNOWN_EXTENSIONS.test(token)) found.push(token);
  }

  return [...new Set(found)];
}

/**
 * Sources the claim consumed while keeping nothing matchable from them.
 *
 * NOT "every string must survive". That rule forbids compression outright: a
 * 2KB episode citing eight files cannot become three lines and retain all
 * eight, so the gate rejected six correctly-scoped claims on a real run for
 * dropping paths they had no business repeating.
 *
 * The failure actually worth blocking is narrower. When five unrelated episodes
 * were fused into one claim about FTS5, four of them contributed nothing to it
 * -- their commands and paths were simply gone, and the knowledge with them.
 * So the rule is per source: consume an episode and you must keep at least one
 * of its retrievable strings. Compression stays possible; silent absorption
 * does not.
 *
 * A source carrying no evidence at all is vacuously satisfied -- there is
 * nothing it could have contributed, and prose-only episodes are legitimate.
 *
 * @returns indices of the sources left unrepresented.
 */
export function unrepresentedSources(sources: string[], claim: string): number[] {
  const out: number[] = [];
  sources.forEach((source, i) => {
    const strings = evidence(source);
    if (!strings.length) return; // nothing to keep, so nothing was lost
    if (!strings.some((e) => claim.includes(e))) out.push(i);
  });
  return out;
}

/** Evidence a specific source carried that the claim did not keep. */
export function droppedFrom(source: string, claim: string): string[] {
  return evidence(source).filter((e) => !claim.includes(e));
}
