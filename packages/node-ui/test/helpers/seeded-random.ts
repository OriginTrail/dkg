// SPDX-License-Identifier: Apache-2.0
/** A small seeded generator for corpus-driven tests: the same seed always draws the same corpus. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rand = () => number;
export const int = (rand: Rand, n: number) => Math.floor(rand() * n);
export const pick = <T>(rand: Rand, xs: readonly T[]): T => xs[int(rand, xs.length)];
export const chance = (rand: Rand, p: number) => rand() < p;

export function shuffled<T>(rand: Rand, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = int(rand, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
