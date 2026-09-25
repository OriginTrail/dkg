// Tolerant N-Triples parser shared by all LlmProvider implementations.
type Triple = { subject: string; predicate: string; object: string };

const TRIPLE_RE = /^<([^>]+)>\s+<([^>]+)>\s+(?:<([^>]+)>|("(?:[^"\\]|\\.)*"(?:\^\^<[^>]+>)?(?:@[a-z-]+)?))\s*\.?\s*$/;

export function parseNTriples(text: string, _documentIri: string): Triple[] {
  const cleaned = text.replace(/^```[a-z]*\n?/gm, '').replace(/^```\s*$/gm, '');
  const triples: Triple[] = [];
  for (const line of cleaned.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(TRIPLE_RE);
    if (m && m[1] && m[2] && (m[3] || m[4])) {
      triples.push({ subject: m[1], predicate: m[2], object: (m[3] ?? m[4])! });
    }
  }
  return triples;
}
