import type {
  AsyncKnowledgeAssetVmPublishCertifiedResult,
  AsyncKnowledgeAssetVmPublishExecutionResult,
  PublishResult,
} from '@origintrail-official/dkg-publisher';
import type { finalizeQueuedKnowledgeAssetVmPublish } from '../dist/queued-publish-finalization.js';

type FinalizedResult = Awaited<ReturnType<typeof finalizeQueuedKnowledgeAssetVmPublish>>;
declare const published: PublishResult;
declare const chain: NonNullable<PublishResult['onChainResult']>;
declare const executionResult: AsyncKnowledgeAssetVmPublishExecutionResult;
declare function acceptsFinalized(result: FinalizedResult): void;
declare function acceptsExecution(result: AsyncKnowledgeAssetVmPublishExecutionResult): void;
declare function acceptsCertificate(result: AsyncKnowledgeAssetVmPublishCertifiedResult): void;

acceptsFinalized(executionResult);
acceptsFinalized(published);
acceptsFinalized({ ...published, status: 'confirmed', onChainResult: chain, localFinalizationComplete: true });

// @ts-expect-error Tentative results cannot be certified, even with chain evidence.
acceptsFinalized({ ...published, status: 'tentative', onChainResult: chain, localFinalizationComplete: true });
// @ts-expect-error Confirmed status without chain evidence cannot be certified.
acceptsFinalized({ ...published, status: 'confirmed', onChainResult: undefined, localFinalizationComplete: true });

function consume(result: FinalizedResult): void {
  acceptsExecution(result);
  if (result.localFinalizationComplete === true) {
    acceptsCertificate(result);
    const status: 'confirmed' = result.status;
    const txHash: string = result.onChainResult.txHash;
    void [status, txHash];
  }
}
void consume;
