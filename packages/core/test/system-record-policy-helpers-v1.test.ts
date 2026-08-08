import { describe, expect, it } from 'vitest';

import {
  AGENT_PROFILE_LINK_PREDICATES_V1,
  evaluateAuthorityTransitionConflictV1,
  isAllowedAgentProfilePredicateV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileOwnedSubjectKindV1,
} from '../src/system-record-v1.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SCHEMA = 'https://schema.org/';
const DKG = 'https://dkg.network/ontology#';
const ERC8004 = 'https://eips.ethereum.org/erc-8004#';
const PROV = 'http://www.w3.org/ns/prov#';
const SKILL = 'https://dkg.origintrail.io/skill#';

const EXPECTED_AGENT_PROFILE_LINK_PREDICATES_V1 = {
  capability: `${ERC8004}capabilities`,
  offering: `${SKILL}offersSkill`,
  registration: `${PROV}wasGeneratedBy`,
  hosting: `${SKILL}hostingProfile`,
} as const;

const EXPECTED_ALLOWED_PROFILE_PREDICATES_V1 = {
  root: [
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
    ...Object.values(EXPECTED_AGENT_PROFILE_LINK_PREDICATES_V1),
  ],
  capability: [RDF_TYPE, `${SCHEMA}name`],
  offering: [
    RDF_TYPE,
    `${SKILL}skill`,
    `${SKILL}pricePerCall`,
    `${SKILL}currency`,
    `${SKILL}successRate`,
    `${SKILL}pricing`,
  ],
  registration: [RDF_TYPE, `${PROV}atTime`],
  hosting: [RDF_TYPE, `${SKILL}contextGraphsServed`, `${SKILL}paranetsServed`],
  x25519: [
    `${DKG}revokedAt`,
    `${DKG}revokedBy`,
    `${DKG}encryptionKeyRevocationProof`,
  ],
} as const satisfies Readonly<Record<AgentProfileOwnedSubjectKindV1, readonly string[]>>;

const PROFILE_PREDICATE_UNIVERSE_V1 = [
  ...new Set(Object.values(EXPECTED_ALLOWED_PROFILE_PREDICATES_V1).flat()),
];
const UNLISTED_SAME_NAMESPACE_PREDICATES_V1 = [
  `${RDF}value`,
  `${SCHEMA}url`,
  `${DKG}privateKey`,
  `${ERC8004}agentRegistry`,
  `${PROV}used`,
  `${SKILL}endpoint`,
] as const;
const PROFILE_SUBJECT_KINDS_V1 = Object.keys(
  EXPECTED_ALLOWED_PROFILE_PREDICATES_V1,
) as AgentProfileOwnedSubjectKindV1[];

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

  it('pins the exact predicate matrix for every owned-subject kind', () => {
    for (const kind of PROFILE_SUBJECT_KINDS_V1) {
      const allowed = new Set(EXPECTED_ALLOWED_PROFILE_PREDICATES_V1[kind]);
      for (const predicate of PROFILE_PREDICATE_UNIVERSE_V1) {
        expect(isAllowedAgentProfilePredicateV1(kind, predicate), `${kind}: ${predicate}`)
          .toBe(allowed.has(predicate));
      }
      for (const predicate of UNLISTED_SAME_NAMESPACE_PREDICATES_V1) {
        expect(isAllowedAgentProfilePredicateV1(kind, predicate), `${kind}: ${predicate}`)
          .toBe(false);
      }
    }
  });

  it('pins the exported profile link mapping independently', () => {
    expect(AGENT_PROFILE_LINK_PREDICATES_V1)
      .toEqual(EXPECTED_AGENT_PROFILE_LINK_PREDICATES_V1);
  });
});
