import { canonicalEntityUri } from '../../hooks/useMemoryEntities.js';

export function dedupeTriplesBySpo<T extends { subject: string; predicate: string; object: string }>(triples: T[]): T[] {
  const seen = new Set<string>();
  return triples.filter(t => {
    // Canonicalise wrapped/bare IRIs so this dedup agrees with
    // `buildEntities`' per-entity `tripleCount` dedup
    // (`useMemoryEntities.ts` builds its SPO key from canonical
    // subject/object). Daemon sometimes ships wrapped `<urn:...>`
    // for the same triple it returns bare elsewhere; without
    // canonicalisation here the detail-page Triples tab would show
    // two rows for what the badge counts as one.
    const key = `${canonicalEntityUri(t.subject)}|${t.predicate}|${canonicalEntityUri(t.object)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
