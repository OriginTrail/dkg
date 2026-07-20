import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeAbsoluteIriV1,
  canonicalizeNQuadsV1,
  parseNQuadLineV1,
  parseRdfTermV1,
  rdfStateDigestV1,
  requireCanonicalNQuadsV1,
} from '../../src/rdf/nquads.js';
import { rdfLogicalKeyV1, rdfTouchedKeyV1 } from '../../src/rdf/keys.js';

const fixture = JSON.parse(await readFile(
  resolve(process.cwd(), '../../conformance/wal-v1/vectors/protocol-v1.json'),
  'utf8',
)).rdfAdapter;

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

describe('canonical N-Quads v1', () => {
  it('matches the checked-in UTF-8, NFC, language, dedupe, sort, and digest fixture', () => {
    const canonical = canonicalizeNQuadsV1(fixture.canonicalization.input);
    expect(canonical.text).toBe(fixture.canonicalization.canonical);
    expect(new TextDecoder().decode(canonical.bytes)).toBe(fixture.canonicalization.canonical);
    expect(canonical.quadCount).toBe(2);
    expect(hex(canonical.stateDigest)).toBe(fixture.canonicalization.stateDigest);
    expect(hex(rdfStateDigestV1(canonical.bytes))).toBe(fixture.canonicalization.stateDigest);
    expect(requireCanonicalNQuadsV1(canonical.bytes).text).toBe(canonical.text);
  });

  it('freezes author-scoped logical and graph/subject/predicate touched keys', () => {
    expect(hex(rdfLogicalKeyV1({
      contextGraphId: fixture.logicalKey.contextGraphId,
      subGraphName: fixture.logicalKey.subGraphName,
      authorAddress: new Uint8Array(Buffer.from(fixture.logicalKey.authorAddress, 'hex')),
      knowledgeAssetUalOrRootEntity: fixture.logicalKey.knowledgeAssetUalOrRootEntity,
    }))).toBe(fixture.logicalKey.digest);
    for (const touched of fixture.touchedKeys) {
      expect(hex(rdfTouchedKeyV1(
        touched.graphIri,
        touched.subjectIri,
        touched.predicateIri,
      ))).toBe(touched.digest);
    }
  });

  it('uses unsigned UTF-8 line order under arbitrary input permutations', () => {
    const lines = [
      '<urn:s:é> <urn:p> "2" <urn:g> .',
      '<urn:s:z> <urn:p> "1" <urn:g> .',
      '<urn:s:a> <urn:p> "0" <urn:g> .',
    ];
    const expected = canonicalizeNQuadsV1(lines.join('\n'));
    for (let rotation = 0; rotation < 24; rotation += 1) {
      const permuted = [...lines].sort((left, right) => {
        const a = (left.charCodeAt(rotation % left.length) + rotation) % 7;
        const b = (right.charCodeAt(rotation % right.length) + rotation) % 7;
        return a - b || right.localeCompare(left);
      });
      expect(canonicalizeNQuadsV1(permuted.join('\r\n')).bytes).toEqual(expected.bytes);
      expect(canonicalizeNQuadsV1(permuted.concat(permuted).join('\n')).stateDigest).toEqual(expected.stateDigest);
    }
  });

  it('normalizes all RDF 1.1 literal escapes and IRI Unicode escapes', () => {
    const canonical = canonicalizeNQuadsV1(
      '<urn:\\u0073> <urn:p> "q\\\"uote\\\\slash\\ttab\\bback\\nline\\rret\\fform\\u00e9\\U0001F600"^^<urn:\\u0074> <urn:g> .',
    );
    expect(canonical.text).toBe(
      '<urn:s> <urn:p> "q\\"uote\\\\slash\\ttab\\bback\\nline\\rret\\fformé😀"^^<urn:t> <urn:g> .\n',
    );
    expect(parseRdfTermV1('<urn:s>', 0, { allowLiteral: false })).toMatchObject({
      kind: 'iri',
      iri: 'urn:s',
      canonical: '<urn:s>',
      end: 7,
    });
    expect(canonicalizeAbsoluteIriV1('urn:café')).toBe('urn:café');
    expect(canonicalizeNQuadsV1('<urn:s> <urn:p> "\\u0001" <urn:g> .').text)
      .toBe('<urn:s> <urn:p> "\\u0001" <urn:g> .\n');
  });

  it('removes comments and blank lines but requires exact canonical bytes remotely', () => {
    const noncanonical = new TextEncoder().encode(
      '# lead\r\n <urn:s>  <urn:p> \"x\"@EN <urn:g> . # tail\r\n\r\n',
    );
    expect(canonicalizeNQuadsV1(noncanonical).text).toBe(
      '<urn:s> <urn:p> "x"@en <urn:g> .\n',
    );
    expect(() => requireCanonicalNQuadsV1(noncanonical)).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_NON_CANONICAL' }),
    );
    expect(() => requireCanonicalNQuadsV1('text' as never)).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_NON_CANONICAL' }),
    );
  });

  it.each([
    ['blank subject', '_:b <urn:p> "x" <urn:g> .', 'WAL_RDF_BLANK_NODE'],
    ['blank object', '<urn:s> <urn:p> _:b <urn:g> .', 'WAL_RDF_BLANK_NODE'],
    ['blank graph', '<urn:s> <urn:p> "x" _:b .', 'WAL_RDF_BLANK_NODE'],
    ['relative subject', '<relative> <urn:p> "x" <urn:g> .', 'WAL_RDF_IRI_INVALID'],
    ['forbidden IRI', '<urn:s x> <urn:p> "x" <urn:g> .', 'WAL_RDF_IRI_INVALID'],
    ['missing separator', '<urn:s><urn:p> "x" <urn:g> .', 'WAL_RDF_INVALID_NQUADS'],
    ['literal subject', '"s" <urn:p> "x" <urn:g> .', 'WAL_RDF_INVALID_NQUADS'],
    ['literal predicate', '<urn:s> "p" "x" <urn:g> .', 'WAL_RDF_INVALID_NQUADS'],
    ['missing graph', '<urn:s> <urn:p> "x" .', 'WAL_RDF_INVALID_NQUADS'],
    ['missing dot', '<urn:s> <urn:p> "x" <urn:g>', 'WAL_RDF_INVALID_NQUADS'],
    ['wrong dot token', '<urn:s> <urn:p> "x" <urn:g> nope', 'WAL_RDF_INVALID_NQUADS'],
    ['trailing syntax', '<urn:s> <urn:p> "x" <urn:g> . nope', 'WAL_RDF_INVALID_NQUADS'],
    ['bad language', '<urn:s> <urn:p> "x"@en_XX <urn:g> .', 'WAL_RDF_INVALID_NQUADS'],
    ['bad escape', '<urn:s> <urn:p> "x\\q" <urn:g> .', 'WAL_RDF_INVALID_NQUADS'],
    ['short Unicode escape', '<urn:s> <urn:p> "\\u12" <urn:g> .', 'WAL_RDF_INVALID_NQUADS'],
    ['surrogate escape', '<urn:s> <urn:p> "\\uD800" <urn:g> .', 'WAL_RDF_INVALID_NQUADS'],
    ['oversize escape', '<urn:s> <urn:p> "\\U00110000" <urn:g> .', 'WAL_RDF_INVALID_NQUADS'],
    ['unterminated IRI', '<urn:s', 'WAL_RDF_INVALID_NQUADS'],
    ['unterminated literal', '<urn:s> <urn:p> "x <urn:g> .', 'WAL_RDF_INVALID_NQUADS'],
    ['datatype without IRI', '<urn:s> <urn:p> "x"^^type <urn:g> .', 'WAL_RDF_INVALID_NQUADS'],
    ['unescaped literal control', '<urn:s> <urn:p> "x\u0001" <urn:g> .', 'WAL_RDF_INVALID_NQUADS'],
    ['missing language', '<urn:s> <urn:p> "x"@ <urn:g> .', 'WAL_RDF_INVALID_NQUADS'],
  ])('rejects %s with a stable reason', (_name, source, code) => {
    expect(() => canonicalizeNQuadsV1(source)).toThrow(expect.objectContaining({ code }));
  });

  it('rejects invalid UTF-8, scalar text, and every configured resource limit', () => {
    expect(() => canonicalizeNQuadsV1(Uint8Array.of(0xc3, 0x28))).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_INVALID_NQUADS' }),
    );
    expect(() => canonicalizeNQuadsV1('\ud800')).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_INVALID_NQUADS' }),
    );
    expect(() => canonicalizeNQuadsV1('\udc00')).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_INVALID_NQUADS' }),
    );
    expect(() => canonicalizeNQuadsV1('\ud800x')).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_INVALID_NQUADS' }),
    );
    const one = '<urn:s> <urn:p> "x" <urn:g> .';
    expect(() => canonicalizeNQuadsV1(one, { maximumSourceBytes: 1 })).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }),
    );
    expect(() => canonicalizeNQuadsV1(one, { maximumCanonicalBytes: 1 })).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }),
    );
    expect(() => canonicalizeNQuadsV1(one, { maximumQuads: 0 })).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }),
    );
    expect(() => canonicalizeNQuadsV1(one, { maximumQuads: -1 })).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }),
    );
    expect(() => canonicalizeNQuadsV1(null as never)).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_INVALID_NQUADS' }),
    );
  });

  it('parses one canonical line into explicit RDF coordinates', () => {
    expect(parseNQuadLineV1('<urn:s> <urn:p> "x"^^<urn:t> <urn:g> .')).toEqual({
      subject: 'urn:s',
      predicate: 'urn:p',
      object: '"x"^^<urn:t>',
      graph: 'urn:g',
      canonicalLine: '<urn:s> <urn:p> "x"^^<urn:t> <urn:g> .',
    });
  });

  it('rejects empty and non-text IRI inputs', () => {
    expect(() => canonicalizeAbsoluteIriV1('')).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_IRI_INVALID' }),
    );
    expect(() => canonicalizeAbsoluteIriV1(null as never)).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_IRI_INVALID' }),
    );
  });
});
