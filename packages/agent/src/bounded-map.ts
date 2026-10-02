// Bounded insertion-ordered memory shared by agent subsystems (the Context
// Graph name resolver's peer bookkeeping, the name-reveal verdict cache).
// Neutral so neither owns the other's helpers.

/** Insert as newest, evicting the oldest entries so at most `bound` remain. */
export function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V, bound: number): void {
  map.delete(key);
  while (map.size >= bound) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  map.set(key, value);
}
