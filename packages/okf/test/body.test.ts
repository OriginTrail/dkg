import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  exportBundle,
  exportInputFromQuads,
  importBundle,
  loadBundleDir,
  parseDocument,
  quadsToNQuads,
  GENID_TAGS,
  OKF_BODY_PART,
  OKF_BODY_PART_COUNT,
  OKF_CLASS_BODY_PART,
  RDF_TYPE,
  SCHEMA_CITATION,
  SCHEMA_MENTIONS,
  SCHEMA_POSITION,
  SCHEMA_TEXT,
  XSD_INTEGER,
} from '../src/index.js';
import type { BundleFile, Quad } from '../src/index.js';
import { BODY_PART_MAX_BYTES, modifiedUtf8Length, splitBody } from '../src/body.js';
import { literalTerm } from '../src/utils.js';
import { IRI, IDX_V02, node, objs, shuffled, withoutBody } from './helpers/okf-v02-fixtures.js';

const FM = '---\ntype: Metric\ntitle: Revenue\n---\n';
const PATH = 'metrics/revenue.md';
const COST = 'urn:okf:metrics/cost';
const INT = (n: number) => `"${n}"^^<${XSD_INTEGER}>`;
const part = (n: number) => node(GENID_TAGS.body, n);

/** The concept under test written exactly as `content`, beside two concepts it can link to. */
function withConcept(content: string): BundleFile[] {
  return [
    IDX_V02(),
    { path: PATH, content },
    { path: 'metrics/cost.md', content: '---\ntype: Metric\ntitle: Cost\n---\n\nbody\n' },
    { path: 'policies/revenue-recognition.md', content: '---\ntype: Policy\ntitle: Rev rec\n---\n\nbody\n' },
  ];
}

/** The concept body as `parseDocument` reads it, the text the importer stores. */
const bodyOf = (files: BundleFile[], path = PATH) => parseDocument(path, files.find((f) => f.path === path)!.content).body;
const exportOf = (quads: readonly Quad[]) => exportBundle(exportInputFromQuads(quads));
const sortedLines = (quads: Quad[]) => quadsToNQuads(quads).split('\n').sort().join('\n');

/** A body of `size` code units dense with what costs extra bytes: escapes, control characters, NUL, CJK and astral characters. */
function denseBody(size: number): string {
  const unit = 'ab😀"\\\t\u0001\u0000é漢\n';
  let out = '';
  for (let i = 0; out.length < size; i++) out += `${i} ${unit}`;
  return out;
}

describe('the body is stored verbatim and exported as written', () => {
  const cases: Array<[string, string]> = [
    ['prose, a link and a legacy citation', FM + '\nRecognised on delivery.\n\nSee [rev rec](/policies/revenue-recognition.md).\n\n# Citations\n\n[1] [ifrs](https://ifrs.example/15)\n'],
    ['CRLF line endings', '---\r\ntype: Metric\r\n---\r\n\r\nLine one\r\nLine two\r\n\r\n# Section\r\n'],
    ['no blank line after the frontmatter', FM + 'Body right after the frontmatter.\n'],
    ['leading blank lines', FM + '\n\n\n\nAfter three blank lines.\n'],
    ['no final newline', FM + '\nNo final newline'],
    ['trailing whitespace and blank lines', FM + '\nspaces   \ntab\t\n\n\n   \n'],
    ['an empty body', FM],
    ['Markdown that looks like structure', FM + '\n# Definition\n\nUse `[c](/metrics/cost.md)` in code.\n\n```\n# not a heading\n---\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<div>html</div>\n\n---\n\nAfter a thematic break.\n'],
    ['non-ASCII text, astral characters and a lone surrogate', FM + '\nשלום, é, 𝔘𝔫𝔦 🧪, \ud800 end\n'],
  ];
  it.each(cases)('%s', (_name, content) => {
    const files = withConcept(content);
    const imported = importBundle(files);
    const exported = exportBundle(imported);
    expect(bodyOf(exported)).toBe(bodyOf(files));
    // From a graph read back in any order, and exported again: the same bundle.
    expect(exportOf(shuffled([...imported.quads, ...imported.quads], 7))).toEqual(exported);
    expect(exportBundle(importBundle(exported))).toEqual(exported);
  });

  it('reproduces the whole graph on re-import, sections included', () => {
    for (const name of ['crypto_bitcoin', 'acme_retail']) {
      const first = importBundle(loadBundleDir(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));
      expect(sortedLines(importBundle(exportBundle(first)).quads)).toBe(sortedLines(first.quads));
    }
  });
});

describe('how a body is stored', () => {
  it('in one part: the count on the concept, the position and text on a typed node', () => {
    const { quads } = importBundle(withConcept(FM + '\nShort "quoted" body.\n'));
    expect(objs(quads, OKF_BODY_PART_COUNT)).toEqual([INT(1)]);
    expect(objs(quads, OKF_BODY_PART)).toEqual([part(0)]);
    expect(objs(quads, RDF_TYPE, part(0))).toEqual([OKF_CLASS_BODY_PART]);
    expect(objs(quads, SCHEMA_POSITION, part(0))).toEqual([INT(0)]);
    expect(objs(quads, SCHEMA_TEXT, part(0))).toEqual([literalTerm('Short "quoted" body.\n')]);
  });

  it('an empty body as a count of 0 and no parts', () => {
    const { quads } = importBundle(withConcept(FM));
    expect(objs(quads, OKF_BODY_PART_COUNT)).toEqual([INT(0)]);
    expect(objs(quads, OKF_BODY_PART)).toEqual([]);
  });

  it('a long body in parts within half the node literal limit, which concatenate to it', () => {
    const body = denseBody(120_000);
    const { quads } = importBundle(withConcept(`${FM}\n${body}`));
    const parts = objs(quads, OKF_BODY_PART);
    expect(parts.length).toBeGreaterThan(5);
    expect(objs(quads, OKF_BODY_PART_COUNT)).toEqual([INT(parts.length)]);
    for (const q of quads.filter((x) => x.object.startsWith('"'))) {
      expect(modifiedUtf8Length(q.object)).toBeLessThanOrEqual(BODY_PART_MAX_BYTES);
    }
    expect(BODY_PART_MAX_BYTES * 2).toBe(60_000);
    const texts = parts.map((_, n) => objs(quads, SCHEMA_TEXT, part(n)));
    expect(texts.map((t) => t.length)).toEqual(parts.map(() => 1));
    expect(splitBody(body).map(literalTerm)).toEqual(texts.map((t) => t[0]));
    expect(splitBody(body).join('')).toBe(body);
    expect(bodyOf(exportOf(shuffled(quads, 42)))).toBe(body);
  });

  it('measures a term as the node does, in Java modified UTF-8', () => {
    expect(['\u0000', 'a', 'é', '漢', '😀', '\ud800'].map(modifiedUtf8Length)).toEqual([2, 1, 2, 3, 6, 3]);
  });
});

describe('splitBody', () => {
  it('gives an empty body no parts and a body that fits one', () => {
    expect(splitBody('')).toEqual([]);
    expect(splitBody('abc')).toEqual(['abc']);
  });

  it('never divides a surrogate pair, and keeps every part within the budget', () => {
    const body = 'a😀b😀😀c😀';
    for (const maxBytes of [8, 9, 10, 11, 12, 13]) {
      const parts = splitBody(body, maxBytes);
      expect(parts.join('')).toBe(body);
      for (const p of parts) {
        expect(modifiedUtf8Length(literalTerm(p))).toBeLessThanOrEqual(maxBytes);
        expect(p).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
      }
    }
  });

  it('counts each character at its escaped size', () => {
    // `"` is written `\"` (2 bytes), U+0001 and NUL `\u0001` / `\u0000` (6): with the quotes, 12 bytes hold 5 and 2.
    expect(splitBody('"'.repeat(12), 12)).toEqual(['"'.repeat(5), '"'.repeat(5), '"'.repeat(2)]);
    expect(splitBody('\u0001\u0000\u0001\u0000\u0001', 14)).toEqual(['\u0001\u0000', '\u0001\u0000', '\u0001']);
  });
});

describe('a graph with no complete stored body exports a body regenerated from it', () => {
  const imported = importBundle(withConcept(FM + '\nSee [rev rec](/policies/revenue-recognition.md).\n\n# Citations\n\n[1] [ifrs](https://ifrs.example/15)\n'));
  const regenerated = '# Related\n\n* [policies/revenue-recognition](/policies/revenue-recognition.md)\n\n# Citations\n\n[1] [https://ifrs.example/15](https://ifrs.example/15)\n';

  it('as before, for a graph imported before bodies were stored', () => {
    expect(bodyOf(exportOf(withoutBody(imported.quads)))).toBe(regenerated);
  });

  // A three-part body (`x` costs 1 byte), and its stored parts broken each way.
  const long = importBundle(withConcept(`${FM}\n${'x'.repeat(BODY_PART_MAX_BYTES * 2 + 100)}`));
  const isPart1 = (q: Quad) => q.subject === part(1) || q.object === part(1);
  const broken: Array<[string, Quad[]]> = [
    ['a part missing', long.quads.filter((q) => !isPart1(q))],
    ['a part without its text', long.quads.filter((q) => !(q.subject === part(1) && q.predicate === SCHEMA_TEXT))],
    ['a part with two texts', [...long.quads, { subject: part(1), predicate: SCHEMA_TEXT, object: '"other"' }]],
    ['a repeated position', [...long.quads.filter((q) => !(q.subject === part(2) && q.predicate === SCHEMA_POSITION)), { subject: part(2), predicate: SCHEMA_POSITION, object: INT(1) }]],
    ['a position past the count', [...long.quads.filter((q) => !(q.subject === part(2) && q.predicate === SCHEMA_POSITION)), { subject: part(2), predicate: SCHEMA_POSITION, object: INT(3) }]],
    ['a negative position', [...long.quads.filter((q) => !(q.subject === part(2) && q.predicate === SCHEMA_POSITION)), { subject: part(2), predicate: SCHEMA_POSITION, object: INT(-1) }]],
    ['two counts', [...long.quads, { subject: IRI, predicate: OKF_BODY_PART_COUNT, object: INT(4) }]],
    ['a count that is not an integer', [...long.quads.filter((q) => q.predicate !== OKF_BODY_PART_COUNT), { subject: IRI, predicate: OKF_BODY_PART_COUNT, object: '"3"' }]],
  ];
  it.each(broken)('with %s', (_name, quads) => {
    expect(objs(long.quads, OKF_BODY_PART)).toHaveLength(3);
    expect(bodyOf(exportOf(quads))).toBe('');
  });
});

describe('a graph edited after import', () => {
  const added = (quads: readonly Quad[], ...extra: Quad[]) => [...quads, ...extra];
  const edge: Quad = { subject: IRI, predicate: SCHEMA_MENTIONS, object: COST };
  const citation: Quad = { subject: IRI, predicate: SCHEMA_CITATION, object: 'https://added.example/' };

  it('gets the edges and citations its body does not express appended, which read back', () => {
    const body = '\nRecognised on delivery, see [rev rec](/policies/revenue-recognition.md) and [IFRS 15](https://ifrs.example/15).\n';
    const { quads } = importBundle(withConcept(FM + body));
    const exported = exportOf(added(quads, edge, citation));
    expect(bodyOf(exported)).toBe(
      body.slice(1) + '\n# Related\n\n* [metrics/cost](/metrics/cost.md)\n\n# Citations\n\n[1] [https://added.example/](https://added.example/)\n',
    );
    const again = importBundle(exported);
    expect(objs(again.quads, SCHEMA_MENTIONS).sort()).toEqual([COST, 'urn:okf:policies/revenue-recognition']);
    expect(objs(again.quads, SCHEMA_CITATION)).toEqual(['https://added.example/']);
    expect(exportBundle(again)).toEqual(exported);
  });

  it('separates the appendix from a body with no final newline', () => {
    const { quads } = importBundle(withConcept(FM + '\nNo final newline'));
    expect(bodyOf(exportOf(added(quads, edge)))).toBe('No final newline\n\n# Related\n\n* [metrics/cost](/metrics/cost.md)\n');
  });

  it('appends an edge whose only link is in a code span, unless code-span links make edges', () => {
    const files = withConcept(FM + '\nUse `[c](/metrics/cost.md)` in code.\n');
    const imported = importBundle(files, { includeCodeSpanLinks: true });
    expect(objs(imported.quads, SCHEMA_MENTIONS)).toEqual([COST]);
    expect(bodyOf(exportBundle(imported, { includeCodeSpanLinks: true }))).toBe(bodyOf(files));
    const exported = exportBundle(imported);
    expect(bodyOf(exported)).toBe(bodyOf(files) + '\n# Related\n\n* [metrics/cost](/metrics/cost.md)\n');
    expect(objs(importBundle(exported).quads, SCHEMA_MENTIONS)).toEqual([COST]);
  });

  it('keeps a link its body holds, so the edge comes back on re-import even after it was removed', () => {
    const files = withConcept(FM + '\nSee [cost](/metrics/cost.md).\n');
    const { quads } = importBundle(files);
    const exported = exportOf(quads.filter((q) => q.predicate !== SCHEMA_MENTIONS));
    expect(bodyOf(exported)).toBe(bodyOf(files));
    expect(objs(importBundle(exported).quads, SCHEMA_MENTIONS)).toEqual([COST]);
  });

  it('regenerates the body when its appendix would not read back, after a code block left open', () => {
    const { quads } = importBundle(withConcept(FM + '\n```\nunclosed\n'));
    expect(bodyOf(exportOf(added(quads, edge)))).toBe('# Related\n\n* [metrics/cost](/metrics/cost.md)\n');
  });
});
