import { SYSTEM_RECORD_OBJECT_CAPS_V1 } from './system-record-limits-v1.js';

export type AgentProfileOwnedSubjectKindV1 =
  | 'root'
  | 'capability'
  | 'offering'
  | 'registration'
  | 'hosting'
  | 'x25519';

export type AgentProfileLinkedSubjectKindV1 = Exclude<
  AgentProfileOwnedSubjectKindV1,
  'root' | 'x25519'
>;
export type AgentProfileIndexedSubjectKindV1 = 'capability' | 'offering';
export type AgentProfileExactLinkedSubjectKindV1 = 'registration' | 'hosting';

export type AgentProfilePredicatePolicyV1 =
  | Readonly<{ readonly predicate: string; readonly objectPolicy: 'literal' }>
  | Readonly<{ readonly predicate: string; readonly objectPolicy: 'iri' }>
  | Readonly<{
      readonly predicate: string;
      readonly objectPolicy: 'allowed-iri';
      readonly allowedObjects: readonly string[];
    }>
  | Readonly<{
      readonly predicate: string;
      readonly objectPolicy: 'owned-subject-link';
      readonly linkTargetKind: AgentProfileLinkedSubjectKindV1;
    }>
  | Readonly<{
      readonly predicate: string;
      readonly objectPolicy: 'profile-root-iri';
    }>
  | Readonly<{
      readonly predicate: string;
      readonly objectPolicy: 'workspace-public-key';
    }>;

export type AgentProfileSubjectShapeV1 =
  | Readonly<{ readonly type: 'root' }>
  | Readonly<{ readonly type: 'indexed-genid'; readonly prefix: string }>
  | Readonly<{ readonly type: 'exact-genid'; readonly suffix: string }>
  | Readonly<{
      readonly type: 'hex-fragment';
      readonly prefix: string;
      readonly hexLength: number;
    }>;

export interface AgentProfileSubjectPolicyV1 {
  readonly kind: AgentProfileOwnedSubjectKindV1;
  readonly subjectShape: AgentProfileSubjectShapeV1;
  readonly predicates: readonly Readonly<AgentProfilePredicatePolicyV1>[];
  readonly rootLinkPredicate?: string;
  readonly derivation?: 'workspace-public-key';
}

type AgentProfileSubjectPolicyForV1<Kind extends AgentProfileOwnedSubjectKindV1> = Readonly<
  Omit<AgentProfileSubjectPolicyV1, 'kind'> & { readonly kind: Kind }
>;

type AgentProfileSubjectPolicyTableV1 = {
  readonly [Kind in AgentProfileOwnedSubjectKindV1]: AgentProfileSubjectPolicyForV1<Kind>;
};

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SCHEMA = 'https://schema.org/';
const DKG = 'https://dkg.network/ontology#';
const ERC8004 = 'https://eips.ethereum.org/erc-8004#';
const PROV = 'http://www.w3.org/ns/prov#';
const SKILL = 'https://dkg.origintrail.io/skill#';

/** Named V1 terms used by both profile authors and verifiers. */
export const AGENT_PROFILE_SCHEMA_TERMS_V1 = Object.freeze({
  skillNamespace: SKILL,
  rdfType: `${RDF}type`,
  schemaName: `${SCHEMA}name`,
  schemaDescription: `${SCHEMA}description`,
  dkgAgent: `${DKG}Agent`,
  dkgCoreNode: `${DKG}CoreNode`,
  dkgEdgeNode: `${DKG}EdgeNode`,
  dkgPeerId: `${DKG}peerId`,
  dkgNodeRole: `${DKG}nodeRole`,
  dkgPublicKey: `${DKG}publicKey`,
  dkgRelayAddress: `${DKG}relayAddress`,
  dkgAgentAddress: `${DKG}agentAddress`,
  dkgMultiaddr: `${DKG}multiaddr`,
  dkgLastSeen: `${DKG}lastSeen`,
  dkgPublicEncryptionKey: `${DKG}publicEncryptionKey`,
  dkgEncryptionKeyAlgorithm: `${DKG}encryptionKeyAlgorithm`,
  dkgEncryptionKeyProof: `${DKG}encryptionKeyProof`,
  dkgRevokedAt: `${DKG}revokedAt`,
  dkgRevokedBy: `${DKG}revokedBy`,
  dkgEncryptionKeyRevocationProof: `${DKG}encryptionKeyRevocationProof`,
  erc8004Capabilities: `${ERC8004}capabilities`,
  erc8004Capability: `${ERC8004}Capability`,
  provWasGeneratedBy: `${PROV}wasGeneratedBy`,
  provActivity: `${PROV}Activity`,
  provAtTime: `${PROV}atTime`,
  skillFramework: `${SKILL}framework`,
  skillOffersSkill: `${SKILL}offersSkill`,
  skillSkillOffering: `${SKILL}SkillOffering`,
  skillSkill: `${SKILL}skill`,
  skillPricePerCall: `${SKILL}pricePerCall`,
  skillCurrency: `${SKILL}currency`,
  skillSuccessRate: `${SKILL}successRate`,
  skillPricing: `${SKILL}pricing`,
  skillHostingProfile: `${SKILL}hostingProfile`,
  skillHostingProfileType: `${SKILL}HostingProfile`,
  skillContextGraphsServed: `${SKILL}contextGraphsServed`,
  skillParanetsServed: `${SKILL}paranetsServed`,
} as const);

const T = AGENT_PROFILE_SCHEMA_TERMS_V1;

export const AGENT_PROFILE_LINK_PREDICATES_V1 = Object.freeze({
  capability: T.erc8004Capabilities,
  offering: T.skillOffersSkill,
  registration: T.provWasGeneratedBy,
  hosting: T.skillHostingProfile,
} as const);

function literal(predicate: string): Readonly<AgentProfilePredicatePolicyV1> {
  return Object.freeze({ predicate, objectPolicy: 'literal' as const });
}

function iri(predicate: string): Readonly<AgentProfilePredicatePolicyV1> {
  return Object.freeze({ predicate, objectPolicy: 'iri' as const });
}

function allowedIri(
  predicate: string,
  allowedObjects: readonly string[],
): Readonly<AgentProfilePredicatePolicyV1> {
  return Object.freeze({
    predicate,
    objectPolicy: 'allowed-iri' as const,
    allowedObjects: Object.freeze([...allowedObjects]),
  });
}

function ownedSubjectLink(
  predicate: string,
  linkTargetKind: AgentProfileLinkedSubjectKindV1,
): Readonly<AgentProfilePredicatePolicyV1> {
  return Object.freeze({
    predicate,
    objectPolicy: 'owned-subject-link' as const,
    linkTargetKind,
  });
}

function profileRootIri(predicate: string): Readonly<AgentProfilePredicatePolicyV1> {
  return Object.freeze({ predicate, objectPolicy: 'profile-root-iri' as const });
}

function workspacePublicKey(predicate: string): Readonly<AgentProfilePredicatePolicyV1> {
  return Object.freeze({ predicate, objectPolicy: 'workspace-public-key' as const });
}

function subjectPolicy<const Kind extends AgentProfileOwnedSubjectKindV1>(
  policy: AgentProfileSubjectPolicyForV1<Kind>,
): AgentProfileSubjectPolicyForV1<Kind> {
  return Object.freeze({
    ...policy,
    subjectShape: Object.freeze({ ...policy.subjectShape }),
    predicates: Object.freeze([...policy.predicates]),
  });
}

const SUBJECT_POLICY_BY_KIND = Object.freeze({
  root: subjectPolicy({
    kind: 'root',
    subjectShape: { type: 'root' },
    predicates: [
      allowedIri(T.rdfType, [T.dkgAgent, T.dkgCoreNode, T.dkgEdgeNode]),
      literal(T.schemaName),
      literal(T.schemaDescription),
      literal(T.dkgPeerId),
      literal(T.dkgNodeRole),
      literal(T.dkgPublicKey),
      literal(T.dkgRelayAddress),
      literal(T.dkgAgentAddress),
      literal(T.dkgMultiaddr),
      literal(T.dkgLastSeen),
      workspacePublicKey(T.dkgPublicEncryptionKey),
      literal(T.dkgEncryptionKeyAlgorithm),
      literal(T.dkgEncryptionKeyProof),
      literal(T.skillFramework),
      ownedSubjectLink(T.erc8004Capabilities, 'capability'),
      ownedSubjectLink(T.skillOffersSkill, 'offering'),
      ownedSubjectLink(T.provWasGeneratedBy, 'registration'),
      ownedSubjectLink(T.skillHostingProfile, 'hosting'),
    ],
  }),
  capability: subjectPolicy({
    kind: 'capability',
    subjectShape: { type: 'indexed-genid', prefix: 'cap' },
    rootLinkPredicate: T.erc8004Capabilities,
    predicates: [
      allowedIri(T.rdfType, [T.erc8004Capability]),
      literal(T.schemaName),
    ],
  }),
  offering: subjectPolicy({
    kind: 'offering',
    subjectShape: { type: 'indexed-genid', prefix: 'offering' },
    rootLinkPredicate: T.skillOffersSkill,
    predicates: [
      allowedIri(T.rdfType, [T.skillSkillOffering]),
      iri(T.skillSkill),
      literal(T.skillPricePerCall),
      literal(T.skillCurrency),
      literal(T.skillSuccessRate),
      iri(T.skillPricing),
    ],
  }),
  registration: subjectPolicy({
    kind: 'registration',
    subjectShape: { type: 'exact-genid', suffix: 'registration' },
    rootLinkPredicate: T.provWasGeneratedBy,
    predicates: [
      allowedIri(T.rdfType, [T.provActivity]),
      literal(T.provAtTime),
    ],
  }),
  hosting: subjectPolicy({
    kind: 'hosting',
    subjectShape: { type: 'exact-genid', suffix: 'hosting' },
    rootLinkPredicate: T.skillHostingProfile,
    predicates: [
      allowedIri(T.rdfType, [T.skillHostingProfileType]),
      literal(T.skillContextGraphsServed),
      literal(T.skillParanetsServed),
    ],
  }),
  x25519: subjectPolicy({
    kind: 'x25519',
    subjectShape: { type: 'hex-fragment', prefix: 'x25519-', hexLength: 32 },
    derivation: 'workspace-public-key',
    predicates: [
      literal(T.dkgRevokedAt),
      profileRootIri(T.dkgRevokedBy),
      literal(T.dkgEncryptionKeyRevocationProof),
    ],
  }),
} satisfies AgentProfileSubjectPolicyTableV1);

const SUBJECT_POLICIES = Object.freeze(Object.values(SUBJECT_POLICY_BY_KIND));

const ROOT_PATTERN = /^did:dkg:agent:(0x[0-9a-f]{40})$/;
const PREDICATE_POLICY_BY_KIND = new Map(
  SUBJECT_POLICIES.map((policy) => [
    policy.kind,
    new Map(policy.predicates.map((predicate) => [predicate.predicate, predicate])),
  ]),
);

export function matchAgentProfileRootAddressV1(value: string): string | null {
  return ROOT_PATTERN.exec(value)?.[1] ?? null;
}

export function agentProfileSubjectPolicyV1(
  kind: AgentProfileOwnedSubjectKindV1,
): Readonly<AgentProfileSubjectPolicyV1> {
  return SUBJECT_POLICY_BY_KIND[kind];
}

export function agentProfilePredicatePolicyV1(
  kind: AgentProfileOwnedSubjectKindV1,
  predicate: string,
): Readonly<AgentProfilePredicatePolicyV1> | undefined {
  return PREDICATE_POLICY_BY_KIND.get(kind)?.get(predicate);
}

export function deriveAgentProfileOwnedSubjectV1(
  rootSubject: string,
  kind: AgentProfileIndexedSubjectKindV1,
  ordinal: number,
): string;
export function deriveAgentProfileOwnedSubjectV1(
  rootSubject: string,
  kind: AgentProfileExactLinkedSubjectKindV1,
): string;
export function deriveAgentProfileOwnedSubjectV1(
  rootSubject: string,
  kind: AgentProfileLinkedSubjectKindV1,
  ordinal?: number,
): string {
  const shape = agentProfileSubjectPolicyV1(kind).subjectShape;
  if (shape.type === 'indexed-genid') {
    if (!Number.isSafeInteger(ordinal) || ordinal === undefined || ordinal < 1) {
      throw new RangeError(`profile ${kind} subject ordinal must be a positive safe integer`);
    }
    return `${rootSubject}/.well-known/genid/${shape.prefix}${ordinal}`;
  }
  if (shape.type === 'exact-genid') {
    if (ordinal !== undefined) throw new TypeError(`profile ${kind} subject does not use an ordinal`);
    return `${rootSubject}/.well-known/genid/${shape.suffix}`;
  }
  throw new TypeError(`profile ${kind} subject does not use a derived linked-subject shape`);
}

export function classifyAgentProfileOwnedSubjectV1(
  rootSubject: string,
  subject: string,
): AgentProfileOwnedSubjectKindV1 | null {
  if (typeof rootSubject !== 'string' || typeof subject !== 'string'
    || rootSubject.length > SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table']
    || subject.length > SYSTEM_RECORD_OBJECT_CAPS_V1['owned-subject-table']
    || matchAgentProfileRootAddressV1(rootSubject) === null) return null;
  const genidPrefix = `${rootSubject}/.well-known/genid/`;
  const fragmentPrefix = `${rootSubject}#`;
  for (const policy of SUBJECT_POLICIES) {
    const shape = policy.subjectShape;
    if (shape.type === 'root') {
      if (subject === rootSubject) return policy.kind;
      continue;
    }
    if (shape.type === 'indexed-genid') {
      if (!subject.startsWith(genidPrefix)) continue;
      const suffix = subject.slice(genidPrefix.length);
      if (suffix.startsWith(shape.prefix)
        && /^[1-9][0-9]*$/.test(suffix.slice(shape.prefix.length))) return policy.kind;
      continue;
    }
    if (shape.type === 'exact-genid') {
      if (subject === `${genidPrefix}${shape.suffix}`) return policy.kind;
      continue;
    }
    if (!subject.startsWith(`${fragmentPrefix}${shape.prefix}`)) continue;
    const suffix = subject.slice(fragmentPrefix.length + shape.prefix.length);
    if (suffix.length === shape.hexLength && /^[0-9a-f]+$/.test(suffix)) return policy.kind;
  }
  return null;
}

export function isAllowedAgentProfilePredicateV1(
  kind: AgentProfileOwnedSubjectKindV1,
  predicate: string,
): boolean {
  return agentProfilePredicatePolicyV1(kind, predicate) !== undefined;
}
