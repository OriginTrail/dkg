import { describe, it, expect } from 'vitest';
import { formatCanonicalRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import {
  exportBundle,
  importBundle,
  literalTerm,
  quadsToNQuads,
  typedLiteralTerm,
  DKG_HAS_SECTION,
  RDF_JSON,
  XSD_DATE_TIME,
} from '../src/index.js';
import type { Quad } from '../src/index.js';
import { bundle, exportedFrontmatter } from './helpers/okf-v02-fixtures.js';

// Literal terms use the DKG's canonical form (dkg-rdf-utils), the one the
// stores return, so an import's quads match what a store holds byte for byte
// and export reads both with one parser.
const AWKWARD = 'del\u007F esc\u001B tab\t nl\n quote" back\\ emoji 🙂 Grüße 日本';

describe('literal terms are written in the canonical RDF form', () => {
  it('escapes what N-Triples requires, as the shared formatter does', () => {
    expect(literalTerm(AWKWARD)).toBe(formatCanonicalRdfLiteralTerm({ kind: 'plain', value: AWKWARD }));
    expect(literalTerm(AWKWARD)).toBe('"del\\u007F esc\\u001B tab\\t nl\\n quote\\" back\\\\ emoji 🙂 Grüße 日本"');
    expect(typedLiteralTerm('2026-06-30T14:00:00Z', XSD_DATE_TIME)).toBe(`"2026-06-30T14:00:00Z"^^<${XSD_DATE_TIME}>`);
    expect(typedLiteralTerm('{"a":"x\\ny"}', RDF_JSON)).toBe(`"{\\"a\\":\\"x\\\\ny\\"}"^^<${RDF_JSON}>`);
  });

  it('keeps every such character through import, export and re-import', () => {
    const escaped = 'del\\x7F esc\\x1B tab\\t nl\\n quote\\" back\\\\ emoji 🙂 Grüße 日本';
    const files = bundle(
      [
        'type: Metric',
        `title: "${escaped}"`,
        `note: "${escaped}"`,
        `executor: { resource: https://x.example/run, memo: "${escaped}" }`,
        `owner: { label: "${escaped}", lone: "\\uD800" }`,
      ].join('\n'),
    );
    const semantic = (quads: Quad[]) => quadsToNQuads(quads.filter((q) => q.predicate !== DKG_HAS_SECTION && !q.subject.includes('okfsec_')));
    const first = importBundle(files);
    expect(semantic(importBundle(exportBundle(first)).quads)).toBe(semantic(first.quads));
    const fm = exportedFrontmatter(files);
    expect(fm.title).toBe(AWKWARD);
    expect(fm.note).toBe(AWKWARD);
    expect((fm.executor as Record<string, unknown>).memo).toBe(AWKWARD);
    expect(fm.owner).toEqual({ label: AWKWARD, lone: '\uD800' });
  });
});
