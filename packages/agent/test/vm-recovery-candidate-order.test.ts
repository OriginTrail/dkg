import { describe, expect, it } from 'vitest';
import { orderVmRecoveryCandidates } from '../src/vm-recovery-candidate-order.js';

const candidatePeerIds = ['other-setback', 'stream-setback', 'other', 'stream', 'stream-two'];
function order(lastAttemptedPeerId?: string, preferredPeerId?: string) {
  return orderVmRecoveryCandidates({
    candidatePeerIds, lastAttemptedPeerId, preferredPeerId,
    streamPeerIds: new Set(['stream-setback', 'stream', 'stream-two']),
    hasSetback: (peerId) => peerId.endsWith('-setback'),
    isHeldOff: (peerId) => peerId === 'stream-setback',
  });
}
describe('VM recovery candidate transport tiers', () => {
  it('places stream peers without and with setbacks before other peers ordinarily', () => {
    expect(order().order).toEqual(['stream', 'stream-two', 'stream-setback', 'other-setback', 'other']);
  });
  it('tries all peers without a setback before setback peers after a setback', () => {
    const result = order('stream-setback');
    expect(result.order).toEqual(['stream', 'stream-two', 'other', 'other-setback', 'stream-setback']);
    expect([...result.heldOffPeerIds]).toEqual(['stream-setback']);
  });
  it('keeps preference inside its tier, with the rotation order behind it', () => {
    expect(order(undefined, 'stream-two').order)
      .toEqual(['stream-two', 'stream', 'stream-setback', 'other-setback', 'other']);
    expect(order('stream-setback', 'stream-setback').order)
      .toEqual(['stream', 'stream-two', 'other', 'stream-setback', 'other-setback']);
    expect(order(undefined, 'outsider').order).toEqual(order().order);
  });
  it('classifies each candidate once without changing the input rotation', () => {
    const reads = new Map<string, number>();
    orderVmRecoveryCandidates({ candidatePeerIds,
      hasSetback: (peerId) => { reads.set(peerId, (reads.get(peerId) ?? 0) + 1); return false; },
      isHeldOff: () => false,
    });
    expect([...reads.values()]).toEqual([1, 1, 1, 1, 1]);
    expect(candidatePeerIds[0]).toBe('other-setback');
  });
});
