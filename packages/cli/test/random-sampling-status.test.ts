import { describe, expect, it } from 'vitest';
import { describeRandomSamplingDisabledStatus } from '../src/random-sampling-status.js';

describe('Random Sampling disabled status', () => {
  it('explains a prover whose physical cleanup is still pending', () => {
    expect(describeRandomSamplingDisabledStatus({ role: 'core', identityId: '52', disabledReason: 'not_started', retiring: true }))
      .toBe('prover disabled; waiting for physical resource cleanup');
  });

  it('distinguishes a profiled core awaiting admission from a missing identity', () => {
    expect(describeRandomSamplingDisabledStatus({
      role: 'core',
      identityId: '17',
      disabledReason: 'awaiting_sharding_table',
    })).toBe('profile exists; waiting for sharding-table admission');

    expect(describeRandomSamplingDisabledStatus({
      role: 'core',
      identityId: '0',
      disabledReason: 'no_identity',
    })).toBe('no on-chain identity yet (complete profile registration and staking)');
  });

  it('keeps edge-node and older-daemon responses understandable', () => {
    expect(describeRandomSamplingDisabledStatus({
      role: 'edge',
      identityId: '0',
      disabledReason: 'edge_node',
    })).toBe('edge node — random sampling is core-only');

    expect(describeRandomSamplingDisabledStatus({
      role: 'core',
      identityId: '23',
    })).toBe('prover unavailable; inspect daemon logs');
  });
});
