/**
 * Protocol metadata that quads from a caller or a peer may not carry: a
 * trust-level row, which the node stamps itself after confirmation, and a
 * subject in a protocol-reserved namespace. Every check compares a term in
 * the form the store writes it (`<iri>` is stored as `iri`).
 */
import type { Quad } from '@origintrail-official/dkg-storage';
import { assertNoUserAuthoredTrustLevelQuads } from '@origintrail-official/dkg-core';
import { ReservedNamespaceError } from './errors.js';
import { assertNoUserAuthoredKnowledgeAssetSkolemTerms } from './ka-skolemization.js';
import { findReservedSubjectPrefix } from './reserved-subjects.js';

// Round 14 Bug 41: case-insensitive check against `RESERVED_SUBJECT_PREFIXES`.
// Per RFC 8141 §3.1, the URN scheme (`urn:`) and NID (`dkg`) are
// case-insensitive for equivalence purposes — `URN:dkg:file:abc`,
// `urn:DKG:file:abc`, and `urn:dkg:file:abc` are all the same resource.
// The NSS portion is case-sensitive by default but our reserved
// prefixes (`urn:dkg:file:`, `urn:dkg:extraction:`) are entirely
// within the scheme+NID range, so lowercase-then-startsWith on the
// full subject string is the correct comparison: it accepts all
// case variants of the scheme/NID without over-matching into
// NSS-level content.
//
// Earlier rounds used a byte-level `subject.startsWith(prefix)` check
// at both the Bucket A write-boundary guard (Round 9 Bug 25) AND the
// Round 4 promote-time filter (Round 12 Bug 35 SSOT). Both were
// case-sensitive. The fix replaces both byte-level comparisons with the
// shared case-insensitive helper from `reserved-subjects.ts`, preserving
// the SSOT property established in Round 12.
export function rejectReservedSubjectPrefixes(quads: readonly Pick<Quad, 'subject'>[]): void {
  for (const q of quads) {
    const prefix = findReservedSubjectPrefix(q.subject);
    if (prefix !== undefined) throw new ReservedNamespaceError(q.subject, prefix);
  }
}

/** The write guard for local callers: reserved subjects, KA-skolem terms and trust-level rows. */
export function rejectUserAuthoredProtocolMetadata(quads: Quad[]): void {
  rejectReservedSubjectPrefixes(quads);
  assertNoUserAuthoredKnowledgeAssetSkolemTerms(quads);
  assertNoUserAuthoredTrustLevelQuads(quads);
}

/**
 * The check for quads a peer sent: trust-level rows and reserved subjects.
 * The KA-skolem namespace is left to the graph-scoped validators, which
 * accept the canonical terms graph-scoped senders use. Returns `quads` for
 * inline use.
 */
export function assertNoReceivedProtocolMetadata<Q extends Pick<Quad, 'subject' | 'predicate'>>(quads: Q[]): Q[] {
  rejectReservedSubjectPrefixes(quads);
  assertNoUserAuthoredTrustLevelQuads(quads);
  return quads;
}
