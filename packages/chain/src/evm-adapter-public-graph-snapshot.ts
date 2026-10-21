// SPDX-License-Identifier: Apache-2.0
import { isPublicGraphSnapshotScope } from "./public-graph-snapshot-scope.js";
import { EVMChainAdapterBase } from "./evm-adapter-base.js";
import { readEvmPublicGraphSnapshot } from "./evm-public-graph-snapshot.js";
import type { ChainReadOptions } from "./chain-adapter.js";
import type { PublicGraphSnapshot } from "./public-graph-snapshot.js";

export class PublicGraphSnapshotMethods extends EVMChainAdapterBase {
  /** A complete public inventory read at one numbered block on one endpoint. No moving-head cache mixing. */
  async readPublicGraphSnapshot(
    contextGraphId: string,
    onChainId: string,
    options: ChainReadOptions = {},
  ): Promise<PublicGraphSnapshot> {
    if (!isPublicGraphSnapshotScope({ contextGraphId, onChainId })) throw new Error("Invalid snapshot scope");
    const signal = options.signal ?? AbortSignal.timeout(110_000);
    signal.throwIfAborted();
    await this.init();
    return readEvmPublicGraphSnapshot({
      chainId: this.chainId, deploymentId: this.deploymentId, hubAddress: this.hubAddress,
      providers: this.providers, finalityConfirmations: this.finalityConfirmations,
    }, contextGraphId, onChainId, { ...options, signal });
  }
}
