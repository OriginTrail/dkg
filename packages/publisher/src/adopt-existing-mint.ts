import { getKaIdAlreadyMintedKaId, type ChainAdapter, type OnChainPublishResult, type V10PublishParams } from '@origintrail-official/dkg-chain';
import type { Logger, OperationContext } from '@origintrail-official/dkg-core';

/**
 * Adopt-existing-mint: called from the createKnowledgeAssets catch. When the
 * revert is KaIdAlreadyMinted for exactly our reserved kaId on a sealed
 * graph publish, verify chain truth and recover the mint provenance via
 * ChainAdapter.getMintedKnowledgeAssetProvenance; otherwise (or when the
 * log is unrecoverable) rethrow the ORIGINAL error — never synthesize a
 * txHash (finalization-handler.ts:1345 invariant).
 */
export async function createKnowledgeAssetsWithMintAdoption(
  chain: Pick<ChainAdapter, 'createKnowledgeAssets' | 'getMintedKnowledgeAssetProvenance'>,
  params: V10PublishParams,
  hasSeal: boolean,
  ctx: OperationContext,
  log: Pick<Logger, 'warn' | 'info'>,
): Promise<OnChainPublishResult> {
  try {
    return await chain.createKnowledgeAssets(params);
  } catch (mintErr) {
    const mintedKaId = getKaIdAlreadyMintedKaId(mintErr);
    const provenanceFn = chain.getMintedKnowledgeAssetProvenance?.bind(chain);
    if (
      mintedKaId === undefined
      || params.reservedKaId === undefined
      || mintedKaId !== params.reservedKaId
      || !hasSeal
      || provenanceFn === undefined
    ) {
      throw mintErr;
    }
    log.warn(
      ctx,
      `[adopt-existing-mint] kaId ${params.reservedKaId} already minted on-chain; `
        + 'verifying sealed root against chain and recovering mint provenance',
    );
    const synthesized = await provenanceFn(params.reservedKaId, params.merkleRoot, params.contextGraphId);
    if (!synthesized) {
      log.warn(
        ctx,
        `[adopt-existing-mint] mint provenance unrecoverable for kaId ${params.reservedKaId} `
          + '(pruned/non-archive RPC?); rethrowing original mint error',
      );
      throw mintErr;
    }
    log.info(
      ctx,
      `[adopt-existing-mint] adopted kaId ${params.reservedKaId} `
        + `tx=${synthesized.txHash} block=${synthesized.blockNumber}; continuing confirmed publish path`,
    );
    return synthesized;
  }
}
