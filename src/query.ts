/**
 * Turning a question into something FTS5 will accept.
 *
 * MATCH takes a query language, not a string, and recall is called with natural
 * language. Passing a query through unmodified throws on a colon, a hyphen, a
 * plus, an unbalanced quote, or a bare OR -- so `why is docker: failing?`
 * crashes recall, which is not an acceptable way for a memory tool to answer an
 * ordinary question.
 *
 * Every term is stripped to alphanumerics before being quoted, so no input can
 * escape its own quoting and turn into operator syntax.
 */

/**
 * Words too common to be evidence of anything.
 *
 * Not used for ranking -- BM25's IDF already discounts a ubiquitous term, and
 * hand-written lists are a bad way to tune relevance. This list exists for
 * ADMISSION, which is a different question: whether a match is worth spending
 * context on at all. Ranking can afford to be wrong about a near-zero match;
 * a hook that fires on every prompt cannot.
 *
 * Shared with compact.ts, which needs the same judgement when clustering.
 */
export const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "was", "were", "not", "but", "you",
  "from", "have", "has", "had", "are", "its", "it's", "then", "than", "when",
  "what", "why", "how", "who", "where", "which", "can", "does", "did", "would",
  "should", "could", "will", "all", "any", "some", "there", "here", "about",
  "into", "over", "just", "also", "been", "being", "them", "they", "our", "out",
  "get", "got", "one", "two", "now", "new", "use", "used", "using", "make",
  "made", "need", "needs", "like", "want", "know", "see", "say", "says",
]);

/** The same tokenisation the naive scorer uses, so both paths agree on a term. */
export function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

/**
 * Suffix stripping, so "test" and "tests" collide. Not a real stemmer.
 *
 * Strips known suffixes rather than truncating to a prefix. A prefix cut turned
 * "thanks" into "than", which matches inside "than", "thanking", and any word
 * that happens to start that way -- enough to make "thanks that worked" look
 * like a relevant question.
 *
 * Shared with compact.ts, which needs the same collisions when clustering.
 */
export function stem(t: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (t.length > suffix.length + 2 && t.endsWith(suffix)) return t.slice(0, -suffix.length);
  }
  return t;
}

/**
 * Terms carrying enough signal to justify injecting a memory into context.
 *
 * Deliberately NOT used to build the MATCH expression: removing terms there
 * would change ranking, and the eval measured the current behaviour.
 */
export function contentTerms(query: string): string[] {
  return terms(query).filter((t) => !STOP.has(t));
}

/** Null means there is nothing to search for; the caller must skip the index. */
export function matchExpression(query: string): string | null {
  const found = terms(query);
  if (!found.length) return null;
  return found.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Distinct query terms a memory must contain to be injected.
 *
 * The reason this exists: the query is an OR of every term, so a single common
 * word is a hit. "what is the airspeed velocity of an unladen swallow" matched a
 * memory about embeddings, on the word "the". BM25 ranks such a match near zero
 * but ranking is not rejection, and nothing else here rejects. On a hook that
 * fires every turn, a near-zero match still costs real context.
 *
 * Coverage rather than a score threshold because absolute BM25 values are
 * corpus-dependent, so any constant would be wrong on somebody else's store.
 *
 * Counted over content terms only. A first attempt counted every term and let
 * the swallow query through anyway, on "what" plus "the" -- two stopwords are
 * two terms, and coverage that counts them measures nothing.
 */
const MIN_TERM_COVERAGE = 2;
/**
 * A term this rare in the store is evidence on its own.
 *
 * Requiring two terms unconditionally rejected "what did we decide about
 * embeddings": only "decide" and "embeddings" survive stopword removal, and the
 * memory says "Decision" rather than "decide". But "embeddings" appears in a
 * handful of memories out of dozens, so matching it is not a coincidence the way
 * matching "worked" would be.
 *
 * Expressed as a fraction of the store rather than a count, so it self-tunes
 * instead of encoding a guess about how big anyone's memory is. This is IDF used
 * for admission rather than for ranking.
 */
const RARE_TERM_FRACTION = 0.25;
/**
 * How many distinct query terms this memory actually contains.
 *
 * Substring matching is right here even though it is wrong for ranking: the
 * question is whether the term is present at all, and the porter stemmer means
 * "running" in the query should count against "run" in the body.
 */
export function termCoverage(text: string, queryTerms: string[]): number {
  const haystack = text.toLowerCase();
  let hit = 0;
  for (const t of new Set(queryTerms.map(stem))) {
    if (haystack.includes(t)) hit += 1;
  }
  return hit;
}

/**
 * How many memories in the store contain each term.
 *
 * Computed over the corpus rather than looked up in the index, because the hook
 * does not own the index connection and the bodies have already been read off
 * disk by the search that produced the candidates.
 */
export function documentFrequency(
  corpus: { title: string; body: string }[],
  queryTerms: string[],
): Map<string, number> {
  const df = new Map<string, number>();
  for (const t of new Set(queryTerms.map(stem))) {
    let n = 0;
    for (const m of corpus) if (`${m.title} ${m.body}`.toLowerCase().includes(t)) n += 1;
    df.set(t, n);
  }
  return df;
}

/** Memories that share enough of the question to be worth the context. */
export function relevantEnough<T extends { title: string; body: string }>(
  found: T[],
  queryTerms: string[],
  corpus: { title: string; body: string }[] = [],
): T[] {
  return admit(found, queryTerms, {
    total: corpus.length,
    df: corpus.length ? documentFrequency(corpus, queryTerms) : new Map<string, number>(),
  });
}

/**
 * Term frequencies over whatever the caller searched.
 *
 * `df` is keyed by stem(term). The hook counts by reading the corpus it already
 * has; recall asks the index, because reading every memory on every recall is
 * the O(n) cost the index exists to avoid.
 */
export interface Frequencies {
  total: number;
  df: Map<string, number>;
}

/** relevantEnough, with the frequencies supplied rather than computed. */
export function admit<T extends { title: string; body: string }>(
  found: T[],
  queryTerms: string[],
  { total, df }: Frequencies,
): T[] {
  const needed = Math.min(MIN_TERM_COVERAGE, queryTerms.length);
  const rareCutoff = total * RARE_TERM_FRACTION;

  return found.filter((m) => {
    const text = `${m.title} ${m.body}`.toLowerCase();
    let covered = 0;
    let rareHit = false;
    for (const t of new Set(queryTerms.map(stem))) {
      if (!text.includes(t)) continue;
      covered += 1;
      const seen = df.get(t);
      if (seen !== undefined && seen > 0 && seen <= rareCutoff) rareHit = true;
    }
    return covered >= needed || (covered >= 1 && rareHit);
  });
}
