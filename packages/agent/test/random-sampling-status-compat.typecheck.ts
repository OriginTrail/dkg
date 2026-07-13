import type { RandomSamplingStatus } from '../src/random-sampling-bind.js';

// Compile-time compatibility fixture: this is the public status shape from
// before disabledReason was added. The package build must continue accepting it.
const legacyStatus: RandomSamplingStatus = {
  enabled: false,
  role: 'edge',
  identityId: '0',
  loop: null,
};

void legacyStatus;
