// SPDX-License-Identifier: Apache-2.0
import type { DkgNetworkIdentity } from '@origintrail-official/dkg-core';

export function resolveConfiguredNetworkIdentity(identity: DkgNetworkIdentity | undefined, genesisId: string, computedNetworkId: string, chainId: string | undefined): DkgNetworkIdentity {
    if (identity?.genesisId && identity.genesisId !== genesisId) {
      throw new Error(
        `DKGAgentConfig.networkIdentity.genesisId (${identity.genesisId}) ` +
        `must match the selected genesisId (${genesisId})`,
      );
    }
    if (identity?.networkId && identity.networkId !== computedNetworkId) {
      throw new Error(
        `DKGAgentConfig.networkIdentity.networkId (${identity.networkId}) ` +
        `must match computeNetworkId(${genesisId}) (${computedNetworkId})`,
      );
    }
    return {
      ...identity,
      genesisId,
      networkId: computedNetworkId,
      chainId: chainId,
    };
}
