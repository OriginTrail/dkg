import { describe, expect, expectTypeOf, it } from 'vitest';

import type { RandomSamplingStatus } from '../src/random-sampling-bind.js';

describe('RandomSamplingStatus compatibility', () => {
  it('accepts the status shape exported before disabledReason was added', () => {
    const legacyStatus: RandomSamplingStatus = {
      enabled: false,
      role: 'edge',
      identityId: '0',
      loop: null,
    };

    expectTypeOf(legacyStatus).toMatchTypeOf<RandomSamplingStatus>();
    expect(legacyStatus).not.toHaveProperty('disabledReason');
  });
});
