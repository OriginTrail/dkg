import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { importBundle, loadBundleDir, validateBundle } from '../src/index.js';

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
    const types = t.quads.filter(
      (q) => q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
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
