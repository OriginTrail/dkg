import { describe, expect, it } from 'vitest';

import {
  AGENT_PROFILE_LINK_PREDICATES_V1,
  evaluateAuthorityTransitionConflictV1,
  isAllowedAgentProfilePredicateV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileOwnedSubjectKindV1,
} from '../src/system-record-v1.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA = 'https://schema.org/';
const DKG = 'https://dkg.network/ontology#';
const PROV = 'http://www.w3.org/ns/prov#';
const SKILL = 'https://dkg.origintrail.io/skill#';

const FOREIGN_PEER = {
  peerId: '12D3KooWHwCJEQ7p5idnD7iQAWyCJHEW7rngKQiXCnEfGef69SV4',
  peerPublicKey: 'eJ1mZqeYaQKe779cgMrFD5sgUFYZzToKnNFEqVA43-8',
} as const;

const TRANSITION: AgentProfileAuthorityTransitionV1 = {
  objectType: 'authority-transition',
  kind: 'agents',
  mode: 'co-signed',
  networkId: 'otp:20430',
  peerId: '12D3KooWJ1TsijH7H5F74hfAD5XishQz3sxrmAtVY37GtNd9CqYf',
  peerPublicKey: 'ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ',
  priorAuthoritySequence: '0',
  nextAuthoritySequence: '1',
  priorHeadDigest: `0x${'55'.repeat(32)}`,
  priorEvmIssuer: '0x677bb7270e0b03f0a2993a697654fb8ecb6dee91',
  nextEvmIssuer: '0x73a4cde3017cf8d642ae6e637f5321ae5f43c985',
  nextRoot: 'did:dkg:agent:0x73a4cde3017cf8d642ae6e637f5321ae5f43c985',
  issuedAt: '2026-08-07T12:00:00Z',
};

describe('system-record V1 public policy helpers', () => {
  it('classifies identical, equivocated, and different authority-transition tuples', () => {
    expect(evaluateAuthorityTransitionConflictV1(TRANSITION, { ...TRANSITION }))
      .toEqual({ decision: 'stale' });

    expect(evaluateAuthorityTransitionConflictV1(TRANSITION, {
      ...TRANSITION,
      issuedAt: '2026-08-07T12:00:01Z',
    })).toEqual({ decision: 'quarantine', reason: 'transition-equivocation' });

    const foreignTuples: readonly Readonly<{
      field: string;
      transition: AgentProfileAuthorityTransitionV1;
    }>[] = [
      { field: 'networkId', transition: { ...TRANSITION, networkId: 'otp:20431' } },
      { field: 'peerId', transition: { ...TRANSITION, ...FOREIGN_PEER } },
      {
        field: 'authority sequence',
        transition: {
          ...TRANSITION,
          priorAuthoritySequence: '1',
          nextAuthoritySequence: '2',
        },
      },
    ];
    for (const { field, transition } of foreignTuples) {
      expect(evaluateAuthorityTransitionConflictV1(TRANSITION, transition), field).toEqual({
        decision: 'reject',
        reason: 'transitions do not target the same authority tuple',
      });
    }

    for (const malformed of [
      { ...TRANSITION, priorAuthoritySequence: '1' },
      { ...TRANSITION, nextAuthoritySequence: '2' },
    ] as const) {
      expect(() => evaluateAuthorityTransitionConflictV1(TRANSITION, malformed))
        .toThrow(/must increment/);
    }
  });

  it('pins the complete allowed predicate set for every owned-subject kind', () => {
    const cases: readonly Readonly<{
      kind: AgentProfileOwnedSubjectKindV1;
      allowed: readonly string[];
      forbidden: string;
    }>[] = [
      {
        kind: 'root',
        allowed: [
          RDF_TYPE,
          `${SCHEMA}name`,
          `${SCHEMA}description`,
          `${DKG}peerId`,
          `${DKG}nodeRole`,
          `${DKG}publicKey`,
          `${DKG}relayAddress`,
          `${DKG}agentAddress`,
          `${DKG}multiaddr`,
          `${DKG}lastSeen`,
          `${DKG}publicEncryptionKey`,
          `${DKG}encryptionKeyAlgorithm`,
          `${DKG}encryptionKeyProof`,
          `${SKILL}framework`,
          ...Object.values(AGENT_PROFILE_LINK_PREDICATES_V1),
        ],
        forbidden: `${PROV}atTime`,
      },
      {
        kind: 'capability',
        allowed: [RDF_TYPE, `${SCHEMA}name`],
        forbidden: `${SKILL}skill`,
      },
      {
        kind: 'offering',
        allowed: [
          RDF_TYPE,
          `${SKILL}skill`,
          `${SKILL}pricePerCall`,
          `${SKILL}currency`,
          `${SKILL}successRate`,
          `${SKILL}pricing`,
        ],
        forbidden: `${PROV}atTime`,
      },
      {
        kind: 'registration',
        allowed: [RDF_TYPE, `${PROV}atTime`],
        forbidden: `${SCHEMA}name`,
      },
      {
        kind: 'hosting',
        allowed: [RDF_TYPE, `${SKILL}contextGraphsServed`, `${SKILL}paranetsServed`],
        forbidden: `${SKILL}pricePerCall`,
      },
      {
        kind: 'x25519',
        allowed: [
          `${DKG}revokedAt`,
          `${DKG}revokedBy`,
          `${DKG}encryptionKeyRevocationProof`,
        ],
        forbidden: RDF_TYPE,
      },
    ];

    for (const { kind, allowed, forbidden } of cases) {
      for (const predicate of allowed) {
        expect(isAllowedAgentProfilePredicateV1(kind, predicate), `${kind}: ${predicate}`)
          .toBe(true);
      }
      expect(isAllowedAgentProfilePredicateV1(kind, forbidden), `${kind} forbidden predicate`)
        .toBe(false);
    }
  });

  it('allows every exported profile link only on the root subject', () => {
    const derivedKinds: readonly AgentProfileOwnedSubjectKindV1[] = [
      'capability',
      'offering',
      'registration',
      'hosting',
      'x25519',
    ];

    for (const predicate of Object.values(AGENT_PROFILE_LINK_PREDICATES_V1)) {
      expect(isAllowedAgentProfilePredicateV1('root', predicate), predicate).toBe(true);
      for (const kind of derivedKinds) {
        expect(isAllowedAgentProfilePredicateV1(kind, predicate), `${kind}: ${predicate}`).toBe(false);
      }
    }
  });
});
