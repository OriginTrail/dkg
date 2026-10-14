import { describe, it, expect } from 'vitest';
import { exportBundle, importBundle, SCHEMA_DATE_MODIFIED, SCHEMA_NS } from '../src/index.js';
import { generatedAtOf, lastModifiedOf, timestampIsProducerKey, timestampQuads } from '../src/families/generated.js';
import { bundle, exportedFrontmatter, objs, DT, semantic } from './helpers/okf-v02-fixtures.js';

// `generated.at` and the v0.1 `timestamp` share `schema:dateModified` (§13.1):
// export has to give each value back to the key it came from.
const roundTrip = (yaml: string) => {
  const files = bundle(`type: Metric\n${yaml}`);
  const first = importBundle(files);
  const second = importBundle(exportBundle(first));
  return { files, first, second };
};
const messages = (r: ReturnType<typeof importBundle>) => r.warnings.map((w) => w.message);

describe('a last-modified time and a legacy timestamp both survive a round trip', () => {
  // `generated.at` supersedes the v0.1 `timestamp` (§13.1), which is then kept
  // as a producer key: export must write both back, so neither date replaces
  // the other, while a concept with only a last-modified time keeps the
  // legacy `timestamp` key.
  for (const [name, at, timestamp] of [
    ['a quoted timestamp', '2026-06-30T00:00:00Z', "'2026-01-01T00:00:00Z'"],
    ['an unquoted timestamp', '2026-06-30T00:00:00Z', '2026-01-01T00:00:00Z'],
    ['an invalid generated.at', 'soon', "'2026-01-01T00:00:00Z'"],
  ]) {
    it(`keeps generated.at and the timestamp beside it, with ${name}`, () => {
      const { files, first, second } = roundTrip(`generated: { at: ${at} }\ntimestamp: ${timestamp}`);
      expect(semantic(second.quads)).toBe(semantic(first.quads));
      expect(messages(second)).toEqual(messages(first));
      const fm = exportedFrontmatter(files);
      expect(Object.keys(fm.generated as object)).toEqual(['at']);
      expect('timestamp' in fm).toBe(true);
    });
  }

  it('still writes a lone last-modified time as the legacy timestamp', () => {
    for (const yaml of ["timestamp: '2026-05-28T22:44:47+00:00'", 'generated: { at: 2026-06-30T00:00:00Z }']) {
      const { files, first, second } = roundTrip(yaml);
      expect(semantic(second.quads)).toBe(semantic(first.quads));
      const fm = exportedFrontmatter(files);
      expect('generated' in fm).toBe(false);
      expect('timestamp' in fm).toBe(true);
    }
  });

  it('reads a blank generated.at as missing, so the timestamp beside it is the last-modified time', () => {
    const { first, second } = roundTrip("generated: { at: '' }\ntimestamp: '2026-01-01T00:00:00Z'");
    const c = first.concepts.find((x) => x.conceptId === 'metrics/revenue')!;
    expect(objs(c.quads, SCHEMA_DATE_MODIFIED)).toEqual([DT('2026-01-01T00:00:00Z')]);
    expect(c.trust.generatedAt).toBe('2026-01-01T00:00:00Z');
    expect(semantic(second.quads)).toBe(semantic(first.quads));
  });
});

describe('a structured generated.at stays inside generated through a round trip', () => {
  // A mapping or list where `generated.at` expects one time is kept verbatim as
  // rdf:JSON. It is no time the legacy `timestamp` could carry, so export
  // writes it back inside `generated`, and a timestamp beside it as itself.
  const STRUCTURED = ['[2026-06-30T00:00:00Z]', '{ when: 2026-06-30T00:00:00Z }'];
  for (const at of STRUCTURED) {
    for (const timestamp of [null, "'2026-01-01T00:00:00Z'"]) {
      it(`keeps at: ${at}${timestamp ? ' and the timestamp beside it' : ''}`, () => {
        const yaml = `generated: { at: ${at} }${timestamp ? `\ntimestamp: ${timestamp}` : ''}`;
        const { files, first, second } = roundTrip(yaml);
        expect(semantic(second.quads)).toBe(semantic(first.quads));
        expect(messages(second)).toEqual(messages(first));
        const fm = exportedFrontmatter(files);
        expect(typeof (fm.generated as Record<string, unknown>).at).toBe('object');
        expect('timestamp' in fm).toBe(timestamp !== null);
      });
    }
  }

  it('keeps both values when generated also names its actor', () => {
    const { files, first, second } = roundTrip("generated: { by: human:a, at: [2026-06-30T00:00:00Z] }\ntimestamp: '2026-01-01T00:00:00Z'");
    const c = first.concepts.find((x) => x.conceptId === 'metrics/revenue')!;
    expect(objs(c.quads, SCHEMA_DATE_MODIFIED)).toHaveLength(2);
    expect(semantic(second.quads)).toBe(semantic(first.quads));
    const fm = exportedFrontmatter(files);
    expect(fm.generated).toMatchObject({ by: 'human:a', at: ['2026-06-30T00:00:00Z'] });
    expect(fm.timestamp).toBe('2026-01-01T00:00:00Z');
    expect(objs(second.concepts.find((x) => x.conceptId === 'metrics/revenue')!.quads, SCHEMA_DATE_MODIFIED)).toContain(DT('2026-01-01T00:00:00Z'));
  });
});

describe('one codec owns the generated / timestamp rule', () => {
  it('decides precedence once, for the mapper, the summary and the producer-key check', () => {
    const iri = 'urn:okf:x';
    const cases: Array<{ fm: Record<string, unknown>; supersedes: boolean; lastModified: string }> = [
      { fm: { generated: { at: '2026-06-30T00:00:00Z' }, timestamp: '2026-01-01T00:00:00Z' }, supersedes: true, lastModified: '2026-06-30T00:00:00Z' },
      { fm: { timestamp: '2026-01-01T00:00:00Z' }, supersedes: false, lastModified: '2026-01-01T00:00:00Z' },
      { fm: { generated: { at: '' }, timestamp: '2026-01-01T00:00:00Z' }, supersedes: false, lastModified: '2026-01-01T00:00:00Z' },
      { fm: { generated: { at: ['2026-06-30T00:00:00Z'] }, timestamp: '2026-01-01T00:00:00Z' }, supersedes: false, lastModified: '2026-01-01T00:00:00Z' },
    ];
    for (const { fm, supersedes, lastModified } of cases) {
      expect(generatedAtOf(fm) !== null).toBe(supersedes);
      expect(timestampIsProducerKey(fm)).toBe(supersedes);
      expect(timestampQuads(iri, fm, fm.timestamp).map((q) => q.predicate)).toEqual([supersedes ? SCHEMA_NS + 'timestamp' : SCHEMA_DATE_MODIFIED]);
      expect(lastModifiedOf(fm)).toBe(lastModified);
    }
  });
});
