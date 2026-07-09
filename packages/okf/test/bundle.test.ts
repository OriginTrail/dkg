import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { importBundle, exportBundle, loadBundleDir, quadsToNQuads } from '../src/index.js';
import type { BundleImport } from '../src/index.js';

const fixtureDir = fileURLToPath(new URL('./fixtures/crypto_bitcoin', import.meta.url));
const files = loadBundleDir(fixtureDir);

/** Outgoing untyped edges (schema:mentions) for a concept, as target concept IDs. */
function edges(r: BundleImport, conceptId: string): string[] {
  const c = r.concepts.find((x) => x.conceptId === conceptId);
  if (!c) throw new Error(`no concept ${conceptId}`);
  return [...new Set(c.resolvedLinks.map((l) => l.targetConceptId!))].sort();
}

describe('crypto_bitcoin golden import (§4.1)', () => {
  const r = importBundle(files);

  it('mints exactly 5 Knowledge Assets, zero for the 3 reserved index.md', () => {
    expect(r.concepts.map((c) => c.conceptId).sort()).toEqual([
      'datasets/crypto_bitcoin',
      'tables/blocks',
      'tables/inputs',
      'tables/outputs',
      'tables/transactions',
    ]);
    expect(r.reservedSkipped.sort()).toEqual(['datasets/index.md', 'index.md', 'tables/index.md']);
  });

  it('derives IRIs deterministically from concept IDs', () => {
    expect(r.iriByConceptId).toMatchObject({
      'datasets/crypto_bitcoin': 'urn:okf:datasets/crypto_bitcoin',
      'tables/blocks': 'urn:okf:tables/blocks',
      'tables/transactions': 'urn:okf:tables/transactions',
      'tables/inputs': 'urn:okf:tables/inputs',
      'tables/outputs': 'urn:okf:tables/outputs',
    });
  });

  it('emits the expected frontmatter triples per concept', () => {
    const ds = r.concepts.find((c) => c.conceptId === 'datasets/crypto_bitcoin')!;
    const has = (predicate: string, object: string) =>
      ds.quads.some((q) => q.predicate === predicate && q.object === object);
    expect(has('http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://schema.org/BigQueryDataset')).toBe(true);
    expect(has('http://schema.org/name', '"Cryptocurrency Bitcoin"')).toBe(true);
    expect(
      has(
        'http://schema.org/url',
        'https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/crypto_bitcoin',
      ),
    ).toBe(true);
    expect(
      ds.quads.some(
        (q) =>
          q.predicate === 'http://schema.org/dateModified' &&
          q.object === '"2026-05-28T22:44:47+00:00"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
      ),
    ).toBe(true);
    // tables/blocks is BigQuery Table
    const blocks = r.concepts.find((c) => c.conceptId === 'tables/blocks')!;
    expect(
      blocks.quads.some(
        (q) =>
          q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
          q.object === 'http://schema.org/BigQueryTable',
      ),
    ).toBe(true);
  });

  it('reconstructs the untyped relationship graph from prose links', () => {
    expect(edges(r, 'datasets/crypto_bitcoin')).toEqual([
      'tables/blocks',
      'tables/inputs',
      'tables/outputs',
      'tables/transactions',
    ]);
    expect(edges(r, 'tables/transactions')).toEqual([
      'datasets/crypto_bitcoin',
      'tables/blocks',
      'tables/inputs',
      'tables/outputs',
    ]);
    expect(edges(r, 'tables/inputs')).toEqual([
      'datasets/crypto_bitcoin',
      'tables/outputs',
      'tables/transactions',
    ]);
    // blocks: no concept edges (external citations only)
    expect(edges(r, 'tables/blocks')).toEqual([]);
  });

  it('documents the in-code-span edge case: outputs has NO concept edges by default', () => {
    expect(edges(r, 'tables/outputs')).toEqual([]);
    const outputs = r.concepts.find((c) => c.conceptId === 'tables/outputs')!;
    expect(outputs.codeSpanLinks.map((l) => l.raw)).toEqual(['transactions.md', 'inputs.md']);
  });

  it('captures both citation styles as citation triples, not concept edges', () => {
    const blocks = r.concepts.find((c) => c.conceptId === 'tables/blocks')!;
    // bare-bullet style
    expect(blocks.citations.map((c) => c.url)).toEqual([
      'https://github.com/blockchain-etl/bitcoin-etl',
    ]);
    const ds = r.concepts.find((c) => c.conceptId === 'datasets/crypto_bitcoin')!;
    // numbered style
    expect(ds.citations.map((c) => c.url)).toContain(
      'https://cloud.google.com/blog/products/gcp/bitcoin-in-bigquery-blockchain-analytics-on-public-data',
    );
    expect(
      ds.quads.some(
        (q) =>
          q.predicate === 'http://schema.org/citation' &&
          // exact URL (not a host-prefix startsWith — that trips CodeQL's incomplete
          // URL-sanitization rule and is a weaker check anyway).
          q.object === 'https://bigquery.googleapis.com/v2/projects/bigquery-public-data/datasets/crypto_bitcoin',
      ),
    ).toBe(true);
  });

  it('produces byte-identical N-Quads across two runs (determinism)', () => {
    const a = quadsToNQuads(importBundle(files).quads);
    const b = quadsToNQuads(importBundle(files).quads);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('opting into code-span links adds the two outputs edges', () => {
    const withCode = importBundle(files, { includeCodeSpanLinks: true });
    expect(edges(withCode, 'tables/outputs')).toEqual(['tables/inputs', 'tables/transactions']);
  });
});

describe('opt-in type-pair edge relations (deterministic, no LLM)', () => {
  const HAS_PART = 'http://schema.org/hasPart';
  const MENTIONS = 'http://schema.org/mentions';
  // Dataset→Table is containment; Table→Table stays an untyped reference.
  const rules = [{ from: 'BigQuery Dataset', to: 'BigQuery Table', predicate: HAS_PART }];

  const objectsByPredicate = (r: BundleImport, conceptId: string, predicate: string) =>
    r.concepts
      .find((c) => c.conceptId === conceptId)!
      .quads.filter((q) => q.predicate === predicate)
      .map((q) => q.object)
      .sort();

  it('default (no rules) keeps every edge as schema:mentions', () => {
    const r = importBundle(files);
    expect(objectsByPredicate(r, 'datasets/crypto_bitcoin', HAS_PART)).toEqual([]);
    expect(objectsByPredicate(r, 'datasets/crypto_bitcoin', MENTIONS).length).toBeGreaterThan(0);
  });

  it('dataset→table becomes hasPart; table→table stays mentions', () => {
    const r = importBundle(files, { typeRelations: rules });
    // The dataset's links to its 4 tables are now containment edges...
    expect(objectsByPredicate(r, 'datasets/crypto_bitcoin', HAS_PART).length).toBe(4);
    expect(objectsByPredicate(r, 'datasets/crypto_bitcoin', MENTIONS)).toEqual([]);
    // ...while transactions→(other tables) remain untyped references.
    expect(objectsByPredicate(r, 'tables/transactions', HAS_PART)).toEqual([]);
    expect(objectsByPredicate(r, 'tables/transactions', MENTIONS).length).toBeGreaterThan(0);
  });

  it('a rule that matches no endpoint pair leaves all edges as mentions', () => {
    const r = importBundle(files, {
      typeRelations: [{ from: 'Nonexistent', to: 'AlsoMissing', predicate: HAS_PART }],
    });
    expect(objectsByPredicate(r, 'datasets/crypto_bitcoin', HAS_PART)).toEqual([]);
    expect(objectsByPredicate(r, 'datasets/crypto_bitcoin', MENTIONS).length).toBeGreaterThan(0);
  });

  it('is byte-stable with rules applied', () => {
    const a = quadsToNQuads(importBundle(files, { typeRelations: rules }).quads);
    const b = quadsToNQuads(importBundle(files, { typeRelations: rules }).quads);
    expect(a).toBe(b);
  });

  it('hasPart edges round-trip through export as plain (untyped) OKF links', () => {
    // OKF can't express the relation type, so export emits a link and a plain
    // re-import (no rules) reads it back as mentions — consistent with SPEC §5.3.
    const first = importBundle(files, { typeRelations: rules });
    const second = importBundle(exportBundle(first));
    expect(edges(second, 'datasets/crypto_bitcoin').length).toBe(4);
  });
});
