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

/** The same tokenisation the naive scorer uses, so both paths agree on a term. */
export function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

/** Null means there is nothing to search for; the caller must skip the index. */
export function matchExpression(query: string): string | null {
  const found = terms(query);
  if (!found.length) return null;
  return found.map((t) => `"${t}"`).join(" OR ");
}
