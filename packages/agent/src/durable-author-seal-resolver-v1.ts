// SPDX-License-Identifier: Apache-2.0

/** Resolve one strict durable author seal across equivalent EVM-address URI spellings. */

import {
  assertSafeIri,
  canonicalGraphScopedAuthorSealFromAssertionSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  contextGraphPrivateUri,
  contextGraphSubGraphPrivateUri,
  parseGraphScopedAssertionSealCandidate, parseGraphScopedAssertionSealStructure, parseContextGraphAssertionStorageUri,
  type AssertionSeal,
  type ContextGraphIdV1,
  type GraphScopedAssertionSealCandidate,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

export interface ResolveDurableGraphScopedAuthorSealCandidateParamsV1 {
  readonly store: TripleStore;
  readonly contextGraphId: ContextGraphIdV1;
  readonly agentAddress: string;
  readonly assertionCoordinate: string;
  readonly subGraphName?: string;
  readonly source: string;
  /** Exact committed version; permit its archived seal after reopening for editing. */
  readonly sealDigest?: string;
  readonly signal?: AbortSignal;
}

/**
 * RFC-64 control objects use lowercase EVM addresses, while the deployed seal
 * writer persists EIP-55 checksummed addresses in assertion-subject IRIs.
 * RDF IRIs are case-sensitive, so read both equivalent local spellings and
 * fail closed if both exist as independently valid strict seal subjects.
 */
export async function resolveDurableGraphScopedAuthorSealCandidateV1(
  params: ResolveDurableGraphScopedAuthorSealCandidateParamsV1,
): Promise<GraphScopedAssertionSealCandidate | undefined> {
  return resolveDurableSeal(params, parseGraphScopedAssertionSealCandidate);
}

export interface ConfirmedLifecycleSealEvidenceV1 {
  readonly seal: AssertionSeal;
  readonly lifecycleCoordinate: GraphScopedAssertionSealCandidate['coordinate'];
  readonly signingAuthor: string;
}
/** Exact-digest recovery authenticates a signer while preserving separate lifecycle placement. */
export async function resolveConfirmedLifecycleSealEvidenceV1(params: ResolveDurableGraphScopedAuthorSealCandidateParamsV1
  & { readonly sealDigest: string; readonly signingAuthor: string }): Promise<ConfirmedLifecycleSealEvidenceV1 | undefined> {
  return resolveDurableSeal(params, (rows, subject) => {
    const seal = parseGraphScopedAssertionSealStructure(rows, subject);
    const lifecycleCoordinate = parseContextGraphAssertionStorageUri(subject);
    if (!seal || !lifecycleCoordinate || seal.authorAddress.toLowerCase() !== params.signingAuthor.toLowerCase()) return undefined;
    return { seal, lifecycleCoordinate, signingAuthor: seal.authorAddress };
  });
}
type SealParser<T> = (rows: Parameters<typeof parseGraphScopedAssertionSealCandidate>[0], subject: string) => T | undefined;
async function resolveDurableSeal<T extends { seal: AssertionSeal }>(
  params: ResolveDurableGraphScopedAuthorSealCandidateParamsV1, parse: SealParser<T>,
): Promise<T | undefined> {
  const assertionUris = assertionUriSpellingsV1(params);
  const metaGraph = contextGraphMetaUri(params.contextGraphId);
  // sparql-scan-allow: R4 -- exact CG meta graph and at most two exact assertion IRIs are bound by VALUES
  const sealResult = await params.store.query(
    `CONSTRUCT { ?assertion ?p ?o } WHERE { GRAPH <${assertSafeIri(metaGraph)}> { VALUES ?assertion { ${assertionUris.map((assertionUri) => `<${assertSafeIri(assertionUri)}>`).join(' ')} } ?assertion ?p ?o } }`,
    { source: params.source, signal: params.signal },
  );
  const sealQuads = sealResult.type === 'quads' ? sealResult.quads : [];
  const candidates = assertionUris.flatMap((assertionUri) => {
    const candidate = parse(sealQuads, assertionUri);
    return candidate === undefined ? [] : [candidate];
  });
  if (candidates.length > 1) {
    throw new Error('durable assertion has ambiguous author seal subjects');
  }
  const active = candidates[0];
  if (params.sealDigest === undefined) return active;
  const matches = (candidate: T | undefined) => candidate !== undefined
    && computeCanonicalGraphScopedAuthorSealDigestV1(canonicalGraphScopedAuthorSealFromAssertionSealV1(candidate.seal)) === params.sealDigest;
  if (matches(active)) return active;
  const archived = await resolveArchivedSeal(params, parse);
  return matches(archived) ? archived : undefined;
}

/**
 * The seal that re-opening an assertion for editing archived. The publisher's pull-from copies the
 * last finalized seal to `<assertion>/_recovery_seal` in the context graph's private partition
 * before it clears the active one, and a later finalize writes the next version's seal to the
 * active subject. Work that still names the archived version by its exact seal digest, such as a
 * catalog placement owed for a confirmed publication, reads it here. The caller compares the
 * candidate with that digest; this function only locates and parses it.
 */
export async function resolveArchivedGraphScopedAuthorSealCandidateV1(
  params: ResolveDurableGraphScopedAuthorSealCandidateParamsV1,
): Promise<GraphScopedAssertionSealCandidate | undefined> {
  return resolveArchivedSeal(params, parseGraphScopedAssertionSealCandidate);
}
async function resolveArchivedSeal<T extends { seal: AssertionSeal }>(
  params: ResolveDurableGraphScopedAuthorSealCandidateParamsV1, parse: SealParser<T>,
): Promise<T | undefined> {
  const assertionUris = assertionUriSpellingsV1(params);
  const archiveOf = (assertionUri: string): string => `${assertionUri}/_recovery_seal`;
  const recoveryGraph = params.subGraphName === undefined
    ? contextGraphPrivateUri(params.contextGraphId)
    : contextGraphSubGraphPrivateUri(params.contextGraphId, params.subGraphName);
  // sparql-scan-allow: R4 -- exact private partition graph and at most two exact archive IRIs are bound by VALUES
  const sealResult = await params.store.query(
    `CONSTRUCT { ?archive ?p ?o } WHERE { GRAPH <${assertSafeIri(recoveryGraph)}> { VALUES ?archive { ${assertionUris.map((assertionUri) => `<${assertSafeIri(archiveOf(assertionUri))}>`).join(' ')} } ?archive ?p ?o } }`,
    { source: params.source, signal: params.signal },
  );
  const sealQuads = sealResult.type === 'quads' ? sealResult.quads : [];
  const candidates = assertionUris.flatMap((assertionUri) => {
    // The archive keeps the seal's predicates under its own subject; the seal itself is the assertion's.
    const candidate = parse(
      sealQuads
        .filter((quad) => quad.subject === archiveOf(assertionUri))
        .map((quad) => ({ ...quad, subject: assertionUri })),
      assertionUri,
    );
    return candidate === undefined ? [] : [candidate];
  });
  if (candidates.length > 1) {
    throw new Error('durable assertion has ambiguous archived author seal subjects');
  }
  return candidates[0];
}

/** EVM owners have two equivalent spellings; peer-ID lifecycle owners are case-sensitive. */
function assertionUriSpellingsV1(
  params: ResolveDurableGraphScopedAuthorSealCandidateParamsV1,
): readonly string[] {
  const owners = /^0x[0-9a-fA-F]{40}$/.test(params.agentAddress)
    ? [params.agentAddress.toLowerCase(), ethers.getAddress(params.agentAddress)]
    : [params.agentAddress];
  return Object.freeze(Array.from(new Set(owners.map(owner => contextGraphAssertionUri(
    params.contextGraphId, owner, params.assertionCoordinate, params.subGraphName,
  )))));
}
