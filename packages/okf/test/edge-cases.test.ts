import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  exportBundle,
  importBundle,
  loadBundleDir,
  parseDocument,
  quadsToNQuads,
  validateBundle,
  DKG_HAS_SECTION,
  GENID_TAGS,
  OKF_STATUS,
  OKF_VERIFICATION,
  PROV_WAS_DERIVED_FROM,
  RDF_JSON,
} from '../src/index.js';
import type { BundleFile, Quad } from '../src/index.js';
import { objs, IDX_V02, bundle } from './helpers/okf-v02-fixtures.js';
const links = loadBundleDir(fileURLToPath(new URL('./fixtures/synthetic_links', import.meta.url)));
const edge = loadBundleDir(fileURLToPath(new URL('./fixtures/edge_cases', import.meta.url)));

describe('synthetic link-forms bundle (exercises forms crypto_bitcoin lacks)', () => {
  const r = importBundle(links);
  const edgesOf = (id: string) =>
    [...new Set(r.concepts.find((c) => c.conceptId === id)!.resolvedLinks.map((l) => l.targetConceptId))].sort();

  it('resolves absolute, relative, parent-relative, bare-sibling and extension-less links', () => {
    expect(edgesOf('hub')).toEqual(['beta', 'tables/alpha', 'tables/gamma']);
    expect(edgesOf('tables/alpha')).toEqual(['beta', 'hub']); // ../hub.md and /beta.md
    expect(edgesOf('beta')).toEqual(['hub', 'tables/alpha']);
  });

  it('records a broken cross-link as a warning, never an error', () => {
    const hub = r.concepts.find((c) => c.conceptId === 'hub')!;
    expect(hub.brokenLinks.map((l) => l.raw)).toContain('tables/does_not_exist.md');
    expect(r.warnings.some((w) => w.code === 'broken-link')).toBe(true);
  });
});

describe('edge-case bundle (type-only, unknown keys, broken link, log.md)', () => {
  const r = importBundle(edge);

  it('reads okf_version from the root index.md', () => {
    expect(r.okfVersion).toBe('0.1');
  });

  it('maps a type-only concept with just rdf:type (graceful degradation)', () => {
    const t = r.concepts.find((c) => c.conceptId === 'type_only')!;
    // On the concept itself: its stored body is a typed node of its own.
    const types = t.quads.filter(
      (q) => q.subject === t.iri && q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
    );
    expect(types).toHaveLength(1);
    expect(t.quads.some((q) => q.predicate === 'http://schema.org/name')).toBe(false);
  });

  it('preserves producer-defined keys and never drops them', () => {
    const x = r.concepts.find((c) => c.conceptId === 'extras')!;
    expect(x.quads.some((q) => q.predicate === 'http://schema.org/owner' && q.object === '"Alice"')).toBe(true);
    expect(
      x.quads.some(
        (q) =>
          q.predicate === 'http://schema.org/priority' &&
          q.object === '"3"^^<http://www.w3.org/2001/XMLSchema#integer>',
      ),
    ).toBe(true);
  });

  it('does not mint log.md or index.md as Knowledge Assets', () => {
    expect(r.reservedSkipped.sort()).toEqual(['index.md', 'log.md']);
    expect(r.concepts.map((c) => c.conceptId).sort()).toEqual(['extras', 'type_only']);
  });

  it('warns on the broken link but stays conformant', () => {
    expect(r.warnings.some((w) => w.code === 'broken-link')).toBe(true);
    expect(validateBundle(edge).conformant).toBe(true);
  });
});

describe('§9 conformance validation', () => {
  it('accepts the crypto_bitcoin bundle', () => {
    const cb = loadBundleDir(fileURLToPath(new URL('./fixtures/crypto_bitcoin', import.meta.url)));
    expect(validateBundle(cb).conformant).toBe(true);
  });

  it('flags a concept missing a non-empty type as non-conformant (§9 rule 2)', () => {
    const report = validateBundle([
      { path: 'bad.md', content: '---\ntitle: No type here\n---\nbody' },
    ]);
    expect(report.conformant).toBe(false);
    expect(report.errors.join(' ')).toMatch(/non-empty `type`/);
  });

  it('does NOT reject for broken links, unknown keys, or missing index.md (§9)', () => {
    const report = validateBundle([
      { path: 'a.md', content: '---\ntype: T\nweird_key: v\n---\n[broken](missing.md)' },
    ]);
    expect(report.conformant).toBe(true);
  });

  it('rejects concept paths with invalid segments (would mint a malformed subject IRI)', () => {
    const files = [
      { path: 'index.md', content: '# Root\n' },
      { path: 'bad name.md', content: '---\ntype: T\ntitle: Spacey\n---\nbody' }, // space in segment
      { path: '-bad.md', content: '---\ntype: T\ntitle: Dashy\n---\nbody' }, // leading dash
      { path: 'ok/good.md', content: '---\ntype: T\ntitle: Good\n---\nbody' }, // valid
    ];
    // validateBundle hard-errors the invalid paths…
    const report = validateBundle(files);
    expect(report.conformant).toBe(false);
    expect(report.errors.join('\n')).toMatch(/bad name: invalid concept path/);
    expect(report.errors.join('\n')).toMatch(/-bad: invalid concept path/);

    // …and importBundle skips them with an `invalid-path` warning, never minting a
    // malformed IRI; the valid concept still imports.
    const r = importBundle(files);
    expect(r.warnings.filter((w) => w.code === 'invalid-path').map((w) => w.conceptId).sort()).toEqual(['-bad', 'bad name']);
    expect(r.concepts.map((c) => c.conceptId)).toContain('ok/good');
    expect(r.concepts.some((c) => c.conceptId === 'bad name' || c.conceptId === '-bad')).toBe(false);
    // no emitted subject IRI contains a space (the malformed-IRI symptom)
    expect(r.quads.every((q) => !q.subject.includes(' '))).toBe(true);
  });
});

describe('concept IDs are arbitrary file paths', () => {
  it('imports `__proto__.md` and `constructor.md` as ordinary, linked concepts', () => {
    const r = importBundle([
      IDX_V02(),
      { path: '__proto__.md', content: '---\ntype: Thing\ntitle: P\n---\n\nSee [c](constructor.md).\n' },
      { path: 'constructor.md', content: '---\ntype: Thing\ntitle: C\n---\n\nSee [p](__proto__.md).\n' },
    ]);
    expect(r.concepts.map((c) => [c.conceptId, c.iri])).toEqual([
      ['__proto__', 'urn:okf:__proto__'],
      ['constructor', 'urn:okf:constructor'],
    ]);
    expect(Object.keys(r.iriByConceptId).sort()).toEqual(['__proto__', 'constructor']);
    expect(r.concepts.map((c) => c.resolvedLinks.map((l) => l.targetConceptId))).toEqual([['constructor'], ['__proto__']]);
    expect(r.quads.every((q) => typeof q.subject === 'string')).toBe(true);
    expect(exportBundle(r).map((f) => f.path)).toEqual(['__proto__.md', 'constructor.md', 'index.md']);
  });
});

describe('a malformed value never aborts the bundle', () => {
  // A YAML mapping can carry its own `toString` key; String() of it throws.
  const SIBLING: BundleFile = { path: 'sibling.md', content: '---\ntype: Thing\ntitle: Healthy\n---\n\nbody\n' };
  const withSibling = (fm: string) => [...bundle(fm), SIBLING];
  const strip = (quads: Quad[]) => quadsToNQuads(quads.filter((q) => !q.subject.includes(GENID_TAGS.section) && q.predicate !== DKG_HAS_SECTION));

  it('a verifier given as a mapping names no verifier, warns, and leaves sibling concepts importing', () => {
    const files = withSibling('type: Metric\nverified: { by: { toString: human:alice } }');
    const r = importBundle(files);
    expect(r.concepts.map((c) => c.conceptId).sort()).toEqual(['metrics/revenue', 'policies/revenue-recognition', 'sibling']);
    const c = r.concepts.find((x) => x.conceptId === 'metrics/revenue')!;
    expect(objs(c.quads, OKF_VERIFICATION)).toEqual([]);
    expect(c.trust).toMatchObject({ tier: 'unverified', verifications: 0 });
    expect(r.warnings.map((w) => w.message)).toContain('`verified[0].by` should be a single value, not a mapping or list (§5.2); the entry is skipped');
    expect(validateBundle(files).warnings.join('\n')).toMatch(/verified\[0\]\.by` should be a single value/);
  });

  it('keeps any other family field given a mapping or list verbatim, with a warning, through export', () => {
    const fm = [
      'type: Attested Computation',
      'status: { toString: x }',
      'stale_after: [2026-12-31T00:00:00Z]',
      'runtime: [bigquery]',
      'computation: { file: x.sql }',
      'generated: { by: { toString: g }, at: 2026-06-30T14:00:00Z }',
      'sources:',
      '  - { id: [a], resource: { href: https://x.example/s }, title: { toString: t }, author: { toString: a }, usage_count: [1, 2] }',
      'parameters:',
      '  - { name: [year], required: [true] }',
      'executor: { resource: { toString: r }, receipt: [job_id, { k: 1 }] }',
    ].join('\n');
    const files = withSibling(fm);
    const r = importBundle(files);
    const messages = r.warnings.map((w) => w.message);
    for (const label of ['status', 'stale_after', 'runtime', 'computation', 'generated.by', 'sources[0].id', 'sources[0].resource', 'sources[0].title', 'sources[0].author', 'sources[0].usage_count', 'parameters[0].name', 'parameters[0].required', 'executor.resource']) {
      expect(messages.some((m) => m.startsWith(`\`${label}\` should be a single value`)), `warning for ${label}`).toBe(true);
    }
    expect(messages).toContain('`executor.receipt[1]` should be a single value, not a mapping or list (§10.2); kept verbatim');
    const c = r.concepts.find((x) => x.conceptId === 'metrics/revenue')!;
    expect(objs(c.quads, OKF_STATUS)).toEqual([`"{\\"toString\\":\\"x\\"}"^^<${RDF_JSON}>`]);
    expect(objs(c.quads, PROV_WAS_DERIVED_FROM)).toEqual([]); // a mapping is not a resource IRI
    expect(c.trust.generatedBy).toBeNull();
    const exported = exportBundle(r);
    const back = parseDocument('metrics/revenue.md', exported.find((f) => f.path === 'metrics/revenue.md')!.content).frontmatter;
    expect(Object.getOwnPropertyDescriptor(back.status, 'toString')?.value).toBe('x');
    expect(back.runtime).toEqual(['bigquery']);
    expect((back.executor as Record<string, unknown>).receipt).toEqual(['job_id', { k: 1 }]);
    expect(strip(importBundle(exported).quads)).toBe(strip(r.quads));
  });

  it('never throws on a malformed base field or type', () => {
    const files = [IDX_V02(), { path: 'a.md', content: '---\ntype: Metric\ntitle: { toString: x }\ntags: [{ toString: t }]\nresource: { toString: r }\n---\n\nbody\n' }, { path: 'b.md', content: '---\ntype: { toString: x }\n---\n\nbody\n' }, SIBLING];
    const r = importBundle(files);
    expect(r.concepts.map((c) => c.conceptId)).toEqual(['a', 'b', 'sibling']);
    expect(validateBundle(files).conformant).toBe(true);
  });

  it('skips only the concept whose value no RDF term can hold (a cyclic alias)', () => {
    const files = [IDX_V02(), { path: 'a.md', content: '---\ntype: Metric\nowner: &x\n  self: *x\n---\n\nbody\n' }, SIBLING];
    const r = importBundle(files);
    expect(r.concepts.map((c) => c.conceptId)).toEqual(['sibling']);
    expect(r.warnings.find((w) => w.conceptId === 'a')).toMatchObject({ code: 'unmappable-value' });
    expect(r.warnings.find((w) => w.conceptId === 'a')!.message).toMatch(/^could not be mapped \(.*circular.*\); skipped$/);
  });
});

describe('a skipped concept is not a link target', () => {
  // The surviving concept names the skipped one through a source path and a
  // body link; neither may become an edge, whichever file sorts first.
  const CYCLIC = '---\ntype: Metric\nowner: &x\n  self: *x\n---\n\nbody\n';
  const naming = (id: string) => `---\ntype: Metric\nsources:\n  - { id: s, resource: /${id}.md }\n---\n\nSee [it](/${id}.md).\n`;

  for (const [survivor, skipped] of [['a', 'z'], ['z', 'a']]) {
    it(`drops ${skipped}.md from the index so ${survivor}.md reports both references unresolved`, () => {
      const r = importBundle([IDX_V02(), { path: `${survivor}.md`, content: naming(skipped) }, { path: `${skipped}.md`, content: CYCLIC }]);
      expect(r.concepts.map((c) => c.conceptId)).toEqual([survivor]);
      expect(Object.keys(r.iriByConceptId)).toEqual([survivor]);
      const target = `urn:okf:${skipped}`;
      expect(r.quads.filter((q) => q.object === target)).toEqual([]);
      expect(r.concepts[0].trust.derivedFromConcepts).toEqual([]);
      expect(r.warnings.map((w) => `${w.conceptId}|${w.code}|${w.message}`)).toEqual(
        [
          `${skipped}|unmappable-value|could not be mapped (value cannot be written as JSON: Converting circular structure to JSON); skipped`,
          `${survivor}|broken-link|sources[0].resource "/${skipped}.md" does not resolve to a concept in the bundle (not an error, SPEC §6.1/§11)`,
          `${survivor}|broken-link|unresolved cross-link "/${skipped}.md" (not in bundle — not an error, SPEC §6.1/§11)`,
        ].sort((x, y) => (x.split('|')[0] < y.split('|')[0] ? -1 : x.split('|')[0] > y.split('|')[0] ? 1 : 0)),
      );
    });
  }
});
