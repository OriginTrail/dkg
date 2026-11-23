/**
 * C8: schema.org type colours for the memory layer graph.
 *
 * The six most common types in view get data slots 1–6, busiest first.
 * Every other type, and the catch-all schema:Thing, is neutral grey.
 * Slots 4–6 have lookalike pairs (olive/gold/brown), so the graph legend
 * and hover naming each node's type matter.
 */
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA = ['http://schema.org/', 'https://schema.org/'];
const THING = new Set(['http://schema.org/Thing', 'https://schema.org/Thing']);
export const SCHEMA_COLOURED_TYPES = 6;

export function schemaTypeColors(
  triples: ReadonlyArray<{ subject: string; predicate: string; object: string }>,
  slotHex: (slot: number) => string,
  neutral: string,
): Record<string, string> {
  const counts = new Map<string, Set<string>>();
  for (const t of triples) {
    if (t.predicate !== RDF_TYPE) continue;
    const type = t.object.replace(/^<|>$/g, '');
    if (!SCHEMA.some(ns => type.startsWith(ns))) continue;
    let s = counts.get(type);
    if (!s) { s = new Set(); counts.set(type, s); }
    s.add(t.subject);
  }
  const ranked = [...counts.entries()]
    .filter(([type]) => !THING.has(type))
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    .map(([type]) => type);
  const out: Record<string, string> = {};
  for (const type of counts.keys()) out[type] = neutral;
  ranked.slice(0, SCHEMA_COLOURED_TYPES).forEach((type, i) => { out[type] = slotHex(i + 1); });
  return out;
}
