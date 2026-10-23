import type {
  AsyncKnowledgeAssetVmPublishCertifiedResult,
  AsyncKnowledgeAssetVmPublishExecutionResult,
  AsyncKnowledgeAssetVmPublishJobHandler,
  PublishResult,
} from '../../src/index.js';

declare const legacy: PublishResult;
declare const chain: NonNullable<PublishResult['onChainResult']>;
declare function acceptsResult(result: AsyncKnowledgeAssetVmPublishExecutionResult): void;
declare function acceptsCertificate(result: AsyncKnowledgeAssetVmPublishCertifiedResult): void;

// Existing handlers may still return any unmarked PublishResult and use canonical recovery.
acceptsResult(legacy);
acceptsResult({ ...legacy, status: 'tentative', onChainResult: undefined });
acceptsResult({ ...legacy, status: 'failed' });
acceptsResult({ ...legacy, status: 'confirmed', onChainResult: undefined });
const legacyHandler: AsyncKnowledgeAssetVmPublishJobHandler = { execute: async () => legacy };
void legacyHandler;

const certified: AsyncKnowledgeAssetVmPublishCertifiedResult = {
  ...legacy, status: 'confirmed', onChainResult: chain, localFinalizationComplete: true,
};
acceptsResult(certified);
acceptsCertificate(certified);

// @ts-expect-error A tentative result cannot carry a local-finalization certificate.
acceptsResult({ ...certified, status: 'tentative' });
// @ts-expect-error A failed result cannot carry a local-finalization certificate.
acceptsResult({ ...certified, status: 'failed' });
// @ts-expect-error Confirmed status alone is not on-chain evidence.
acceptsResult({ ...certified, onChainResult: undefined });
// @ts-expect-error A broadly typed result cannot be certified without narrowing its evidence.
acceptsResult({ ...legacy, localFinalizationComplete: true });
// @ts-expect-error An unmarked result is not a certificate.
acceptsCertificate(legacy);

function consume(result: AsyncKnowledgeAssetVmPublishExecutionResult): void {
  if (result.localFinalizationComplete === true) {
    acceptsCertificate(result);
    const status: 'confirmed' = result.status;
    const txHash: string = result.onChainResult.txHash;
    void [status, txHash];
  }
}
void consume;
