import { createHash } from 'node:crypto';

const ROOT_RE = /^did:dkg:agent:0x[0-9a-f]{40}$/;
const X25519_RE = /#x25519-[0-9a-f]{32}$/;

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
  return ROOT_RE.test(rootSubject)
    ? classifyProfileSubjectShapeV1(rootSubject, subject)
    : null;
}

export function isCanonicalProfileRootV1(rootSubject: string): boolean {
  return ROOT_RE.test(rootSubject);
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
): string {
  const kind = classifyProfileSubjectShapeV1(rootSubject, subject);
  if (kind === null) throw new TypeError('profile subject is outside the frozen owned grammar');
  if (kind === 'root') return redactedRootSubject;
  if (kind === 'x25519') {
    return `${redactedRootSubject}#x25519-${sha256Hex(subject).slice(0, 32)}`;
  }
  return `${redactedRootSubject}${subject.slice(rootSubject.length)}`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
