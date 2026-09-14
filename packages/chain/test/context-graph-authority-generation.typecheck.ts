// SPDX-License-Identifier: Apache-2.0

import type {
  ContextGraphAuthorityGenerationEvent,
  ContextGraphAuthorityGenerationEventOf,
} from '../src/context-graph-authority-generation.js';

const base = { blockNumber: 1, blockHash: '0x01' };

// @ts-expect-error Creation events cannot cross the typed boundary without nameHash.
const creationWithoutNameHash: ContextGraphAuthorityGenerationEventOf<'ContextGraphCreated'> = {
  ...base,
  name: 'ContextGraphCreated',
};

const transferNamedAsCreation: ContextGraphAuthorityGenerationEventOf<'Transfer'> = {
  ...base,
  // @ts-expect-error A payload-less stream cannot be stamped with the creation name.
  name: 'ContextGraphCreated',
  nameHash: '0x02',
};

const transfer: ContextGraphAuthorityGenerationEventOf<'Transfer'> = { ...base, name: 'Transfer' };
const creation: ContextGraphAuthorityGenerationEvent = {
  ...base,
  name: 'ContextGraphCreated',
  nameHash: '0x02',
};

void creationWithoutNameHash;
void transferNamedAsCreation;
void transfer;
void creation;
