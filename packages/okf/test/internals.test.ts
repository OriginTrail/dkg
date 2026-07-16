import { describe, it, expect } from 'vitest';
import {
  isSafeIri,
  literalTerm,
  typedLiteralTerm,
  frontmatterQuads,
  quadsToNQuads,
  exportBundle,
  importBundle,
  validateBundle,
  resolveLinkTarget,
} from '../src/index.js';

describe('term helpers', () => {
  it('isSafeIri requires a scheme and rejects unsafe chars', () => {
    expect(isSafeIri('https://x/y')).toBe(true);
    expect(isSafeIri('urn:okf:a/b')).toBe(true);
    expect(isSafeIri('not an iri')).toBe(false);
    expect(isSafeIri('')).toBe(false);
    expect(isSafeIri('http://x/<bad>')).toBe(false);
  });
  it('escapes literals and types typed literals', () => {
    expect(literalTerm('he said "hi"')).toBe('"he said \\"hi\\""');
    expect(typedLiteralTerm('3', 'http://www.w3.org/2001/XMLSchema#integer')).toBe(
      '"3"^^<http://www.w3.org/2001/XMLSchema#integer>',
    );
  });
});

describe('valueToTerms typing for producer-defined keys', () => {
  const q = frontmatterQuads('urn:okf:x', {
    type: 'T',
    flag: true,
    count: 7,
    ratio: 1.5,
    note: 'plain',
    homepage: 'https://example.org/p',
    nested: { a: 1 },
    list: ['a', 'b'],
  });
  const obj = (predicate: string) => q.filter((x) => x.predicate === predicate).map((x) => x.object);

  it('types boolean/integer/decimal and preserves IRIs vs literals', () => {
    expect(obj('http://schema.org/flag')).toEqual(['"true"^^<http://www.w3.org/2001/XMLSchema#boolean>']);
    expect(obj('http://schema.org/count')).toEqual(['"7"^^<http://www.w3.org/2001/XMLSchema#integer>']);
    expect(obj('http://schema.org/ratio')).toEqual(['"1.5"^^<http://www.w3.org/2001/XMLSchema#decimal>']);
    expect(obj('http://schema.org/note')).toEqual(['"plain"']);
    expect(obj('http://schema.org/homepage')).toEqual(['https://example.org/p']);
    expect(obj('http://schema.org/list')).toEqual(['"a"', '"b"']);
    expect(obj('http://schema.org/nested')).toEqual(['"{\\"a\\":1}"']);
  });

  it('skips null/undefined values', () => {
    const q2 = frontmatterQuads('urn:okf:x', { type: 'T', empty: null, gone: undefined });
    expect(q2.some((x) => x.predicate.includes('empty') || x.predicate.includes('gone'))).toBe(false);
  });
});

describe('quadsToNQuads', () => {
  it('returns empty string for no quads and dedupes identical lines', () => {
    expect(quadsToNQuads([])).toBe('');
    const dup = [
      { subject: 'urn:a', predicate: 'urn:p', object: 'urn:b' },
      { subject: 'urn:a', predicate: 'urn:p', object: 'urn:b' },
    ];
    expect(quadsToNQuads(dup)).toBe('<urn:a> <urn:p> <urn:b> .\n');
  });
  it('renders a named graph term', () => {
    expect(
      quadsToNQuads([{ subject: 'urn:a', predicate: 'urn:p', object: '"v"', graph: 'urn:g' }]),
    ).toBe('<urn:a> <urn:p> "v" <urn:g> .\n');
  });
});

describe('export of producer keys (array + index regeneration)', () => {
  it('round-trips a multi-valued producer key and nested subdirectories', () => {
    const files = [
      { path: 'index.md', content: '# Root\n' },
      { path: 'a/one.md', content: '---\ntype: T\ntitle: One\nauthors:\n- X\n- Y\n---\n[two](/a/two.md)\n' },
      { path: 'a/two.md', content: '---\ntype: T\ntitle: Two\n---\nbody\n' },
    ];
    const imported = importBundle(files);
    const exported = exportBundle(imported);
    // a regenerated index.md exists for both root and the `a/` subdir
    expect(exported.some((f) => f.path === 'index.md')).toBe(true);
    expect(exported.some((f) => f.path === 'a/index.md')).toBe(true);
    const re = importBundle(exported);
    const one = re.concepts.find((c) => c.conceptId === 'a/one')!;
    expect(one.quads.filter((x) => x.predicate === 'http://schema.org/authors').map((x) => x.object)).toEqual(
      ['"X"', '"Y"'],
    );
    expect(validateBundle(exported).conformant).toBe(true);
  });
});

describe('validation reserved-file structure (§6/§7)', () => {
  it('warns when a non-root reserved file carries frontmatter', () => {
    const report = validateBundle([
      { path: 'tables/index.md', content: '---\nfoo: bar\n---\n# listing' },
      { path: 'a.md', content: '---\ntype: T\n---\nbody' },
    ]);
    expect(report.conformant).toBe(true);
    expect(report.warnings.join(' ')).toMatch(/carries frontmatter/);
  });
  it('warns when root index.md declares keys other than okf_version', () => {
    const report = validateBundle([
      { path: 'index.md', content: '---\nokf_version: "0.1"\ntitle: nope\n---\n# root' },
      { path: 'a.md', content: '---\ntype: T\n---\nbody' },
    ]);
    expect(report.warnings.join(' ')).toMatch(/other than okf_version/);
  });
  it('reports an unparseable concept frontmatter as a hard error (§9 rule 1)', () => {
    const report = validateBundle([{ path: 'a.md', content: '---\ntype: T\nno close' }]);
    expect(report.conformant).toBe(false);
    expect(report.errors.join(' ')).toMatch(/rule 1/);
  });

  it('warns (never errors) when a reserved file fails to parse', () => {
    const report = validateBundle([
      { path: 'index.md', content: '---\nunterminated frontmatter' },
      { path: 'a.md', content: '---\ntype: T\n---\nbody' },
    ]);
    expect(report.conformant).toBe(true);
    expect(report.warnings.join(' ')).toMatch(/did not parse/);
  });
});

describe('robustness', () => {
  it('skips an unparseable concept with a parse warning, never aborting the bundle', () => {
    const r = importBundle([
      { path: 'good.md', content: '---\ntype: T\ntitle: Good\n---\nbody' },
      { path: 'bad.md', content: '---\ntype: T\nno close here' },
    ]);
    expect(r.concepts.map((c) => c.conceptId)).toEqual(['good']);
    expect(r.warnings.some((w) => w.code === 'parse' && w.conceptId === 'bad')).toBe(true);
  });

  it('rejects a link whose resolved segment is not a valid concept-ID segment', () => {
    expect(resolveLinkTarget('/-bad.md', 'a')).toBeNull();
    expect(resolveLinkTarget('/.hidden.md', 'a')).toBeNull();
  });
});
