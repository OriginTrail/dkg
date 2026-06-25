import { describe, expect, it } from 'vitest';
import {
  DKG_CHUNK_VALUE,
  DKG_HAS_TEXT_BODY,
  normalizeLargeRdfLiteralsForBlazegraph,
} from '@origintrail-official/dkg-core';
import {
  buildImportFileResponse,
  parsePublishRequestBody,
  preparePublicWriteQuads,
  prepareValidatedPublicWriteQuads,
  validateWritableQuadLiteralSizes,
} from '../src/daemon/http-utils.js';

const OVERSIZED_LITERAL = `"${'x'.repeat(60_000)}"`;

describe('HTTP RDF literal size validation', () => {
  it('normalizes oversized direct publish schema:text literals', () => {
    const parsed = parsePublishRequestBody(JSON.stringify({
      contextGraphId: 'literal-size-cg',
      quads: [{
        subject: 'http://example.org/s',
        predicate: 'http://schema.org/text',
        object: OVERSIZED_LITERAL,
        graph: 'http://example.org/g',
      }],
    }));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.literalRewrites).toHaveLength(1);
      expect(parsed.value.literalRewrites?.[0]).toMatchObject({
        subject: 'http://example.org/s',
        predicate: 'http://schema.org/text',
        originalMutf8Bytes: 60_002,
      });
      expect(parsed.value.body.quads.some((quad) =>
        quad.subject === 'http://example.org/s' &&
        quad.predicate === 'http://schema.org/text'
      )).toBe(false);
      expect(parsed.value.body.quads.some((quad) =>
        quad.subject === 'http://example.org/s' &&
        quad.predicate === DKG_HAS_TEXT_BODY
      )).toBe(true);
      expect(parsed.value.body.quads.some((quad) => quad.predicate === DKG_CHUNK_VALUE)).toBe(true);
    }
  });

  it('normalizes linked blank-node schema:text literals and derives rewrite metadata server-side', () => {
    const parsed = parsePublishRequestBody(JSON.stringify({
      contextGraphId: 'literal-size-cg',
      literalRewrites: [{ subject: 'client-supplied', predicate: 'ignored' }],
      quads: [
        {
          subject: 'http://example.org/root',
          predicate: 'http://schema.org/hasPart',
          object: '_:body',
          graph: 'http://example.org/g',
        },
        {
          subject: '_:body',
          predicate: 'http://schema.org/text',
          object: OVERSIZED_LITERAL,
          graph: 'http://example.org/g',
        },
      ],
    }));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const child = 'http://example.org/root/.well-known/genid/body';
      expect(parsed.value.literalRewrites).toHaveLength(1);
      expect(parsed.value.literalRewrites[0]).toMatchObject({
        subject: child,
        predicate: 'http://schema.org/text',
        originalMutf8Bytes: 60_002,
      });
      expect(parsed.value.literalRewrites[0]?.subject).not.toBe('client-supplied');
      expect(parsed.value.body.quads.some((quad) =>
        quad.subject === 'http://example.org/root' &&
        quad.predicate === 'http://schema.org/hasPart' &&
        quad.object === child
      )).toBe(true);
      expect(parsed.value.body.quads.some((quad) =>
        quad.subject === child &&
        quad.predicate === 'http://schema.org/text'
      )).toBe(false);
      expect(parsed.value.body.quads.some((quad) =>
        quad.subject === child &&
        quad.predicate === DKG_HAS_TEXT_BODY
      )).toBe(true);
      expect(parsed.value.body.quads.some((quad) => quad.predicate === DKG_CHUNK_VALUE)).toBe(true);
    }
  });

  it('returns structured parse failure for oversized private publish literals', () => {
    const parsed = parsePublishRequestBody(JSON.stringify({
      contextGraphId: 'literal-size-cg',
      quads: [{
        subject: 'http://example.org/s',
        predicate: 'http://schema.org/name',
        object: '"safe"',
        graph: 'http://example.org/g',
      }],
      privateQuads: [{
        subject: 'http://example.org/s',
        predicate: 'http://schema.org/text',
        object: OVERSIZED_LITERAL,
        graph: 'http://example.org/g',
      }],
    }));

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.body).toMatchObject({
        code: 'OVERSIZED_RDF_LITERAL',
        actualBytes: 60_002,
        limitBytes: 60_000,
        predicate: 'http://schema.org/text',
      });
    }
  });

  it('rejects blank-node private publish object terms because private quads are not skolemized', () => {
    const parsed = parsePublishRequestBody(JSON.stringify({
      contextGraphId: 'literal-size-cg',
      quads: [{
        subject: 'http://example.org/root',
        predicate: 'http://schema.org/name',
        object: '"safe"',
        graph: 'http://example.org/g',
      }],
      privateQuads: [
        {
          subject: 'http://example.org/root',
          predicate: 'http://schema.org/hasPart',
          object: '_:secret',
          graph: 'http://example.org/g',
        },
        {
          subject: 'http://example.org/root/secret',
          predicate: 'http://schema.org/name',
          object: '"hidden"',
          graph: 'http://example.org/g',
        },
      ],
    }));

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain('Invalid "privateQuads[0].object"');
      expect(parsed.error).toContain('quoted literal term or absolute IRI');
    }
  });

  it('rejects blank-node private publish subjects even when public quads link to the same blank node', () => {
    const parsed = parsePublishRequestBody(JSON.stringify({
      contextGraphId: 'literal-size-cg',
      quads: [{
        subject: 'http://example.org/root',
        predicate: 'http://schema.org/hasPart',
        object: '_:secret',
        graph: 'http://example.org/g',
      }],
      privateQuads: [{
        subject: '_:secret',
        predicate: 'http://schema.org/name',
        object: '"hidden"',
        graph: 'http://example.org/g',
      }],
    }));

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain('Invalid "privateQuads[0].subject"');
      expect(parsed.error).toContain('must not be a blank node');
    }
  });

  it('returns structured validation failure for reject-only private/writable guards', () => {
    const result = validateWritableQuadLiteralSizes('quads', [{
      subject: 'http://example.org/s',
      predicate: 'http://schema.org/name',
      object: OVERSIZED_LITERAL,
    }]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.body).toMatchObject({
        code: 'OVERSIZED_RDF_LITERAL',
        actualBytes: 60_002,
        limitBytes: 60_000,
      });
    }
  });

  it('prepares validated public-write quads with explicit normalized count', () => {
    const prepared = prepareValidatedPublicWriteQuads('quads', [{
      subject: 'http://example.org/s',
      predicate: 'http://schema.org/text',
      object: OVERSIZED_LITERAL,
      graph: 'http://example.org/g',
    }]);

    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.value.rewrites).toHaveLength(1);
      expect(prepared.value.quads.some((quad) => quad.predicate === DKG_CHUNK_VALUE)).toBe(true);
      expect(prepared.value.totalQuads).toBe(prepared.value.quads.length);
    }
  });

  it('returns structured object-term validation failures from the validated public-write helper', () => {
    const prepared = prepareValidatedPublicWriteQuads('quads', [{
      subject: 'http://example.org/s',
      predicate: 'http://schema.org/name',
      object: 'not-a-valid-rdf-object',
      graph: 'http://example.org/g',
    }]);

    expect(prepared.ok).toBe(false);
    if (!prepared.ok) {
      expect(prepared.body.error).toContain('Invalid "quads[0].object"');
    }
  });

  it('rejects small malformed quoted literal terms before storage routes see them', () => {
    for (const object of ['"bad\nliteral"', ' "ok"', '"ok"\n']) {
      const prepared = prepareValidatedPublicWriteQuads('quads', [{
        subject: 'http://example.org/s',
        predicate: 'http://schema.org/name',
        object,
        graph: 'http://example.org/g',
      }]);

      expect(prepared.ok).toBe(false);
      if (!prepared.ok) {
        expect(prepared.body.error).toContain('well-formed quoted literal term');
      }
    }
  });

  it('keeps import-file chunk quads in their source data or metadata graph', () => {
    const dataGraph = 'did:dkg:context-graph:test/_working_memory/0xabc/1';
    const metaGraph = 'did:dkg:context-graph:test/_meta';
    const normalized = normalizeLargeRdfLiteralsForBlazegraph([
      {
        subject: 'http://example.org/import-root',
        predicate: 'http://schema.org/text',
        object: OVERSIZED_LITERAL,
        graph: dataGraph,
      },
      {
        subject: 'http://example.org/import-meta',
        predicate: 'http://schema.org/name',
        object: '"metadata"',
        graph: metaGraph,
      },
    ], { label: 'import-file.quads' });

    const dataQuads = normalized.quads.filter((quad) => quad.graph === dataGraph);
    const metaQuads = normalized.quads.filter((quad) => quad.graph === metaGraph);
    expect(dataQuads.some((quad) => quad.predicate === DKG_CHUNK_VALUE)).toBe(true);
    expect(dataQuads.some((quad) => quad.predicate === 'http://schema.org/text')).toBe(false);
    expect(metaQuads).toEqual([{
      subject: 'http://example.org/import-meta',
      predicate: 'http://schema.org/name',
      object: '"metadata"',
      graph: metaGraph,
    }]);
  });

  it('prepares semantic enrichment quads without moving provenance quads', () => {
    const graph = 'did:dkg:context-graph:test/_working_memory/0xabc/semantic';
    const prepared = preparePublicWriteQuads('semanticQuads', [
      {
        subject: 'http://example.org/semantic',
        predicate: 'http://schema.org/text',
        object: OVERSIZED_LITERAL,
        graph,
      },
      {
        subject: 'http://example.org/provenance',
        predicate: 'http://dkg.io/ontology/generatedBy',
        object: '"semantic-enrichment"',
        graph,
      },
    ]);

    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.value.quads.some((quad) => quad.predicate === DKG_CHUNK_VALUE)).toBe(true);
      expect(prepared.value.quads.some((quad) =>
        quad.subject === 'http://example.org/provenance' &&
        quad.predicate === 'http://dkg.io/ontology/generatedBy'
      )).toBe(true);
      expect(prepared.value.rewrites).toHaveLength(1);
    }
  });

  it('preserves empty graph on normalized public-write quads', () => {
    const prepared = preparePublicWriteQuads('quads', [{
      subject: 'http://example.org/empty-graph',
      predicate: 'http://schema.org/text',
      object: OVERSIZED_LITERAL,
      graph: '',
    }]);

    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.value.quads.length).toBeGreaterThan(1);
      expect(prepared.value.quads.every((quad) =>
        Object.prototype.hasOwnProperty.call(quad, 'graph')
      )).toBe(true);
      expect(prepared.value.quads.every((quad) => quad.graph === '')).toBe(true);
      expect(prepared.value.rewrites[0]).toMatchObject({
        subject: 'http://example.org/empty-graph',
        predicate: 'http://schema.org/text',
        graph: '',
      });
    }
  });

  it('preserves oversized literal fields in import-file extraction responses', () => {
    expect(buildImportFileResponse({
      assertionUri: 'http://example.org/assertion',
      fileHash: '0xabc',
      detectedContentType: 'text/markdown',
      extraction: {
        status: 'failed',
        tripleCount: 1,
        pipelineUsed: 'markdown',
        error: 'RDF literal exceeds safe MUTF-8 byte limit',
        code: 'OVERSIZED_RDF_LITERAL',
        actualBytes: 60_002,
        limitBytes: 60_000,
        predicate: 'http://schema.org/text',
      },
    }).extraction).toMatchObject({
      code: 'OVERSIZED_RDF_LITERAL',
      actualBytes: 60_002,
      limitBytes: 60_000,
      predicate: 'http://schema.org/text',
    });
  });
});
