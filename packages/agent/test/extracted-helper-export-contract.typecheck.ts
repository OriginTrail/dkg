// SPDX-License-Identifier: Apache-2.0

import { createListContextGraphsCacheInvalidatingStore } from '@origintrail-official/dkg-agent/dist/dkg-agent-base.js';
import { createKnowledgeAssetVmPublishIntentKey, type KnowledgeAssetVmPublishRequestWithoutIntentKey } from '@origintrail-official/dkg-agent/dist/dkg-agent-publish.js';

const historicalCacheFactory: typeof createListContextGraphsCacheInvalidatingStore = createListContextGraphsCacheInvalidatingStore;
const historicalIntentFactory: (request: KnowledgeAssetVmPublishRequestWithoutIntentKey) => string = createKnowledgeAssetVmPublishIntentKey;
void historicalCacheFactory;
void historicalIntentFactory;

// @ts-expect-error implementation helpers are private through package subpaths
import type * as PrivateHelper0 from '@origintrail-official/dkg-agent/dist/context-graph-binding-abort.js';
void (null as unknown as typeof PrivateHelper0);

// @ts-expect-error implementation helpers are private through package subpaths
import type * as PrivateHelper1 from '@origintrail-official/dkg-agent/dist/context-graph-cache-invalidating-store.js';
void (null as unknown as typeof PrivateHelper1);

// @ts-expect-error implementation helpers are private through package subpaths
import type * as PrivateHelper2 from '@origintrail-official/dkg-agent/dist/context-graph-meta-record-copy.js';
void (null as unknown as typeof PrivateHelper2);

// @ts-expect-error implementation helpers are private through package subpaths
import type * as PrivateHelper3 from '@origintrail-official/dkg-agent/dist/context-graph-sync-abort.js';
void (null as unknown as typeof PrivateHelper3);

// @ts-expect-error implementation helpers are private through package subpaths
import type * as PrivateHelper4 from '@origintrail-official/dkg-agent/dist/join-encryption-key-bundle.js';
void (null as unknown as typeof PrivateHelper4);

// @ts-expect-error implementation helpers are private through package subpaths
import type * as PrivateHelper5 from '@origintrail-official/dkg-agent/dist/knowledge-asset-vm-publish-request.js';
void (null as unknown as typeof PrivateHelper5);

// @ts-expect-error implementation helpers are private through package subpaths
import type * as PrivateHelper6 from '@origintrail-official/dkg-agent/dist/lifecycle-sync-policy.js';
void (null as unknown as typeof PrivateHelper6);

// @ts-expect-error implementation helpers are private through package subpaths
import type * as PrivateHelper7 from '@origintrail-official/dkg-agent/dist/lifecycle-sync-result.js';
void (null as unknown as typeof PrivateHelper7);

// @ts-expect-error implementation helpers are private through package subpaths
import type * as PrivateHelper8 from '@origintrail-official/dkg-agent/dist/local-private-member.js';
void (null as unknown as typeof PrivateHelper8);

// @ts-expect-error implementation helpers are private through package subpaths
import type * as PrivateHelper9 from '@origintrail-official/dkg-agent/dist/storage-ack-owned-request.js';
void (null as unknown as typeof PrivateHelper9);

// @ts-expect-error implementation helpers are private through package subpaths
import type * as PrivateHelper10 from '@origintrail-official/dkg-agent/dist/workspace-projected-delegatees.js';
void (null as unknown as typeof PrivateHelper10);
