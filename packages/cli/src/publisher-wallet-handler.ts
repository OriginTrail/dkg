import type { DKGPublisher, AsyncLiftPublisherConfig } from '@origintrail-official/dkg-publisher';

export function scopeKnowledgeAssetVmPublishHandler(
  publishers: Map<string, DKGPublisher>,
  handler: AsyncLiftPublisherConfig['knowledgeAssetVmPublishHandler'],
): AsyncLiftPublisherConfig['knowledgeAssetVmPublishHandler'] {
  if (!handler) return undefined;
  const publisherFor = (walletId: string): DKGPublisher => {
    const publisher = publishers.get(walletId);
    if (!publisher) throw new Error(`No publisher configured for wallet ${walletId}`);
    return publisher;
  };
  return {
    execute: (input) => handler.execute({ ...input, publisher: publisherFor(input.walletId) }),
    preflight: handler.preflight
      ? (input) => handler.preflight!({ ...input, publisher: publisherFor(input.walletId) })
      : undefined,
    finalizeRecovered: handler.finalizeRecovered
      ? (input) => handler.finalizeRecovered!({ ...input, publisher: publisherFor(input.walletId) })
      : undefined,
  };
}
