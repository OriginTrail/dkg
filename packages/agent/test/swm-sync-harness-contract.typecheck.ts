import { createOperationContext } from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import {
  makeSwmSyncHarness,
  type SwmSyncHarnessShare,
} from './_helpers/swm-sync-harness.js';

declare const store: TripleStore;
declare const served: SwmSyncHarnessShare;
declare const servedMeta: readonly Quad[];
const base = {
  ctx: createOperationContext('sync'),
  contextGraphId: 'cg-harness-contract',
  store,
};

makeSwmSyncHarness({ ...base, served });
makeSwmSyncHarness({ ...base, servedMeta });
makeSwmSyncHarness({ ...base, servedMeta: [] });

// @ts-expect-error A harness must name its source explicitly, even when empty.
makeSwmSyncHarness(base);
// @ts-expect-error A full served share and a metadata override are mutually exclusive.
makeSwmSyncHarness({ ...base, served, servedMeta });
