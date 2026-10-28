// SPDX-License-Identifier: Apache-2.0
import {
  computeCanonicalGraphScopedAuthorSealDigestV1,
  createOperationContext, parseContextGraphAssertionUri, type ContextGraphIdV1,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { parseConfirmedCatalogObligationRecoveryV1, type ConfirmedCatalogObligationRecoveryV1 } from '../confirmed-catalog-obligation-error.js';
import type { ObserveRfc64ConfirmedVmParamsV1 } from '../dkg-agent-rfc64-catalog-auto-publish.js';
import {
  resolveConfirmedLifecycleSealEvidenceV1,
} from '../durable-author-seal-resolver-v1.js';

interface RecoveryPortsV1 {
  readonly chain: ChainAdapter;
  readonly store: TripleStore;
  readonly signal: AbortSignal;
  resolveBinding(): Promise<{ onChainId: string } | null>;
  assertCurrent(): void;
  observe(params: ObserveRfc64ConfirmedVmParamsV1): Promise<void>;
}

function invalidEvidence(): Error {
  return Object.assign(new Error('Confirmed catalog recovery evidence is not bound to the original local publication'),
    { code: 'CONFIRMED_CATALOG_RECOVERY_INVALID' });
}

/** Read-only authentication precedes the same observer used by the confirmed publication tail. */
export async function recoverConfirmedCatalogObligationV1(
  evidence: Readonly<ConfirmedCatalogObligationRecoveryV1>, ports: RecoveryPortsV1,
): Promise<void> {
  ports.assertCurrent();
  const { chain, signal } = ports;
  if (!chain.resolveCanonicalFinalizationReceipt || !chain.getKAContextGraphId || !chain.getDKGKnowledgeAssetsAddress) throw invalidEvidence();
  const coordinate = parseContextGraphAssertionUri(evidence.assertionUri);
  if (!coordinate || coordinate.scope !== evidence.contextGraphId || coordinate.name !== evidence.assertionCoordinate) throw invalidEvidence();
  const query = { store: ports.store, contextGraphId: evidence.contextGraphId as ContextGraphIdV1,
    agentAddress: coordinate.agentAddress, assertionCoordinate: evidence.assertionCoordinate,
    source: 'agent.confirmedCatalogRecovery.seal', signal };
  const digest = computeCanonicalGraphScopedAuthorSealDigestV1(evidence.seal);
  const candidate = await resolveConfirmedLifecycleSealEvidenceV1({ ...query, sealDigest: digest, signingAuthor: evidence.seal.authorAddress });
  if (candidate === undefined) throw invalidEvidence();
  const binding = await ports.resolveBinding();
  if (binding === null) throw invalidEvidence();
  const assertionVersion = BigInt(evidence.seal.assertionVersion);
  const resolved = await chain.resolveCanonicalFinalizationReceipt(evidence.transactionHash,
    { signal, expectedBlockNumber: evidence.blockNumber, includeKnowledgeAssetUpdates: assertionVersion > 1n });
  if (resolved.status !== 'confirmed') throw invalidEvidence();
  const receipt = resolved.receipt;
  const seal = evidence.seal;
  const kaId = BigInt(seal.reservedKaId);
  const [graphId, chainId, lifecycleAddress, assetsAddress] = await Promise.all([
    chain.getKAContextGraphId(kaId, { signal }), chain.getEvmChainId(),
    chain.getKnowledgeAssetsLifecycleAddress(), chain.getDKGKnowledgeAssetsAddress(),
  ]);
  if (receipt.txHash.toLowerCase() !== evidence.transactionHash.toLowerCase()
    || receipt.blockNumber !== evidence.blockNumber || receipt.kaId !== kaId
    || receipt.startKAId !== kaId || receipt.endKAId !== kaId
    || (assertionVersion > 1n && receipt.assertionVersion !== assertionVersion)
    || receipt.authorAddress?.toLowerCase() !== seal.authorAddress
    || ethers.hexlify(receipt.merkleRoot).toLowerCase() !== seal.assertionMerkleRoot
    || graphId.toString() !== binding.onChainId || chainId.toString() !== seal.assertedAtChainId
    || lifecycleAddress.toLowerCase() !== seal.assertedAtKav10Address
    || receipt.knowledgeAssetsContract?.toLowerCase() !== assetsAddress.toLowerCase()) throw invalidEvidence();
  ports.assertCurrent();
  await ports.observe({ catalogObligationRequired: true, contextGraphId: evidence.contextGraphId,
    assertionCoordinate: evidence.assertionCoordinate, subGraphName: null,
    seal: candidate.seal, assertionUri: evidence.assertionUri,
    ctx: createOperationContext('publishFromSWM'), publicationLabel: 'publish' });
}

/** Capture the caller lifetime and graph generation before any evidence read awaits. */
export async function recoverRetainedCatalogObligationV1(input: unknown, ports: {
  chain: ChainAdapter; store: TripleStore; signal(): AbortSignal;
  capture(graph: string): unknown;
  isCurrent(graph: string, generation: unknown): boolean;
  resolveBinding(graph: string, signal: AbortSignal): Promise<{ onChainId: string } | null>;
  observe(params: ObserveRfc64ConfirmedVmParamsV1): Promise<boolean>;
}): Promise<void> {
  const evidence = parseConfirmedCatalogObligationRecoveryV1(input);
  const signal = ports.signal();
  const generation = ports.capture(evidence.contextGraphId);
  await recoverConfirmedCatalogObligationV1(evidence, {
    chain: ports.chain, store: ports.store, signal,
    resolveBinding: () => ports.resolveBinding(evidence.contextGraphId, signal),
    assertCurrent: () => {
      signal.throwIfAborted();
      if (!ports.isCurrent(evidence.contextGraphId, generation)) throw new Error('Confirmed catalog recovery graph binding changed');
    },
    observe: async params => { await ports.observe(params); },
  });
}
