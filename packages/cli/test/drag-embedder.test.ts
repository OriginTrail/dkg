import { describe, it, expect } from 'vitest';
import { HashingEmbeddingProvider } from '../src/vector-store.js';

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

describe('HashingEmbeddingProvider (offline lexical embedder / contrast baseline)', () => {
  const e = new HashingEmbeddingProvider();

  it('produces a fixed-width, L2-normalized vector', async () => {
    const v = await e.embed('supplier compliance audit');
    expect(v.length).toBe(e.dimensions);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('is deterministic (same text → same vector)', async () => {
    const a = await e.embed('did not meet incoming-inspection thresholds');
    const b = await e.embed('did not meet incoming-inspection thresholds');
    expect(a).toEqual(b);
  });

  it('ranks token-overlapping text above unrelated text (lexical, not semantic)', async () => {
    const q = await e.embed('which suppliers failed the compliance audit');
    const overlap = await e.embed('the compliance audit flagged several suppliers');
    const unrelated = await e.embed('the weather in Tokyo is sunny today');
    expect(cosine(q, overlap)).toBeGreaterThan(cosine(q, unrelated));
  });

  it('honestly MISSES pure synonyms (the gap a real semantic model closes)', async () => {
    // No shared tokens → near-zero similarity, even though the meaning matches.
    const q = await e.embed('flagged in the audit');
    const paraphrase = await e.embed('did not meet inspection thresholds');
    expect(cosine(q, paraphrase)).toBeLessThan(0.2);
  });

  it('an empty string yields a zero vector (no NaNs)', async () => {
    const v = await e.embed('');
    expect(v.every((x) => x === 0)).toBe(true);
  });
});
