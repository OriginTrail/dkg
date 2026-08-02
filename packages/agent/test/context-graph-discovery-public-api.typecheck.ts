import type {
  ContextGraphDiscoveryOptions,
} from '../src/index.js';

const compatibilityOptOut = {
  trackSyncScope: false,
} satisfies ContextGraphDiscoveryOptions;

void compatibilityOptOut;

// Discovery disposition is node-local scheduling policy, not public API.
// @ts-expect-error ContextGraphDiscoveryDisposition must remain internal.
type InternalDisposition = import('../src/index.js').ContextGraphDiscoveryDisposition;

declare const internalDisposition: InternalDisposition;
void internalDisposition;
