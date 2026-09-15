// SPDX-License-Identifier: Apache-2.0

import { buildEvmDeploymentId } from '@origintrail-official/dkg-chain';
import { DashboardDB, SqliteChainEventCursorStore } from '@origintrail-official/dkg-node-ui';
import { CHAIN_EVENT_POLLER_LANES } from '@origintrail-official/dkg-publisher';
import { createProvider, getSharedContext } from '../../../chain/test/evm-test-context.js';

/** Seed every production poller lane at the shared test chain's current head. */
export async function prepareChainEventCursorsAtCurrentHead(home: string): Promise<void> {
  const { hubAddress } = getSharedContext();
  const currentBlock = await createProvider().getBlockNumber();
  const db = new DashboardDB({ dataDir: home });
  try {
    const cursors = new SqliteChainEventCursorStore(db, {
      scope: buildEvmDeploymentId({ chainId: 'evm:31337', hubAddress }),
    });
    // Test-local seeding, through the store this fixture owns: one SQLite
    // transaction over the canonical lane set, so the suite starts at the
    // shared chain's head without the publisher publishing a seeding API.
    await cursors.saveLanes([...CHAIN_EVENT_POLLER_LANES], currentBlock);
  } finally {
    db.close();
  }
}
