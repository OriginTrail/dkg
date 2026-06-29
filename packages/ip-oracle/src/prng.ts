/**
 * Deterministic PRNG (mulberry32) + helpers. The patent generator must be
 * reproducible: same seed ⇒ identical corpus, with no `Math.random()`.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh, index-scoped stream so each patent is independent yet deterministic. */
export function streamFor(seed: number, index: number): () => number {
  return mulberry32((seed ^ (index * 2654435761)) >>> 0);
}

export function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length) % arr.length];
}

export function intBetween(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}
