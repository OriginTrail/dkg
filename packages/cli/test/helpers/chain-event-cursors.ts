// SPDX-License-Identifier: Apache-2.0

import { buildEvmDeploymentId } from '@origintrail-official/dkg-chain';
import { DashboardDB, SqliteChainEventCursorStore } from '@origintrail-official/dkg-node-ui';
import { seedChainEventPollerCursors } from '@origintrail-official/dkg-publisher';
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
    await seedChainEventPollerCursors(cursors, currentBlock);
  } finally {
    db.close();
  }
}
