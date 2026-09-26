// SPDX-License-Identifier: Apache-2.0

import {
  DKG_ONTOLOGY,
  assertSafeIri,
  contextGraphDataGraphUri,
  sparqlString,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { stripLiteral } from './dkg-agent-utils.js';

/**
 * Proof that a join-approved member is usable in a curator's root `_meta`
 * snapshot: listed, not revoked, and holding an active delegation bound to
 * this node. It is policy-neutral: the private definition requires it, and a
 * public definition requires it after a join approval. Both the in-memory
 * check and the store ASK fragment are built from this one model.
 */

const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

export interface ApprovedMemberProof {
  /** The locally-approved agent whose usable membership must be present. */
  approvedAgentAddress: string;
  /** Current node credentials; at least one must match the active delegation. */
  expectedDelegateePeerId?: string;
  expectedDelegateeOpKey?: string;
  /** Injectable wall clock for parity tests. Defaults to Date.now(). */
  nowMs?: number;
}

interface NormalizedMemberProof {
  approvedAgentAddress: string;
  expectedDelegateePeerId?: string;
  expectedDelegateeOpKey?: string;
  nowMs: number;
}

function normalizeMemberProof(
  proof: ApprovedMemberProof,
): NormalizedMemberProof | undefined {
  const approvedAgentAddress = proof.approvedAgentAddress.trim().toLowerCase();
  const expectedDelegateePeerId = proof.expectedDelegateePeerId?.trim() || undefined;
  const expectedDelegateeOpKey = proof.expectedDelegateeOpKey?.trim().toLowerCase() || undefined;
  const nowMs = proof.nowMs ?? Date.now();
  if (
    !EVM_ADDRESS_RE.test(approvedAgentAddress) ||
    (expectedDelegateeOpKey !== undefined && !EVM_ADDRESS_RE.test(expectedDelegateeOpKey)) ||
    (!expectedDelegateePeerId && !expectedDelegateeOpKey) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0
  ) {
    return undefined;
  }
  return {
    approvedAgentAddress,
    expectedDelegateePeerId,
    expectedDelegateeOpKey,
    nowMs,
  };
}

function literalEqualsIgnoreCase(value: string, expected: string): boolean {
  return value.startsWith('"') && stripLiteral(value).trim().toLowerCase() === expected;
}

/**
 * Whether a fetched root `_meta` snapshot proves the approved member: it is in
 * `allowedAgent`, not revoked, and holds an active delegation bound to this
 * node's peer id or op-key. Shared by the private definition and by a public
 * definition accepted after a join approval.
 */
export function hasActiveApprovedMemberDelegation(
  contextGraphId: string,
  quads: readonly Quad[],
  rawProof: ApprovedMemberProof,
): boolean {
  const proof = normalizeMemberProof(rawProof);
  if (!proof) return false;
  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  const delegationSubject =
    `did:dkg:agent-delegation:${contextGraphId}:${proof.approvedAgentAddress}`;
  const allowed = quads.some((quad) => (
    quad.subject === contextGraphUri &&
    quad.predicate === DKG_ONTOLOGY.DKG_ALLOWED_AGENT &&
    literalEqualsIgnoreCase(quad.object, proof.approvedAgentAddress)
  ));
  const revoked = quads.some((quad) => (
    quad.subject === contextGraphUri &&
    quad.predicate === DKG_ONTOLOGY.DKG_REVOKED_AGENT &&
    literalEqualsIgnoreCase(quad.object, proof.approvedAgentAddress)
  ));
  if (!allowed || revoked) return false;

  const delegationQuads = quads.filter((quad) => quad.subject === delegationSubject);
  const namesApprovedAgent = delegationQuads.some((quad) => (
    quad.predicate === DKG_ONTOLOGY.DKG_DELEGATION_AGENT &&
    literalEqualsIgnoreCase(quad.object, proof.approvedAgentAddress)
  ));
  const issuedAtIsActive = delegationQuads.some((quad) => {
    if (quad.predicate !== DKG_ONTOLOGY.DKG_DELEGATION_ISSUED_AT) return false;
    const issuedAt = Number(stripLiteral(quad.object));
    return Number.isSafeInteger(issuedAt) && issuedAt >= 0 && issuedAt <= proof.nowMs;
  });
  const expiryRows = delegationQuads.filter(
    (quad) => quad.predicate === DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT,
  );
  const expiryIsActive = expiryRows.length === 0 || expiryRows.some((quad) => {
    const expiresAt = Number(stripLiteral(quad.object));
    return Number.isSafeInteger(expiresAt) && expiresAt > proof.nowMs;
  });
  const peerMatches = proof.expectedDelegateePeerId !== undefined && delegationQuads.some((quad) => (
    quad.predicate === DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER &&
    quad.object.startsWith('"') &&
    stripLiteral(quad.object) === proof.expectedDelegateePeerId
  ));
  const keyMatches = proof.expectedDelegateeOpKey !== undefined && delegationQuads.some((quad) => (
    quad.predicate === DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_KEY &&
    literalEqualsIgnoreCase(quad.object, proof.expectedDelegateeOpKey!)
  ));
  return namesApprovedAgent && issuedAtIsActive && expiryIsActive && (peerMatches || keyMatches);
}

/** The store-side ASK fragment for the same proof. */
export function renderApprovedMemberProofSparql(
  contextGraphId: string,
  contextGraphUri: string,
  rawProof: ApprovedMemberProof,
): string {
  const proof = normalizeMemberProof(rawProof);
  if (!proof) throw new Error('Invalid approved-member proof');
  const delegationSubject = assertSafeIri(
    `did:dkg:agent-delegation:${contextGraphId}:${proof.approvedAgentAddress}`,
  );
  const credentialPatterns: string[] = [];
  const credentialFilters: string[] = [];
  if (proof.expectedDelegateePeerId) {
    credentialPatterns.push(
      `OPTIONAL { <${delegationSubject}> <${DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER}> ?approvedDelegateePeer . }`,
    );
    credentialFilters.push(
      `(BOUND(?approvedDelegateePeer) && isLiteral(?approvedDelegateePeer) && STR(?approvedDelegateePeer) = ${sparqlString(proof.expectedDelegateePeerId)})`,
    );
  }
  if (proof.expectedDelegateeOpKey) {
    credentialPatterns.push(
      `OPTIONAL { <${delegationSubject}> <${DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_KEY}> ?approvedDelegateeKey . }`,
    );
    credentialFilters.push(
      `(BOUND(?approvedDelegateeKey) && isLiteral(?approvedDelegateeKey) && LCASE(STR(?approvedDelegateeKey)) = ${sparqlString(proof.expectedDelegateeOpKey)})`,
    );
  }
  return `      <${assertSafeIri(contextGraphUri)}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?approvedAgent .
      FILTER(isLiteral(?approvedAgent) && LCASE(STR(?approvedAgent)) = ${sparqlString(proof.approvedAgentAddress)})
      FILTER NOT EXISTS {
        <${assertSafeIri(contextGraphUri)}> <${DKG_ONTOLOGY.DKG_REVOKED_AGENT}> ?revokedApprovedAgent .
        FILTER(isLiteral(?revokedApprovedAgent) && LCASE(STR(?revokedApprovedAgent)) = ${sparqlString(proof.approvedAgentAddress)})
      }
      <${delegationSubject}> <${DKG_ONTOLOGY.DKG_DELEGATION_AGENT}> ?delegatedApprovedAgent ;
                             <${DKG_ONTOLOGY.DKG_DELEGATION_ISSUED_AT}> ?delegationIssuedAt .
      FILTER(isLiteral(?delegatedApprovedAgent) && LCASE(STR(?delegatedApprovedAgent)) = ${sparqlString(proof.approvedAgentAddress)})
      FILTER(REGEX(STR(?delegationIssuedAt), "^[0-9]+$") && xsd:integer(STR(?delegationIssuedAt)) <= ${proof.nowMs})
      OPTIONAL { <${delegationSubject}> <${DKG_ONTOLOGY.DKG_DELEGATION_EXPIRES_AT}> ?delegationExpiresAt . }
      FILTER(!BOUND(?delegationExpiresAt) || (REGEX(STR(?delegationExpiresAt), "^[0-9]+$") && xsd:integer(STR(?delegationExpiresAt)) > ${proof.nowMs}))
      ${credentialPatterns.join('\n      ')}
      FILTER(${credentialFilters.join(' || ')})`;
}
