// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphMembershipStore } from '../src/dkg-agent-types.js';

const upsert = async () => undefined;
const remove = async () => undefined;

const legacyStore: ContextGraphMembershipStore = { upsert, delete: remove };
void legacyStore;

const journalStore: ContextGraphMembershipStore = {
  localOrigins: {
    loadLocalOrigins: async () => [],
    recordLocalOrigin: async () => undefined,
  },
  upsert,
  delete: remove,
};
void journalStore;

const readerOnlyStore: ContextGraphMembershipStore = {
  // @ts-expect-error A configured origin journal must provide read and write operations.
  localOrigins: { loadLocalOrigins: async () => [] },
  upsert,
  delete: remove,
};
void readerOnlyStore;

const writerOnlyStore: ContextGraphMembershipStore = {
  // @ts-expect-error A configured origin journal must provide read and write operations.
  localOrigins: { recordLocalOrigin: async () => undefined },
  upsert,
  delete: remove,
};
void writerOnlyStore;
