/**
 * Tolerant N-Triples parser for LLM-produced output. Shared by all
 * LlmProvider implementations so triple shapes are byte-identical across
 * providers. Lifted verbatim from the original inline parser in
 * llm-extractor.ts.
 */
export function parseNTriples(
  text: string,
  _documentIri: string,
): Array<{ subject: string; predicate: string; object: string }> {
  const triples: Array<{ subject: string; predicate: string; object: string }> = [];

  const cleaned = text
    .replace(/^```[a-z]*\n?/gm, '')
    .replace(/^```\s*$/gm, '');

  for (const line of cleaned.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(
      /^<([^>]+)>\s+<([^>]+)>\s+(?:<([^>]+)>|("(?:[^"\\]|\\.)*"(?:\^\^<[^>]+>)?(?:@[a-z-]+)?))\s*\.?\s*$/,
    );
    if (match) {
      const subject = match[1]!;
      const predicate = match[2]!;
      const object = match[3] ? match[3] : match[4]!;
      if (subject.length > 0 && predicate.length > 0 && object.length > 0) {
        triples.push({ subject, predicate, object });
      }
    }
  }
  return triples;
}
