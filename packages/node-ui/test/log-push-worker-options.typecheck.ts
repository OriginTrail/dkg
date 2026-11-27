import type { LogPushWorkerOptions } from '../src/gelf-push-worker.js';

// Public API compatibility: callers historically supplied callbacks inferred
// as `() => string`, so the option must not require a narrower return type.
const legacyVersionStatus: () => string = () => 'latest';

export const legacyOptionsCompatibility = {
  host: '127.0.0.1',
  port: 1,
  peerId: 'compatibility-fixture',
  network: 'testnet',
  versionStatus: legacyVersionStatus,
} satisfies LogPushWorkerOptions;
