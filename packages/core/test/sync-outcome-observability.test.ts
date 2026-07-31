import { describe, expect, it } from 'vitest';
import { classifySyncPlaneOutcome } from '../src/index.js';

describe('verified sync plane outcome classification', () => {
  const base = {
    verified: false,
    authoritativeScopeConfirmed: true,
    connectedPeers: 2,
    syncCapablePeers: 2,
    peersTried: 2,
    peersResponded: 2,
  };

  it('only reports success from explicit verification evidence', () => {
    expect(classifySyncPlaneOutcome({ ...base, verified: true })).toBe('success');
    expect(classifySyncPlaneOutcome(base)).toBe('failed');
  });

  it('keeps terminal failure classes distinct and ordered', () => {
    expect(classifySyncPlaneOutcome({ ...base, deniedPhases: 1 })).toBe('denied');
    expect(classifySyncPlaneOutcome({ ...base, deferredBackpressure: 1 })).toBe('deferred');
    expect(classifySyncPlaneOutcome({ ...base, timedOutPhases: 1 })).toBe('timeout');
    expect(classifySyncPlaneOutcome({ ...base, authoritativeScopeConfirmed: false })).toBe('unreachable');
    expect(classifySyncPlaneOutcome({ ...base, peersResponded: 0 })).toBe('unreachable');
  });
});
