import type { AsyncLiftPublisher, AsyncLiftRunner } from '@origintrail-official/dkg-publisher';
import type { RpcUsageWindow } from '@origintrail-official/dkg-chain';
import type { PublisherLiveControl } from './publisher-live-control.js';

export interface PublisherRuntime {
  readonly runner: AsyncLiftRunner;
  readonly publisher: AsyncLiftPublisher;
  /** Controls only this runtime’s active wallet loops. */
  readonly control: PublisherLiveControl;
  readonly walletIds: string[];
  readonly wallets: readonly PublisherRuntimeWallet[];
  readonly stop: () => Promise<void>;
  /** RpcUsageDrainable: merged window across every per-wallet chain adapter. */
  readonly drainRpcUsage: () => RpcUsageWindow;
  /**
   * GH#2270 follow-up (🔴 3822987482) — can THIS runtime settle a held job signed by this
   * wallet, for this operation kind? The daemon's ADMISSION instance is a separate, deliberately
   * resolver-less publisher (it runs no scheduler), so asking it whether an automatic exit exists
   * always answered "no" — every pending-chain-proof rejection claimed there was no automatic
   * recovery even on a node where recovery was configured and running. Admission now asks the
   * live runtime through this probe instead of inferring from its own wiring.
   */
  readonly canSettleHeldJob: (walletId: string, operationKind: 'create' | 'update' | undefined) => boolean;
}

export interface PublisherRuntimeWallet {
  readonly address: string;
  readonly identityId: bigint;
}
