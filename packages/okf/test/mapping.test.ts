import { describe, it, expect } from 'vitest';
import {
  frontmatterQuads,
  parseBody,
  mapConcept,
  parseDocument,
  DKG_HAS_SECTION,
  SCHEMA_NAME,
  SECTION_GENID_INFIX,
} from '../src/index.js';

const Q = (quads: { predicate: string; object: string }[], predicate: string) =>
  quads.filter((q) => q.predicate === predicate).map((q) => q.object);

describe('frontmatterQuads (locked OKF → RDF table, ADR 0005)', () => {
  const iri = 'urn:okf:datasets/crypto_bitcoin';
  const fm = {
    type: 'BigQuery Dataset',
    resource: 'https://bigquery.googleapis.com/v2/projects/x/datasets/crypto_bitcoin',
    title: 'Cryptocurrency Bitcoin',
    description: 'A dataset.',
    tags: ['cryptocurrency', 'bitcoin'],
    timestamp: '2026-05-28T22:44:47+00:00',
  };
  const quads = frontmatterQuads(iri, fm);

  it('maps type → rdf:type with PascalCased schema.org IRI', () => {
    expect(Q(quads, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type')).toEqual([
      'http://schema.org/BigQueryDataset',
    ]);
  });
  it('maps title → schema:name and description → schema:description', () => {
    expect(Q(quads, 'http://schema.org/name')).toEqual(['"Cryptocurrency Bitcoin"']);
    expect(Q(quads, 'http://schema.org/description')).toEqual(['"A dataset."']);
  });
  it('maps each tag → one schema:keywords literal', () => {
    expect(Q(quads, 'http://schema.org/keywords')).toEqual(['"cryptocurrency"', '"bitcoin"']);
  });
  it('maps timestamp → schema:dateModified typed xsd:dateTime', () => {
    expect(Q(quads, 'http://schema.org/dateModified')).toEqual([
      '"2026-05-28T22:44:47+00:00"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
    ]);
  });
  it('maps resource → schema:url as an IRI object', () => {
    expect(Q(quads, 'http://schema.org/url')).toEqual([
      'https://bigquery.googleapis.com/v2/projects/x/datasets/crypto_bitcoin',
    ]);
  });
  it('preserves producer-defined keys as camelCased schema.org predicates', () => {
    const extra = frontmatterQuads(iri, { type: 'X', owner: 'Alice', 'review status': 'pending' });
    expect(Q(extra, 'http://schema.org/owner')).toEqual(['"Alice"']);
    expect(Q(extra, 'http://schema.org/reviewStatus')).toEqual(['"pending"']);
  });
  it('accepts a full-IRI type unchanged', () => {
    const t = frontmatterQuads(iri, { type: 'https://example.org/Custom' });
    expect(Q(t, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type')).toEqual([
      'https://example.org/Custom',
    ]);
  });
});

describe('parseBody (real Markdown AST)', () => {
  it('detects headings, body links, code-span links and citations separately', () => {
    const body = [
      'Prose with a [real link](other.md) and an inline `[code link](coder.md)`.',
      '',
      '# Schema',
      '',
      '# Citations',
      '[1] [Source](https://example.org/s)',
      '- https://example.org/bare',
    ].join('\n');
    const parsed = parseBody(body);
    expect(parsed.headings).toEqual(['Schema', 'Citations']);
    expect(parsed.bodyLinks).toEqual(['other.md']);
    expect(parsed.codeSpanHrefs).toEqual(['coder.md']);
    expect(parsed.citations.map((c) => c.url)).toEqual([
      'https://example.org/s',
      'https://example.org/bare',
    ]);
  });
});

describe('mapConcept section nodes are skolemized IRIs, never blank nodes', () => {
  // The daemon rejects blank-node RDF objects, so `dkg:hasSection` must point at
  // an absolute IRI. Sections are skolemized into deterministic concept-scoped
  // `.well-known/genid/` IRIs (matching the node's own scheme).
  const doc = parseDocument(
    'datasets/crypto_bitcoin.md',
    '---\ntype: T\ntitle: O\n---\n\n# Schema\n\nbody\n\n# Citations\n\n[1] [x](https://e.org/x)\n',
  );
  const iri = 'urn:okf:datasets/crypto_bitcoin';
  const m = mapConcept(doc, iri, () => false);

  it('emits no blank-node terms anywhere in the quads', () => {
    for (const q of m.quads) {
      expect(q.subject.startsWith('_:')).toBe(false);
      expect(q.object.startsWith('_:')).toBe(false);
    }
  });

  it('hasSection objects are deterministic concept-scoped genid IRIs', () => {
    const sections = m.quads.filter((q) => q.predicate === DKG_HAS_SECTION);
    expect(sections.map((q) => q.object)).toEqual([
      `${iri}${SECTION_GENID_INFIX}okfsec_datasets_crypto_bitcoin_0`,
      `${iri}${SECTION_GENID_INFIX}okfsec_datasets_crypto_bitcoin_1`,
    ]);
    // each section node carries its heading text via schema:name
    for (const s of sections) {
      const name = m.quads.find((q) => q.subject === s.object && q.predicate === SCHEMA_NAME);
      expect(name).toBeDefined();
    }
  });

  it('is stable across runs (same bundle ⇒ same section IRIs)', () => {
    const again = mapConcept(doc, iri, () => false);
    expect(again.quads).toEqual(m.quads);
  });
});

describe('mapConcept code-span policy', () => {
  const doc = parseDocument(
    'tables/outputs.md',
    '---\ntype: T\ntitle: O\n---\n\nLinked with `[transactions](transactions.md)` and `[inputs](inputs.md)`.\n',
  );
  const exists = (id: string) => ['tables/transactions', 'tables/inputs'].includes(id);

  it('does NOT treat code-span links as edges by default (CommonMark)', () => {
    const m = mapConcept(doc, 'urn:okf:tables/outputs', exists);
    expect(m.resolvedLinks).toEqual([]);
    expect(m.codeSpanLinks.map((l) => l.raw)).toEqual(['transactions.md', 'inputs.md']);
  });
  it('treats them as edges when includeCodeSpanLinks is set', () => {
    const m = mapConcept(doc, 'urn:okf:tables/outputs', exists, { includeCodeSpanLinks: true });
    expect(m.resolvedLinks.map((l) => l.targetConceptId).sort()).toEqual([
      'tables/inputs',
      'tables/transactions',
    ]);
  });
});

describe('mapConcept section-name truncation (OT-RFC-56 §4.6)', () => {
  // A markdown-parse quirk can surface a huge string as a "heading" — the
  // producer shape behind the 2026-07-08 mainnet 177KB schema:name poison.
  // Section names are truncated to a display bound so the import SUCCEEDS
  // with a sane name instead of minting an oversized RDF literal (or, post
  // #1323, failing the whole import at the guarded route).
  const hugeHeading = 'H'.repeat(180_000);
  const doc = parseDocument(
    'briefs/world_cup.md',
    `---\ntype: T\ntitle: O\n---\n\n# ${hugeHeading}\n\nbody\n`,
  );
  const m = mapConcept(doc, 'urn:okf:briefs/world_cup', () => false);

  it('truncates oversized section names to the display bound (never an oversized literal)', () => {
    const sectionNames = m.quads.filter(
      (q) => q.subject.includes('okfsec_') && q.predicate.includes('schema.org/name'),
    );
    expect(sectionNames.length).toBeGreaterThan(0);
    for (const q of sectionNames) {
      expect(q.object.length).toBeLessThanOrEqual(2_048 + 4); // bound + quotes + ellipsis
      expect(q.object.endsWith('…"')).toBe(true);
    }
  });

  it('leaves normal headings untouched', () => {
    const normal = parseDocument('a/b.md', '---\ntype: T\ntitle: O\n---\n\n# Short heading\n\nbody\n');
    const mm = mapConcept(normal, 'urn:okf:a/b', () => false);
    const names = mm.quads.filter((q) => q.subject.includes('okfsec_') && q.predicate.includes('schema.org/name'));
    expect(names.some((q) => q.object === '"Short heading"')).toBe(true);
  });
});
