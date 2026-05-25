import { describe, expect, it } from 'vitest';
import { buildAttributionsQuery } from '../src/ui/hooks/useSwmAttributions.js';

describe('useSwmAttributions — SPARQL query shape', () => {
  // Codex Code5 (PR #656) — the query MUST order DESC + LIMIT 5000.
  // ASC + LIMIT 5000 keeps the oldest 5000 promotions, so once a
  // project crosses 5000 ops the activity feed silently loses every
  // recent promotion. DESC + LIMIT 5000 returns the most recent
  // window — the activity feed is the load-bearing consumer.
  it('orders by ?publishedAt DESC so the newest promotions are kept inside LIMIT 5000', () => {
    const q = buildAttributionsQuery('cg-1');
    expect(q).toContain('ORDER BY DESC(?publishedAt)');
    expect(q).toContain('LIMIT 5000');
    // Guard against accidentally regressing to plain ASC by leaving
    // the new DESC and the old `ORDER BY ?publishedAt` both present.
    expect(q).not.toMatch(/ORDER BY \?publishedAt\s+LIMIT/);
  });
});
