// SPDX-License-Identifier: Apache-2.0

import { createListContextGraphsCacheInvalidatingStore } from '@origintrail-official/dkg-agent/dist/dkg-agent-base.js';
import { createKnowledgeAssetVmPublishIntentKey, type KnowledgeAssetVmPublishRequestWithoutIntentKey } from '@origintrail-official/dkg-agent/dist/dkg-agent-publish.js';

const historicalCacheFactory: typeof createListContextGraphsCacheInvalidatingStore = createListContextGraphsCacheInvalidatingStore;
const historicalIntentFactory: (request: KnowledgeAssetVmPublishRequestWithoutIntentKey) => string = createKnowledgeAssetVmPublishIntentKey;
void historicalCacheFactory;
void historicalIntentFactory;
