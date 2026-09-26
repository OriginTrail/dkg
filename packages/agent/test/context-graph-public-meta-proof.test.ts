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
  hasAuthoritativePublicMetaDefinitionForApprovedMember,
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

  describe('post-approval contract of a public graph (#2827)', () => {
    const contextGraphId = 'public/post-approval-member';
    const member = '0x00000000000000000000000000000000000000a1';
    const peerId = '12D3KooWPostApprovalMemberPeer';
    const proof = { approvedAgentAddress: member, expectedDelegateePeerId: peerId, nowMs: 2_000 };

    function memberQuads(overrides: { revoked?: boolean; expiresAtMs?: number; peer?: string } = {}): Quad[] {
      const graph = contextGraphMetaGraphUri(contextGraphId);
      const root = contextGraphDataGraphUri(contextGraphId);
      const delegation = `did:dkg:agent-delegation:${contextGraphId}:${member}`;
      return [
        { subject: root, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${member}"`, graph },
        ...(overrides.revoked ? [{ subject: root, predicate: DKG_ONTOLOGY.DKG_REVOKED_AGENT, object: `"${member}"`, graph }] : []),
        { subject: delegation, predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT, object: `"${member}"`, graph },
        { subject: delegation, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER, object: `"${overrides.peer ?? peerId}"`, graph },
        { subject: delegation, predicate: DKG_ONTOLOGY.DKG_DELEGATION_ISSUED_AT, object: '"1000"', graph },
        ...(overrides.expiresAtMs === undefined ? [] : [{
          subject: delegation, predicate: DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT, object: `"${overrides.expiresAtMs}"`, graph,
        }]),
      ];
    }

    it('accepts the public definition only together with the approved-member proof', () => {
      const definition = authoritativePublicMetaQuads(contextGraphId);
      expect(hasAuthoritativePublicMetaDefinitionForApprovedMember(
        contextGraphId, [...definition, ...memberQuads()], proof,
      )).toBe(true);
      // The public definition alone is not the post-approval contract.
      expect(hasAuthoritativePublicMetaDefinitionForApprovedMember(contextGraphId, definition, proof)).toBe(false);
    });

    it('rejects a revoked, expired or foreign-bound member', () => {
      const definition = authoritativePublicMetaQuads(contextGraphId);
      for (const [name, quads] of [
        ['revoked', memberQuads({ revoked: true })],
        ['expired', memberQuads({ expiresAtMs: 1_500 })],
        ['bound to another peer', memberQuads({ peer: '12D3KooWSomebodyElse' })],
      ] as const) {
        expect(
          hasAuthoritativePublicMetaDefinitionForApprovedMember(contextGraphId, [...definition, ...quads], proof),
          name,
        ).toBe(false);
      }
    });

    it('keeps the post-approval snapshot check and its store query in lockstep', async () => {
      const definition = authoritativePublicMetaQuads(contextGraphId);
      const privateDefinition = definition.map((quad) => (
        quad.predicate === DKG_ONTOLOGY.DKG_ACCESS_POLICY ? { ...quad, object: '"private"' } : quad
      ));
      const cases: Array<[string, Quad[], boolean]> = [
        ['public definition with the member', [...definition, ...memberQuads()], true],
        ['public definition alone', definition, false],
        ['revoked member', [...definition, ...memberQuads({ revoked: true })], false],
        ['expired delegation', [...definition, ...memberQuads({ expiresAtMs: 1_500 })], false],
        ['delegation bound to another peer', [...definition, ...memberQuads({ peer: '12D3KooWSomebodyElse' })], false],
        ['private definition with the member', [...privateDefinition, ...memberQuads()], false],
      ];
      for (const [name, quads, expected] of cases) {
        const store = new OxigraphStore();
        try {
          await store.insert(quads);
          const result = await store.query(buildAuthoritativePublicMetaAskQuery(contextGraphId, proof));
          expect(result.type, name).toBe('boolean');
          if (result.type !== 'boolean') throw new Error('expected boolean ASK result');
          expect(result.value, name).toBe(expected);
          expect(hasAuthoritativePublicMetaDefinitionForApprovedMember(contextGraphId, quads, proof), name)
            .toBe(expected);
        } finally {
          await store.close();
        }
      }
    });

    it('never accepts a private definition, whatever the member proof says', () => {
      const privateDefinition = authoritativePublicMetaQuads(contextGraphId).map((quad) => (
        quad.predicate === DKG_ONTOLOGY.DKG_ACCESS_POLICY ? { ...quad, object: '"private"' } : quad
      ));
      expect(hasAuthoritativePublicMetaDefinitionForApprovedMember(
        contextGraphId, [...privateDefinition, ...memberQuads()], proof,
      )).toBe(false);
    });
  });
});
