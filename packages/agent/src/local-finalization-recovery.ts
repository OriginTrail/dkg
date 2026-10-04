// SPDX-License-Identifier: Apache-2.0
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';

/** Startup and shutdown boundaries for local confirmed-finalization workers. */
export class LocalFinalizationRecoveryMethods extends DKGAgentBase {
  startLocalFinalizationRecovery(this: DKGAgent): void {
    this.getOrCreateNamedKaVmLifecycleRepair().start();
    // The durable finalization inbox is an executable retry queue, not only a
    // write-ahead journal. Its lifecycle is independent of chain-cursor
    // progress so entries received after a watermark advance are still
    // reconsidered. The worker batches SQLite reads but serializes graph work.
    if (this.finalizationRuntime.getRecoveryStore()) {
      this.getOrCreateFinalizationHandler().startRecoveryWorker();
    }
  }

  beginNamedLifecycleRepairDrain(this: DKGAgent): Promise<void> | undefined {
    const drain = this.namedKaVmLifecycleRepair?.stop();
    void drain?.catch(() => {});
    return drain;
  }

  async finishLocalFinalizationRecoveryDrain(this: DKGAgent, drain?: Promise<void>): Promise<void> {
    // Stop admission and await the active finalization recovery batch while
    // chain and graph-store dependencies are still alive. No new retry may
    // begin after this boundary.
    await drain;
    this.namedKaVmLifecycleRepair = undefined;
    await this.finalizationHandler?.stopRecoveryWorker();
  }
}
