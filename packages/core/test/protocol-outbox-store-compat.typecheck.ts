import {
  ProtocolOutbox,
  type ProtocolOutboxStore,
} from '../dist/index.js';

// Compile-time compatibility fixture: this is the current public store shape
// from before metadata fast paths were added. Existing custom stores must keep
// compiling; ProtocolOutbox normalizes their payload-bearing fallback methods.
const existingStore = {
  enqueue: () => { throw new Error('type fixture'); },
  markDelivered: () => false,
  hasEntry: () => false,
  hasPendingFor: () => false,
  due: () => [],
  dropExpired: () => [],
  size: () => 0,
  list: () => [],
  getEntry: () => undefined,
  // Pre-existing store-private methods unrelated to DKG outbox metadata.
  listMetadata: () => ['store schema v7'],
  dropExpiredMetadata: () => ['last store vacuum: yesterday'],
};

const acceptedStore: ProtocolOutboxStore = existingStore;
new ProtocolOutbox(acceptedStore);
