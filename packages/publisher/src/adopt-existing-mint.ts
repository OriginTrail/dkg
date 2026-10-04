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
export async function adoptExistingMintOrRethrow(args: {
  mintErr: unknown;
  reservedKaId: bigint | undefined;
  kcMerkleRoot: Uint8Array;
  v10CgId: bigint;
  hasSeal: boolean;
  ctx: OperationContext;
}, chain: Pick<ChainAdapter, 'getMintedKnowledgeAssetProvenance'>, log: Pick<Logger, 'warn' | 'info'>): Promise<OnChainPublishResult> {
  const mintedKaId = getKaIdAlreadyMintedKaId(args.mintErr);
  const provenanceFn = chain.getMintedKnowledgeAssetProvenance?.bind(chain);
  if (
    mintedKaId === undefined
    || args.reservedKaId === undefined
    || mintedKaId !== args.reservedKaId
    || !args.hasSeal
    || provenanceFn === undefined
  ) {
    throw args.mintErr;
  }
  log.warn(
    args.ctx,
    `[adopt-existing-mint] kaId ${args.reservedKaId} already minted on-chain; `
      + 'verifying sealed root against chain and recovering mint provenance',
  );
  const synthesized = await provenanceFn(args.reservedKaId, args.kcMerkleRoot, args.v10CgId);
  if (!synthesized) {
    log.warn(
      args.ctx,
      `[adopt-existing-mint] mint provenance unrecoverable for kaId ${args.reservedKaId} `
        + '(pruned/non-archive RPC?); rethrowing original mint error',
    );
    throw args.mintErr;
  }
  log.info(
    args.ctx,
    `[adopt-existing-mint] adopted kaId ${args.reservedKaId} `
      + `tx=${synthesized.txHash} block=${synthesized.blockNumber}; continuing confirmed publish path`,
  );
  return synthesized;
}

/** The mint submit and its existing-mint recovery share the exact submitted inputs. */
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
    // Only the structured id and verified mint provenance can recover
    // this sealed publish; keep the ordinary confirmed path below.
    return adoptExistingMintOrRethrow({
      mintErr,
      reservedKaId: params.reservedKaId,
      kcMerkleRoot: params.merkleRoot,
      v10CgId: params.contextGraphId,
      hasSeal,
      ctx,
    }, chain, log);
  }
}
