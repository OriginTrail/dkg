// SPDX-License-Identifier: Apache-2.0

import {
  DKG_ONTOLOGY,
  assertSafeIri,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  isSafeIri,
  sparqlString,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { stripLiteral } from './dkg-agent-utils.js';

const AGENT_DID_PREFIX = 'did:dkg:agent:';
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

export interface AuthoritativePrivateMetaMemberProof {
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

type PrivateMetaObjectRequirement =
  | { kind: 'iri'; value: string }
  | { kind: 'normalized-literal'; value: string }
  | { kind: 'iri-prefix'; prefix: string };

interface PrivateMetaRequirement {
  predicate: string;
  variable: string;
  object: PrivateMetaObjectRequirement;
}

/**
 * The single authoritative definition of the facts that prove a private
 * context graph's root metadata is complete enough to trust. Both the
 * in-memory snapshot validator and the store ASK query are rendered from this
 * model so the two security boundaries cannot drift independently.
 */
const AUTHORITATIVE_PRIVATE_META_REQUIREMENTS: readonly PrivateMetaRequirement[] = [
  {
    predicate: DKG_ONTOLOGY.RDF_TYPE,
    variable: 'contextGraphType',
    object: { kind: 'iri', value: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH },
  },
  {
    predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
    variable: 'accessPolicy',
    object: { kind: 'normalized-literal', value: 'private' },
  },
  {
    predicate: DKG_ONTOLOGY.DKG_CREATOR,
    variable: 'creator',
    object: { kind: 'iri-prefix', prefix: AGENT_DID_PREFIX },
  },
  {
    predicate: DKG_ONTOLOGY.DKG_CURATOR,
    variable: 'curator',
    object: { kind: 'iri-prefix', prefix: AGENT_DID_PREFIX },
  },
];

function matchesRequirementObject(value: string, requirement: PrivateMetaObjectRequirement): boolean {
  switch (requirement.kind) {
    case 'iri':
      return value === requirement.value;
    case 'normalized-literal':
      return value.startsWith('"')
        && stripLiteral(value).trim().toLowerCase() === requirement.value;
    case 'iri-prefix':
      return value.startsWith(requirement.prefix)
        && value.length > requirement.prefix.length
        && isSafeIri(value);
  }
}

function normalizeMemberProof(
  proof: AuthoritativePrivateMetaMemberProof,
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

function hasActiveApprovedMemberDelegation(
  contextGraphId: string,
  quads: readonly Quad[],
  rawProof: AuthoritativePrivateMetaMemberProof,
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

/** Evaluate a fetched root `_meta` snapshot against the canonical proof. */
export function hasAuthoritativePrivateMetaDefinition(
  contextGraphId: string,
  quads: readonly Quad[],
  memberProof?: AuthoritativePrivateMetaMemberProof,
): boolean {
  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  const hasDefinition = AUTHORITATIVE_PRIVATE_META_REQUIREMENTS.every((requirement) => quads.some((quad) => (
    quad.subject === contextGraphUri
      && quad.predicate === requirement.predicate
      && matchesRequirementObject(quad.object, requirement.object)
  )));
  return hasDefinition && (
    memberProof === undefined ||
    hasActiveApprovedMemberDelegation(contextGraphId, quads, memberProof)
  );
}

function renderRequirement(
  contextGraphUri: string,
  requirement: PrivateMetaRequirement,
): string {
  const subject = `<${assertSafeIri(contextGraphUri)}>`;
  const predicate = `<${assertSafeIri(requirement.predicate)}>`;
  switch (requirement.object.kind) {
    case 'iri':
      return `${subject} ${predicate} <${assertSafeIri(requirement.object.value)}> .`;
    case 'normalized-literal': {
      const variable = `?${requirement.variable}`;
      return `${subject} ${predicate} ${variable} .\n` +
        `      FILTER(isLiteral(${variable}) && LCASE(REPLACE(STR(${variable}), "^\\\\s+|\\\\s+$", "")) = ${sparqlString(requirement.object.value)})`;
    }
    case 'iri-prefix': {
      const variable = `?${requirement.variable}`;
      const prefix = sparqlString(requirement.object.prefix);
      return `${subject} ${predicate} ${variable} .\n` +
        `      FILTER(\n` +
        `        isIRI(${variable}) &&\n` +
        `        STRSTARTS(STR(${variable}), ${prefix}) &&\n` +
        `        STRLEN(STR(${variable})) > ${requirement.object.prefix.length}\n` +
        '      )';
    }
  }
}

function renderMemberProof(
  contextGraphId: string,
  contextGraphUri: string,
  rawProof: AuthoritativePrivateMetaMemberProof,
): string {
  const proof = normalizeMemberProof(rawProof);
  if (!proof) throw new Error('Invalid authoritative private metadata member proof');
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

/** Build the store-side ASK query from the same canonical proof model. */
export function buildAuthoritativePrivateMetaAskQuery(
  contextGraphId: string,
  memberProof?: AuthoritativePrivateMetaMemberProof,
): string {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const contextGraphUri = contextGraphDataGraphUri(contextGraphId);
  const requirements = AUTHORITATIVE_PRIVATE_META_REQUIREMENTS
    .map((requirement) => `      ${renderRequirement(contextGraphUri, requirement)}`)
    .join('\n');
  const memberRequirements = memberProof
    ? `\n${renderMemberProof(contextGraphId, contextGraphUri, memberProof)}`
    : '';
  return `PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
  ASK WHERE {
    GRAPH <${assertSafeIri(metaGraph)}> {
${requirements}${memberRequirements}
    }
  }`;
}
