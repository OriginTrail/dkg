// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphAuthorityHistoryCreationEvent } from '../src/context-graph-authority-history.js';

// @ts-expect-error Creation events cannot cross this boundary without nameHash.
const creationWithoutNameHash: ContextGraphAuthorityHistoryCreationEvent = {
  blockNumber: 1,
  blockHash: '0x01',
  index: 0,
};

void creationWithoutNameHash;
