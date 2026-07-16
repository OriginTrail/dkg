import { describe, expect, it } from 'vitest';
import { assertEpcisLiveNodeAvailable } from './e2e-prerequisites.js';

describe('EPCIS live-node prerequisite policy', () => {
  it('allows the default suite to skip an unavailable local daemon', () => {
    expect(() => assertEpcisLiveNodeAvailable(false, false, 'unreachable')).not.toThrow();
  });

  it('makes the explicit e2e command fail instead of passing with zero assertions', () => {
    expect(() => assertEpcisLiveNodeAvailable(true, false, 'unreachable'))
      .toThrow('EPCIS live-node prerequisites are required: unreachable');
  });
});
