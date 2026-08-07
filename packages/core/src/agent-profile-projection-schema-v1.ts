import { decodeWorkspaceEncryptionKey } from './crypto/workspace-encryption.js';
import { assertSafeIri, assertSafeRdfTerm, isSafeIri } from './sparql-safe.js';
import {
  AGENT_PROFILE_LINK_PREDICATES_V1,
  assertDerivedAgentEncryptionSubjectV1,
  assertOwnedSubjectTableObjectV1,
  classifyAgentProfileOwnedSubjectV1,
  isAllowedAgentProfilePredicateV1,
  type AgentProfileHeadCommonV1,
  type AgentProfileOwnedSubjectKindV1,
  type OwnedSubjectTableObjectV1,
} from './system-record-objects-v1.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DKG = 'https://dkg.network/ontology#';
const ERC8004 = 'https://eips.ethereum.org/erc-8004#';
const PROV = 'http://www.w3.org/ns/prov#';
const SKILL = 'https://dkg.origintrail.io/skill#';

const IRI_OBJECT_PREDICATES = new Set<string>([
  RDF_TYPE,
  ...Object.values(AGENT_PROFILE_LINK_PREDICATES_V1),
  `${SKILL}skill`,
  `${SKILL}pricing`,
  `${DKG}revokedBy`,
]);
const PUBLIC_ENCRYPTION_KEY = `${DKG}publicEncryptionKey`;
const ALLOWED_TYPE_OBJECTS: Readonly<
  Record<AgentProfileOwnedSubjectKindV1, ReadonlySet<string>>
> = Object.freeze({
  root: new Set([`${DKG}Agent`, `${DKG}CoreNode`, `${DKG}EdgeNode`]),
  capability: new Set([`${ERC8004}Capability`]),
  offering: new Set([`${SKILL}SkillOffering`]),
  registration: new Set([`${PROV}Activity`]),
  hosting: new Set([`${SKILL}HostingProfile`]),
  x25519: new Set<string>(),
});

export interface AgentProfileProjectionQuadV1 {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly graph: string;
}

export interface AgentProfileIdentityFactsInputV1 {
  readonly rootSubject: string;
  readonly peerId: string;
  /** Standard padded base64, matching the existing profile RDF contract. */
  readonly publicKey?: string;
  readonly agentAddress?: string;
}

export interface AgentProfileIdentityFactV1 {
  readonly predicate: string;
  readonly object: string;
}

export interface AgentProfileIdentityFactsV1 {
  readonly rootSubject: string;
  readonly peerId: AgentProfileIdentityFactV1;
  readonly publicKey?: AgentProfileIdentityFactV1;
  readonly agentAddress?: AgentProfileIdentityFactV1;
}

/** Canonical RDF identity facts shared by profile authors and verified materializers. */
export function agentProfileIdentityFactsV1(
  input: AgentProfileIdentityFactsInputV1,
): AgentProfileIdentityFactsV1 {
  return Object.freeze({
    rootSubject: input.rootSubject,
    peerId: Object.freeze({ predicate: `${DKG}peerId`, object: `"${input.peerId}"` }),
    ...(input.publicKey === undefined ? {} : {
      publicKey: Object.freeze({ predicate: `${DKG}publicKey`, object: `"${input.publicKey}"` }),
    }),
    ...(input.agentAddress === undefined ? {} : {
      agentAddress: Object.freeze({
        predicate: `${DKG}agentAddress`,
        object: `"${input.agentAddress}"`,
      }),
    }),
  });
}

/** Bind projection identity facts to the authority already authenticated by the signed head. */
export function assertAgentProfileProjectionIdentityV1(
  head: Pick<AgentProfileHeadCommonV1,
    'rootSubject' | 'peerId' | 'peerPublicKey' | 'evmIssuer'>,
  quads: readonly Readonly<AgentProfileProjectionQuadV1>[],
): void {
  if (head.rootSubject !== `did:dkg:agent:${head.evmIssuer}`) {
    throw new Error('profile projection does not bind the signed root identity');
  }
  const identity = agentProfileIdentityFactsV1({
    rootSubject: head.rootSubject,
    peerId: head.peerId,
    publicKey: Buffer.from(head.peerPublicKey, 'base64url').toString('base64'),
    agentAddress: head.evmIssuer,
  });
  const expected = [
    ['peerId', identity.peerId],
    ['agentAddress', identity.agentAddress],
    ['publicKey', identity.publicKey],
  ] as const;
  for (const [field, fact] of expected) {
    if (fact === undefined) throw new Error(`signed profile ${field} is unavailable`);
    const advertised = quads.filter((quad) =>
      quad.subject === head.rootSubject && quad.predicate === fact.predicate);
    if (advertised.length !== 1 || advertised[0]?.object !== fact.object) {
      throw new Error(`profile projection does not bind the signed ${field}`);
    }
  }
}

/** Frozen V1 RDF schema shared by profile authors and verified materializers. */
export function assertAgentProfileProjectionSchemaV1(
  rootSubject: string,
  ownedSubjectTable: OwnedSubjectTableObjectV1,
  quads: readonly Readonly<AgentProfileProjectionQuadV1>[],
): void {
  assertOwnedSubjectTableObjectV1(rootSubject, ownedSubjectTable);
  const linked = new Set<string>();
  const seenSubjects = new Set<string>();
  const ownedSubjects = new Set(ownedSubjectTable);
  const publicKeys: Uint8Array[] = [];
  for (const [index, quad] of quads.entries()) {
    if (!isSafeIri(quad.subject) || !isSafeIri(quad.predicate)) {
      throw new Error(`profile projection quad ${index} has an invalid subject or predicate IRI`);
    }
    assertSafeIri(quad.subject);
    assertSafeIri(quad.predicate);
    if (!ownedSubjects.has(quad.subject)) {
      throw new Error(`profile projection quad ${index} has an unowned subject`);
    }
    const subjectKind = classifyAgentProfileOwnedSubjectV1(rootSubject, quad.subject);
    if (subjectKind === null || !isAllowedAgentProfilePredicateV1(subjectKind, quad.predicate)) {
      throw new Error(`profile projection quad ${index} uses a disallowed profile predicate`);
    }
    const objectIsLiteral = quad.object.startsWith('"');
    if (objectIsLiteral) assertSafeRdfTerm(quad.object);
    else if (!isSafeIri(quad.object)) {
      throw new Error(`profile projection quad ${index} has a noncanonical object IRI`);
    } else assertSafeIri(quad.object);
    if (quad.graph !== '') throw new Error('profile projections must be graphless');
    seenSubjects.add(quad.subject);
    if (IRI_OBJECT_PREDICATES.has(quad.predicate) === objectIsLiteral) {
      throw new Error('profile projection predicate has an invalid object term kind');
    }
    if (quad.predicate === RDF_TYPE && !ALLOWED_TYPE_OBJECTS[subjectKind].has(quad.object)) {
      throw new Error('profile projection rdf:type object is outside the frozen profile schema');
    }
    if (quad.subject === rootSubject) {
      const linkKind = Object.entries(AGENT_PROFILE_LINK_PREDICATES_V1)
        .find(([, predicate]) => predicate === quad.predicate)?.[0] as
          | Exclude<AgentProfileOwnedSubjectKindV1, 'root' | 'x25519'>
          | undefined;
      if (linkKind !== undefined) {
        if (objectIsLiteral || !ownedSubjects.has(quad.object)
          || classifyAgentProfileOwnedSubjectV1(rootSubject, quad.object) !== linkKind) {
          throw new Error('profile link does not target its exact derived-subject kind');
        }
        linked.add(quad.object);
      }
      if (quad.predicate === PUBLIC_ENCRYPTION_KEY) {
        const match = /^"([A-Za-z0-9_-]{43})"$/.exec(quad.object);
        if (match === null) throw new Error('profile public encryption key is not canonical');
        try {
          publicKeys.push(decodeWorkspaceEncryptionKey(match[1]));
        } catch (cause) {
          throw new Error('profile public encryption key is invalid', { cause });
        }
      }
    }
    if (subjectKind === 'x25519' && quad.predicate === `${DKG}revokedBy`
      && quad.object !== rootSubject) {
      throw new Error('x25519 revocation does not bind the profile root');
    }
  }
  for (const subject of ownedSubjectTable) {
    if (!seenSubjects.has(subject)) {
      throw new Error('owned-subject table contains a subject absent from the projection');
    }
    const kind = classifyAgentProfileOwnedSubjectV1(rootSubject, subject);
    if (kind === 'capability' || kind === 'offering' || kind === 'registration' || kind === 'hosting') {
      if (!linked.has(subject)) throw new Error('derived profile subject is not linked from the root');
    } else if (kind === 'x25519') {
      const derived = publicKeys.some((key) => {
        try {
          assertDerivedAgentEncryptionSubjectV1(rootSubject, subject, key);
          return true;
        } catch {
          return false;
        }
      });
      if (!derived) throw new Error('x25519 subject is not derived from a profile public key');
    }
  }
}
