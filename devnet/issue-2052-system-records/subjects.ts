const ROOT_RE = /^did:dkg:agent:0x[0-9a-f]{40}$/;
const X25519_RE = /#x25519-[0-9a-f]{32}$/;
const RECORD_ALIAS_RE = /^record:([0-9]{4,})$/;
const PEER_ALIAS_RE = /^peer:([0-9]{4,})$/;
const FIXTURE_X25519_RE = /#fixture-x25519-([0-9]{4,})$/;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA = 'https://schema.org/';
const DKG = 'https://dkg.network/ontology#';
const ERC8004 = 'https://eips.ethereum.org/erc-8004#';
const PROV = 'http://www.w3.org/ns/prov#';
const SKILL = 'https://dkg.origintrail.io/skill#';

export type OwnedProfileSubjectKindV1 =
  | 'root'
  | 'capability'
  | 'offering'
  | 'registration'
  | 'hosting'
  | 'x25519';

export const PROFILE_LINK_PREDICATES_V1 = Object.freeze({
  capability: `${ERC8004}capabilities`,
  offering: `${SKILL}offersSkill`,
  registration: `${PROV}wasGeneratedBy`,
  hosting: `${SKILL}hostingProfile`,
} as const);
const PROFILE_LINK_PREDICATE_SET_V1: ReadonlySet<string> = new Set(
  Object.values(PROFILE_LINK_PREDICATES_V1),
);

const ALLOWED_PROFILE_PREDICATES_V1: Readonly<
  Record<OwnedProfileSubjectKindV1, ReadonlySet<string>>
> = {
  root: new Set([
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
    ...Object.values(PROFILE_LINK_PREDICATES_V1),
  ]),
  capability: new Set([RDF_TYPE, `${SCHEMA}name`]),
  offering: new Set([
    RDF_TYPE,
    `${SKILL}skill`,
    `${SKILL}pricePerCall`,
    `${SKILL}currency`,
    `${SKILL}successRate`,
    `${SKILL}pricing`,
  ]),
  registration: new Set([RDF_TYPE, `${PROV}atTime`]),
  hosting: new Set([
    RDF_TYPE,
    `${SKILL}contextGraphsServed`,
    // Existing active testnet profiles still carry the pre-rename predicate.
    `${SKILL}paranetsServed`,
  ]),
  x25519: new Set([
    `${DKG}revokedAt`,
    `${DKG}revokedBy`,
    `${DKG}encryptionKeyRevocationProof`,
  ]),
};

/** Exact subject grammar independent of whether the source root is canonical. */
export function classifyProfileSubjectShapeV1(
  rootSubject: string,
  subject: string,
): OwnedProfileSubjectKindV1 | null {
  if (subject === rootSubject) return 'root';
  const escapedRoot = escapeRegex(rootSubject);
  if (new RegExp(`^${escapedRoot}/\\.well-known/genid/cap[1-9][0-9]*$`).test(subject)) {
    return 'capability';
  }
  if (new RegExp(`^${escapedRoot}/\\.well-known/genid/offering[1-9][0-9]*$`).test(subject)) {
    return 'offering';
  }
  if (subject === `${rootSubject}/.well-known/genid/registration`) return 'registration';
  if (subject === `${rootSubject}/.well-known/genid/hosting`) return 'hosting';
  if (subject.startsWith(`${rootSubject}#x25519-`) && X25519_RE.test(subject)) return 'x25519';
  return null;
}

export function classifyOwnedSubjectV1(
  rootSubject: string,
  subject: string,
): OwnedProfileSubjectKindV1 | null {
  if (!ROOT_RE.test(rootSubject)) return null;
  if (subject === rootSubject) return 'root';
  const sourceKind = classifyProfileSubjectShapeV1(rootSubject, subject);
  if (sourceKind !== 'x25519') return sourceKind;
  return null;
}

export function isCanonicalProfileRootV1(rootSubject: string): boolean {
  return ROOT_RE.test(rootSubject);
}

export function expectedRedactedProfileRootV1(recordId: string): string | null {
  const ordinal = canonicalAliasOrdinal(recordId, RECORD_ALIAS_RE);
  return ordinal === null
    ? null
    : `did:dkg:agent:0x${ordinal.toString(16).padStart(40, '0')}`;
}

export function isCanonicalPeerAliasV1(peerKey: string): boolean {
  return canonicalAliasOrdinal(peerKey, PEER_ALIAS_RE) !== null;
}

export function peerAliasOrdinalV1(peerKey: string): number | null {
  return canonicalAliasOrdinal(peerKey, PEER_ALIAS_RE);
}

export function redactedX25519SubjectV1(rootSubject: string, ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new TypeError('x25519 alias ordinal must be a positive safe integer');
  }
  return `${rootSubject}#fixture-x25519-${String(ordinal).padStart(4, '0')}`;
}

export function classifyRedactedOwnedSubjectV1(
  rootSubject: string,
  subject: string,
): OwnedProfileSubjectKindV1 | null {
  const kind = classifyOwnedSubjectV1(rootSubject, subject);
  if (kind !== null) return kind;
  if (!subject.startsWith(`${rootSubject}#fixture-x25519-`)) return null;
  const suffix = subject.slice(rootSubject.length);
  return canonicalAliasOrdinal(suffix, FIXTURE_X25519_RE) === null ? null : 'x25519';
}

export function isAllowedProfilePredicateV1(
  kind: OwnedProfileSubjectKindV1,
  predicate: string,
): boolean {
  return ALLOWED_PROFILE_PREDICATES_V1[kind].has(predicate);
}

export function expectedProfileLinkPredicateV1(
  kind: OwnedProfileSubjectKindV1,
): string | null {
  if (kind === 'capability' || kind === 'offering' || kind === 'registration' || kind === 'hosting') {
    return PROFILE_LINK_PREDICATES_V1[kind];
  }
  return null;
}

export function isAllowedOwnedObjectRelationshipV1(
  rootSubject: string,
  subject: string,
  predicate: string,
  objectOwnedSubject: string,
): boolean {
  const objectKind = classifyRedactedOwnedSubjectV1(rootSubject, objectOwnedSubject);
  if (
    objectKind === 'capability'
    || objectKind === 'offering'
    || objectKind === 'registration'
    || objectKind === 'hosting'
  ) {
    return subject === rootSubject && expectedProfileLinkPredicateV1(objectKind) === predicate;
  }
  return objectKind === 'root'
    && classifyRedactedOwnedSubjectV1(rootSubject, subject) === 'x25519'
    && predicate === `${DKG}revokedBy`;
}

export function requiresOwnedObjectRelationshipV1(
  subjectKind: OwnedProfileSubjectKindV1,
  predicate: string,
): boolean {
  return (subjectKind === 'root' && PROFILE_LINK_PREDICATE_SET_V1.has(predicate))
    || (subjectKind === 'x25519' && predicate === `${DKG}revokedBy`);
}

/** Prefixes used only to bound the source query; exact admission uses the classifier above. */
export function profileNestedQueryPrefixesV1(rootSubject: string): readonly [string, string] {
  return [`${rootSubject}/.well-known/`, `${rootSubject}#x25519-`];
}

export function findProfileSubjectOwnerV1(
  roots: readonly string[],
  subject: string,
): string | null {
  return roots.find((root) => classifyProfileSubjectShapeV1(root, subject) !== null) ?? null;
}

/** Fail-closed redaction: unknown subject shapes never cross the serialization boundary. */
export function redactProfileSubjectV1(
  rootSubject: string,
  redactedRootSubject: string,
  subject: string,
  x25519Ordinal?: number,
): string {
  const kind = classifyProfileSubjectShapeV1(rootSubject, subject);
  if (kind === null) throw new TypeError('profile subject is outside the frozen owned grammar');
  if (kind === 'root') return redactedRootSubject;
  if (kind === 'x25519') {
    if (x25519Ordinal === undefined) {
      throw new TypeError('x25519 source subjects require a fixture-local ordinal');
    }
    return redactedX25519SubjectV1(redactedRootSubject, x25519Ordinal);
  }
  return `${redactedRootSubject}${subject.slice(rootSubject.length)}`;
}

function canonicalAliasOrdinal(value: string, pattern: RegExp): number | null {
  const match = pattern.exec(value);
  if (!match) return null;
  const ordinal = Number(match[1]);
  return Number.isSafeInteger(ordinal)
    && ordinal >= 1
    && match[1] === String(ordinal).padStart(4, '0')
    ? ordinal
    : null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
