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
