import { describe, expect, it } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import { NetworkAdmissionService } from '../src/p2p/network-admission.js';

const SELF_PEER_ID = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const VERIFIED_PEER_ID = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const VERIFIED_PEER_ID_CID = peerIdFromString(VERIFIED_PEER_ID).toCID().toString();
const UNKNOWN_PEER_ID = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';

describe('NetworkAdmissionService', () => {
  it('allows all peers when no active network identity is configured', () => {
    const admission = new NetworkAdmissionService({ selfPeerId: 'fixture-self' });

    expect(admission.isAcceptedPeer('fixture-peer')).toBe(true);
    expect(admission.isRejectedPeer('fixture-peer')).toBe(false);
    expect(admission.snapshot().enabled).toBe(false);
  });

  it('validates configured self peer ids and cache capacity', () => {
    expect(() => new NetworkAdmissionService({
      networkId: 'network-a',
      selfPeerId: 'fixture-self',
    })).toThrow();
    expect(() => new NetworkAdmissionService({ maxProbeBackoffEntries: 0 }))
      .toThrow('maxProbeBackoffEntries must be a positive integer');
  });

  it('accepts self and fails unknown peers closed when active', () => {
    const admission = new NetworkAdmissionService({
      networkId: 'network-a',
      selfPeerId: SELF_PEER_ID,
    });

    expect(admission.isAcceptedPeer(SELF_PEER_ID)).toBe(true);
    expect(admission.isAcceptedPeer(UNKNOWN_PEER_ID)).toBe(false);
    expect(admission.isRejectedPeer(UNKNOWN_PEER_ID)).toBe(false);
    expect(admission.isAcceptedPeer('not-a-peer-id')).toBe(false);
    expect(admission.isRejectedPeer('not-a-peer-id')).toBe(true);
  });

  it('promotes verified same-network peers and excludes quarantined peers', () => {
    const admission = new NetworkAdmissionService({ networkId: 'network-a' });

    admission.markVerifiedSameNetwork(VERIFIED_PEER_ID_CID);
    expect(admission.isAcceptedPeer(VERIFIED_PEER_ID)).toBe(true);
    expect([...admission.verifiedSameNetworkPeerIds()].sort()).toEqual([VERIFIED_PEER_ID]);

    admission.quarantinePeer(VERIFIED_PEER_ID_CID);
    expect(admission.isAcceptedPeer(VERIFIED_PEER_ID)).toBe(false);
    expect(admission.isRejectedPeer(VERIFIED_PEER_ID)).toBe(true);
    expect([...admission.verifiedSameNetworkPeerIds()]).toEqual([]);
  });

  it('keeps no-deadline quarantine indefinite for backward compatibility', () => {
    let now = 1_000;
    const admission = new NetworkAdmissionService({
      networkId: 'network-a',
      now: () => now,
    });

    admission.quarantinePeer(VERIFIED_PEER_ID);
    now += 1_000_000;

    expect(admission.isRejectedPeer(VERIFIED_PEER_ID_CID)).toBe(true);
    expect(admission.snapshot().quarantinedPeerIds).toEqual([VERIFIED_PEER_ID]);
  });

  it('expires coordinator quarantine after its configured cooldown', () => {
    let now = 1_000;
    const admission = new NetworkAdmissionService({
      networkId: 'network-a',
      now: () => now,
      quarantineCooldownMs: 100,
    });

    admission.quarantinePeerForCooldown(VERIFIED_PEER_ID_CID);
    now += 99;
    expect(admission.isRejectedPeer(VERIFIED_PEER_ID)).toBe(true);

    now += 1;
    expect(admission.isRejectedPeer(VERIFIED_PEER_ID)).toBe(false);
  });

  it('enforces a real active-entry cap with deterministic oldest eviction', () => {
    const admission = new NetworkAdmissionService({
      networkId: 'network-a',
      maxProbeBackoffEntries: 1,
      probeBackoff: { transientBaseMs: 1_000 },
    });

    admission.rememberRetryableProbeFailure(VERIFIED_PEER_ID, 'first', 'transient');
    expect(admission.getRetryableProbeBackoff(VERIFIED_PEER_ID)).toBeDefined();

    admission.rememberRetryableProbeFailure(UNKNOWN_PEER_ID, 'second', 'transient');
    expect(admission.getRetryableProbeBackoff(VERIFIED_PEER_ID)).toBeUndefined();
    expect(admission.getRetryableProbeBackoff(UNKNOWN_PEER_ID)).toMatchObject({
      failures: 1,
      reason: 'second',
    });
  });

  it('shares retryable state across canonical peer-id encodings', () => {
    const admission = new NetworkAdmissionService({ networkId: 'network-a' });

    admission.rememberRetryableProbeFailure(VERIFIED_PEER_ID_CID, 'first', 'transient');
    admission.rememberRetryableProbeFailure(VERIFIED_PEER_ID, 'second', 'transient');

    expect(admission.getRetryableProbeBackoff(VERIFIED_PEER_ID_CID)).toMatchObject({
      failures: 2,
      reason: 'second',
    });
  });

  it('clears retryable state on verification and quarantine transitions', () => {
    const admission = new NetworkAdmissionService({ networkId: 'network-a' });

    admission.rememberRetryableProbeFailure(VERIFIED_PEER_ID, 'timeout', 'transient');
    admission.markVerifiedSameNetwork(VERIFIED_PEER_ID_CID);
    expect(admission.getRetryableProbeBackoff(VERIFIED_PEER_ID)).toBeUndefined();

    admission.rememberRetryableProbeFailure(UNKNOWN_PEER_ID, 'timeout', 'transient');
    admission.quarantinePeerForCooldown(UNKNOWN_PEER_ID);
    expect(admission.getRetryableProbeBackoff(UNKNOWN_PEER_ID)).toBeUndefined();
  });

  it('throws on invalid peer ids for mutating admission operations', () => {
    const admission = new NetworkAdmissionService({ networkId: 'network-a' });

    expect(() => admission.markVerifiedSameNetwork('not-a-peer-id')).toThrow('Invalid peer id not-a-peer-id');
    expect(() => admission.quarantinePeer('not-a-peer-id')).toThrow('Invalid peer id not-a-peer-id');
    expect(() => admission.rememberRetryableProbeFailure('not-a-peer-id', 'timeout', 'transient'))
      .toThrow('Invalid peer id not-a-peer-id');
  });
});
