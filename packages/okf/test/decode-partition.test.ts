import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { exportBundle, importBundle, loadBundleDir, parseDocument } from '../src/index.js';
import type { BundleFile, Quad } from '../src/index.js';
import { bundle, semantic } from './helpers/okf-v02-fixtures.js';

// Copy every quad the ownership step hands the family readers, as a refactor
// that keeps the RDF values but not the objects might. Which triples a family
// read is then still known: the decoder compares triples by value, so no
// family value comes back a second time as a producer key.
vi.mock('../src/families/ownership.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/families/ownership.js')>();
  const copy = (quads: readonly Quad[]) => quads.map((q) => ({ ...q }));
  return { ...actual, normalizeOwnership: (quads: readonly Quad[]) => copy(actual.normalizeOwnership(quads)) };
});

const frontmatterOf = (files: BundleFile[]) => {
  const file = exportBundle(importBundle(files)).find((f) => f.path === 'metrics/revenue.md')!;
  const { type: _type, ...fm } = parseDocument(file.path, file.content).frontmatter;
  return fm;
};

describe('which triples a family read does not depend on object identity', () => {
  for (const [yaml, expected] of [
    ['generated: [a]', { generated: ['a'] }],
    ['generated: [a]\nGenerated: x', { generated: ['a'], Generated: 'x' }],
    ['usage_window: Q2', { usage_window: 'Q2' }],
    ['sources: nope\nSources: x', { sources: 'nope', Sources: 'x' }],
    ["sources:\n  - { resource: 'https://x.example/s', usage_window: Q2 }", { sources: [{ resource: 'https://x.example/s', usage_window: 'Q2' }] }],
    ['generated: { by: human:a, at: soon }\ndateModified: soon', { generated: { by: 'human:a', at: 'soon' }, dateModified: 'soon' }],
    ['generated: { by: human:a, at: 2026-06-30T00:00:00Z }\ndateModified: urn:producer:x', { generated: { by: 'human:a', at: '2026-06-30T00:00:00Z' }, dateModified: 'urn:producer:x' }],
    ["timestamp: '2026-01-01T00:00:00Z'\ndateModified: true", { timestamp: '2026-01-01T00:00:00Z', dateModified: true }],
  ] as const) {
    it(`exports ${yaml.replaceAll('\n', ' + ')} with each value under its own key`, () => {
      expect(frontmatterOf(bundle(`type: Metric\n${yaml}`))).toEqual(expected);
    });
  }

  it('round-trips the vendored bundles', () => {
    for (const name of ['crypto_bitcoin', 'acme_retail', 'synthetic_links', 'edge_cases']) {
      const first = importBundle(loadBundleDir(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));
      expect(semantic(importBundle(exportBundle(first)).quads), name).toBe(semantic(first.quads));
    }
  });
});
