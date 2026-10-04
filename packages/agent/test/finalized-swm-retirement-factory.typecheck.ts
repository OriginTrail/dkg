// SPDX-License-Identifier: Apache-2.0

import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { FinalizationHandler } from '@origintrail-official/dkg-agent/dist/finalization-handler.js';
import { createRetireConfirmedGraphScopedSwmTwinIfOrphaned, type RetireConfirmedGraphScopedSwmTwinIfOrphaned } from '@origintrail-official/dkg-agent/dist/sync/requester/finalized-swm-twin-reconciliation.js';

declare const store: TripleStore;
declare const chain: ChainAdapter;
declare const retire: RetireConfirmedGraphScopedSwmTwinIfOrphaned;

// Existing consumers pass the public factory directly to the handler.
new FinalizationHandler(store, chain, {
  retireConfirmedGraphScopedSwmTwinIfOrphaned:
    createRetireConfirmedGraphScopedSwmTwinIfOrphaned({ store, retire, writeLocks: new Map() }),
});
