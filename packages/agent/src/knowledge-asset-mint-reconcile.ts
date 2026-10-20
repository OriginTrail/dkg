// SPDX-License-Identifier: Apache-2.0
import type { DKGAgent } from './dkg-agent.js';

export const KA_MINT_RECONCILE_INCOMPLETE_CODE = 'KA_MINT_RECONCILE_INCOMPLETE';

export interface KnowledgeAssetMintReconcileInput {
  contextGraphId: string;
  name: string;
  subGraphName?: string;
  /** Hint: the transaction believed to have minted the asset. */
  txHash?: string;
}

export type KnowledgeAssetMintReconcileResult =
  | { status: 'already-published'; ual?: string }
  | {
    status: 'adopted';
    ual: string;
    kaId: string;
    txHash: string;
    blockNumber: number;
    tokenAmount?: string;
  };

/**
 * Record one named asset whose publish transaction mined after the node
 * stopped waiting for it, so it stays `swm-shared` and every `vm/publish`
 * retry reverts `KaIdAlreadyMinted`.
 *
 * Runs the synchronous publish path in adopt-only mode: the seal's reserved
 * id is looked up on chain and its mint verified against the seal, then
 * recorded through the unchanged success path. No transaction, ACK request or
 * member ciphertext is sent. Succeeds only once the lifecycle reads
 * `vm-confirmed` with the adopted UAL as its published UAL; an already
 * published asset is left untouched.
 */
export async function reconcileKnowledgeAssetMint(
  agent: DKGAgent,
  input: KnowledgeAssetMintReconcileInput,
): Promise<KnowledgeAssetMintReconcileResult> {
  const { contextGraphId, name, subGraphName } = input;
  const agentAddress = await agent.resolveFinalizedAssertionPublishAuthor(contextGraphId, name, { subGraphName });
  const lifecycle = () => agent.assertion.history(contextGraphId, name, { agentAddress, subGraphName });
  const before = await lifecycle();
  if (before?.status === 'vm-confirmed') return { status: 'already-published', ual: before.publishedUal };

  const published = await agent.publishFromFinalizedAssertion(contextGraphId, name, {
    subGraphName,
    agentAddress,
    adoptExistingMint: input.txHash === undefined ? {} : { txHash: input.txHash },
  });
  const after = await lifecycle();
  const mint = published.onChainResult;
  if (published.status !== 'confirmed' || !mint || after?.status !== 'vm-confirmed' || after.publishedUal !== published.ual) {
    throw Object.assign(new Error(
      `The mint of "${name}" was verified but its lifecycle did not reach vm-confirmed ` +
        `(status ${after?.status ?? 'unknown'}, publishedUal ${after?.publishedUal ?? 'none'}, ` +
        `expected ${published.ual}). Retry the reconcile.`,
    ), { code: KA_MINT_RECONCILE_INCOMPLETE_CODE });
  }
  return {
    status: 'adopted',
    ual: published.ual,
    kaId: String(mint.kaId ?? mint.batchId),
    txHash: mint.txHash,
    blockNumber: mint.blockNumber,
    ...(mint.tokenAmount === undefined ? {} : { tokenAmount: mint.tokenAmount.toString() }),
  };
}
