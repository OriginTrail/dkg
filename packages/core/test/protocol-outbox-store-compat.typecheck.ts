import {
  ProtocolOutbox,
  type ProtocolOutboxStore,
} from '../src/index.js';

// Compile-time compatibility fixture: this is the current public store shape
// from before metadata fast paths were added. Existing custom stores must keep
// compiling; ProtocolOutbox normalizes their payload-bearing fallback methods.
const storeWithoutMetadataFastPaths: ProtocolOutboxStore = {
  enqueue: () => { throw new Error('type fixture'); },
  markDelivered: () => false,
  hasEntry: () => false,
  hasPendingFor: () => false,
  due: () => [],
  dropExpired: () => [],
  size: () => 0,
  list: () => [],
  getEntry: () => undefined,
};

new ProtocolOutbox(storeWithoutMetadataFastPaths);
