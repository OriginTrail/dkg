import { describe, expect, it } from 'vitest';
import {
  DKG_ONTOLOGY,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  buildAuthoritativePublicMetaAskQuery,
  buildAuthoritativePublicMetaQuads,
  hasAuthoritativePublicMetaDefinition,
  inspectAuthoritativePublicMetaDefinition,
} from '../src/context-graph-public-meta-proof.js';

function authoritativePublicMetaQuads(contextGraphId: string): Quad[] {
  const graph = contextGraphMetaGraphUri(contextGraphId);
  const subject = contextGraphDataGraphUri(contextGraphId);
  return [
    {
      subject,
      predicate: DKG_ONTOLOGY.RDF_TYPE,
      object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
      graph,
    },
    {
      subject,
      predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
      object: '"public"',
      graph,
    },
  ];
}

describe('authoritative public metadata proof', () => {
  it('classifies every canonical requirement as missing when that quad is absent', () => {
    const contextGraphId = 'public/canonical-requirement-classification';
    const canonical = buildAuthoritativePublicMetaQuads(contextGraphId);

    for (const [missingIndex, expectedMissing] of canonical.entries()) {
      const inspection = inspectAuthoritativePublicMetaDefinition(
        contextGraphId,
        canonical.filter((_, index) => index !== missingIndex),
      );
      expect(inspection.missing).toEqual([expectedMissing]);
    }
  });

  it('keeps fetched-snapshot evaluation and the generated store query in lockstep', async () => {
    const cases = [
      {
        name: 'complete public definition',
        mutate: (quads: Quad[]) => quads,
        expected: true,
      },
      {
        name: 'normalized public policy whitespace',
        mutate: (quads: Quad[]) => quads.map((quad) => (
          quad.predicate === DKG_ONTOLOGY.DKG_ACCESS_POLICY
            ? { ...quad, object: '"  PuBlIc  "' }
            : quad
        )),
        expected: true,
      },
      {
        name: 'private policy',
        mutate: (quads: Quad[]) => quads.map((quad) => (
          quad.predicate === DKG_ONTOLOGY.DKG_ACCESS_POLICY
            ? { ...quad, object: '"private"' }
            : quad
        )),
        expected: false,
      },
      {
        name: 'contradictory public and private policies',
        mutate: (quads: Quad[]) => [
          ...quads,
          {
            ...quads.find(
              (quad) => quad.predicate === DKG_ONTOLOGY.DKG_ACCESS_POLICY,
            )!,
            object: '"private"',
          },
        ],
        expected: false,
      },
      {
        name: 'missing context graph type',
        mutate: (quads: Quad[]) => quads.filter(
          (quad) => quad.predicate !== DKG_ONTOLOGY.RDF_TYPE,
        ),
        expected: false,
      },
      {
        name: 'definition attached to a different root',
        mutate: (quads: Quad[]) => quads.map((quad) => ({
          ...quad,
          subject: `${quad.subject}/forged`,
        })),
        expected: false,
      },
      {
        name: 'definition stored outside the root metadata graph',
        mutate: (quads: Quad[]) => quads.map((quad) => ({
          ...quad,
          graph: quad.subject,
        })),
        expected: false,
      },
    ];

    for (const [index, proofCase] of cases.entries()) {
      const contextGraphId = `public/proof-parity-${index}`;
      const quads = proofCase.mutate(authoritativePublicMetaQuads(contextGraphId));
      const store = new OxigraphStore();
      try {
        await store.insert(quads);
        const queryResult = await store.query(
          buildAuthoritativePublicMetaAskQuery(contextGraphId),
        );
        expect(queryResult.type, proofCase.name).toBe('boolean');
        if (queryResult.type !== 'boolean') throw new Error('expected boolean ASK result');
        expect(
          hasAuthoritativePublicMetaDefinition(contextGraphId, quads),
          proofCase.name,
        ).toBe(proofCase.expected);
        expect(queryResult.value, proofCase.name).toBe(proofCase.expected);
      } finally {
        await store.close();
      }
    }
  });
});
