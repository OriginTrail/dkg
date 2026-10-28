// SPDX-License-Identifier: Apache-2.0
import { buildNativeSnapshotCheckpoint } from './snapshot-native-build.js';
import { resolveWithinAbort } from '@origintrail-official/dkg-core';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { PublicSnapshotSyncOptions } from './public-snapshot-options.js';
import { preparePublicSnapshotCheckpoint, assertCheckpointInventoryUnchanged } from './public-snapshot-checkpoint.js';

export class PublicCheckpointMethods extends DKGAgentBase {
  /** Drain startup discovery before taking a foreground graph-ownership snapshot. */
  async waitForPublicCheckpointStartup(this: DKGAgent, contextGraphId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await resolveWithinAbort(async () => { await this.chainPoller?.waitForCurrentPoll(); }, signal);
    signal.throwIfAborted();
    const activation = this.waitForContextGraphSubscriptionActivation(contextGraphId, signal);
    if (activation) (await activation).assertCurrent();
    signal.throwIfAborted();
  }
  async preparePublicGraphCheckpoint(this: DKGAgent, options: PublicSnapshotSyncOptions, nativeBuild = false) {
    const runtime = nativeBuild ? { java: process.env.DKG_PUBLIC_CHECKPOINT_JAVA ?? '',
      jar: process.env.DKG_PUBLIC_CHECKPOINT_JAR ?? '', jarSha256: process.env.DKG_PUBLIC_CHECKPOINT_JAR_SHA256 ?? '' } : undefined;
    if (runtime && (!runtime.java || !runtime.jar || !/^[a-f0-9]{64}$/.test(runtime.jarSha256)))
      throw new Error('Native checkpoint runtime is not configured');
    if (!this.config.dataDir) throw new Error('Checkpoint requires a persistent data directory');
    return this.withPublicSnapshotSession(options, async session => {
      const { initial, sourcePlan: plan, signal, deadline, assertInitialInventoryCurrent: assertCurrent,
        readBeforeAdmission: read, normalized: { mode } } = session;
      // No subscription admission, metadata writes, reconciliation, or active-store mutation.
      const prepared = await preparePublicSnapshotCheckpoint({ router: this.router,
        ensurePeerConnected: (peer, opts) => this.ensurePeerConnected(peer, opts) }, {
        initial, readFresh: () => read(true), peerBatches: plan.contentPeerBatches,
        dataDir: this.config.dataDir!, signal, deadline, assertCurrent,
      });
      const native = runtime ? await buildNativeSnapshotCheckpoint(prepared, { ...runtime, signal,
        assertInventoryCurrent: async () => { const fresh = await read(true); assertCurrent(); assertCheckpointInventoryUnchanged(initial, fresh); },
      }) : undefined;
      return { directory: prepared.directory, assets: prepared.manifest.assets.length,
        inventoryDigest: initial.snapshot.inventoryDigest, mode, committed: 0, current: false,
        activeStoreChanged: false, state: 'verified-unpublished', ...(native ? { native } : {}) };
    }, { ownershipError: 'Checkpoint ownership changed' });
  }
}
