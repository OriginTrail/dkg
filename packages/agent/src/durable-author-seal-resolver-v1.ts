// SPDX-License-Identifier: Apache-2.0

/** Resolve one strict durable author seal across equivalent EVM-address URI spellings. */

import {
  assertSafeIri,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  parseGraphScopedAssertionSealCandidate,
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
  const assertionUris = Object.freeze(Array.from(new Set([
    contextGraphAssertionUri(
      params.contextGraphId,
      params.agentAddress.toLowerCase(),
      params.assertionCoordinate,
      params.subGraphName,
    ),
    contextGraphAssertionUri(
      params.contextGraphId,
      ethers.getAddress(params.agentAddress),
      params.assertionCoordinate,
      params.subGraphName,
    ),
  ])));
  const metaGraph = contextGraphMetaUri(params.contextGraphId);
  const sealResult = await params.store.query(
    `CONSTRUCT { ?assertion ?p ?o } WHERE { GRAPH <${assertSafeIri(metaGraph)}> { VALUES ?assertion { ${assertionUris.map((assertionUri) => `<${assertSafeIri(assertionUri)}>`).join(' ')} } ?assertion ?p ?o } }`,
    { source: params.source, signal: params.signal },
  );
  const sealQuads = sealResult.type === 'quads' ? sealResult.quads : [];
  const candidates = assertionUris.flatMap((assertionUri) => {
    const candidate = parseGraphScopedAssertionSealCandidate(sealQuads, assertionUri);
    return candidate === undefined ? [] : [candidate];
  });
  if (candidates.length > 1) {
    throw new Error('durable assertion has ambiguous author seal subjects');
  }
  return candidates[0];
}
