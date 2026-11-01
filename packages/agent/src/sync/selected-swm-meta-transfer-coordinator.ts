import {
  SwmMetaTransferCoordinator,
  type SwmMetaTransferScope,
  type SwmMetaTransferSession,
} from './swm-meta-transfer-coordinator.js';
import type { SwmMetaFetcher } from './swm-meta-fetcher.js';

/** The released peer-only API always addresses the shared selected-mode owner. */
export class SelectedSwmMetaTransferCoordinator extends SwmMetaTransferCoordinator {
  override run<T>(
    scope: string | SwmMetaTransferScope,
    createFetcher: (session: SwmMetaTransferSession) => SwmMetaFetcher,
    operation: (fetcher: SwmMetaFetcher) => Promise<T>,
  ): Promise<T> {
    return super.run(
      typeof scope === 'string' ? { mode: 'selected', remotePeerId: scope } : scope,
      createFetcher,
      operation,
    );
  }
}
