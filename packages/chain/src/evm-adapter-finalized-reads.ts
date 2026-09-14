// SPDX-License-Identifier: Apache-2.0

/** Finalized, owner-bound EVM read capabilities. */

import { assertCanonicalChainId } from '@origintrail-official/dkg-core';

import type { FinalizedEvmReadBindingV1 } from './chain-adapter.js';
import { EVMChainAdapterBase } from './evm-adapter-base.js';
import type { FinalizedChainReadOwnerV1 } from './finalized-chain-read-admission.js';
import { createStrictCurrentFinalizedEvmSnapshotScopeV1 } from
  './strict-current-finalized-evm-snapshot-factory.js';

/** Public finalized-read domain mixed into the concrete EVM adapter. */
export class FinalizedReadMethods extends EVMChainAdapterBase {
  async createFinalizedEvmReadBinding(
    owner: FinalizedChainReadOwnerV1,
  ): Promise<Readonly<FinalizedEvmReadBindingV1>> {
    const chainId = (await this.getEvmChainId()).toString(10);
    assertCanonicalChainId(chainId, 'finalized snapshot chainId');
    return Object.freeze({
      chainId,
      snapshot: createStrictCurrentFinalizedEvmSnapshotScopeV1({
        chainId, endpoints: this.rpcUrls, owner,
      }),
    });
  }
}
