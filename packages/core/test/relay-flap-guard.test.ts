import { describe, expect, it } from 'vitest';
import { RelayFlapGuard, buildRelayFlapConnectionGater } from '../src/relay-flap-guard.js';

const RELAY_A = '12D3KooWRelayA';
const RELAY_B = '12D3KooWRelayB';
const REMOTE_A = '12D3KooWRemoteA';
const REMOTE_B = '12D3KooWRemoteB';

function guard(): RelayFlapGuard {
  return new RelayFlapGuard({
    shortCloseMs: 100,
    windowMs: 1_000,
    threshold: 3,
    baseQuarantineMs: 200,
    maxQuarantineMs: 800,
    stableCloseMs: 1_000,
    denyLogIntervalMs: 50,
  });
}

function recordShortBurst(g: RelayFlapGuard, relayPeerId = RELAY_A, remotePeerId = REMOTE_A): void {
  expect(g.recordRelayedClose({ relayPeerId, remotePeerId, durationMs: 50, now: 0 }).enteredQuarantine).toBe(false);
  expect(g.recordRelayedClose({ relayPeerId, remotePeerId, durationMs: 50, now: 10 }).enteredQuarantine).toBe(false);
  expect(g.recordRelayedClose({ relayPeerId, remotePeerId, durationMs: 50, now: 20 }).enteredQuarantine).toBe(true);
}

describe('RelayFlapGuard', () => {
  it('quarantines the exact relay/remote pair after repeated short relayed closes', () => {
    const g = guard();
    recordShortBurst(g);

    const denied = g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 25 });
    expect(denied.deny).toBe(true);
    expect(denied.shouldLog).toBe(true);
    expect(denied.quarantineMsRemaining).toBe(195);

    const repeatedDenied = g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 30 });
    expect(repeatedDenied.deny).toBe(true);
    expect(repeatedDenied.shouldLog).toBe(false);
  });

  it('does not quarantine below the short-close threshold', () => {
    const g = guard();
    g.recordRelayedClose({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, durationMs: 50, now: 0 });
    g.recordRelayedClose({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, durationMs: 50, now: 10 });

    expect(g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 20 }).deny).toBe(false);
    expect(g.getPairState(RELAY_A, REMOTE_A, 20)?.shortCloseCount).toBe(2);
  });

  it('does not quarantine long-lived relayed closes and clears prior penalty', () => {
    const g = guard();
    g.recordRelayedClose({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, durationMs: 50, now: 0 });
    g.recordRelayedClose({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, durationMs: 50, now: 10 });

    const result = g.recordRelayedClose({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, durationMs: 1_000, now: 20 });
    expect(result.cleared).toBe(true);
    expect(g.getPairState(RELAY_A, REMOTE_A, 20)).toBeUndefined();
  });

  it('isolates quarantine by both relay peer and remote peer', () => {
    const g = guard();
    recordShortBurst(g, RELAY_A, REMOTE_A);

    expect(g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 30 }).deny).toBe(true);
    expect(g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_B, now: 30 }).deny).toBe(false);
    expect(g.checkRelayedConnection({ relayPeerId: RELAY_B, remotePeerId: REMOTE_A, now: 30 }).deny).toBe(false);
  });

  it('expires quarantine and allows later relayed attempts', () => {
    const g = guard();
    recordShortBurst(g);

    expect(g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 219 }).deny).toBe(true);
    expect(g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 221 }).deny).toBe(false);
  });

  it('clears penalty after a stable direct close from the same remote peer', () => {
    const g = guard();
    recordShortBurst(g);
    expect(g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 25 }).deny).toBe(true);

    expect(g.recordDirectClose({ remotePeerId: REMOTE_A, durationMs: 1_000 })).toBe(1);
    expect(g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 30 }).deny).toBe(false);
  });

  it('does not clear relay penalty for short direct closes', () => {
    const g = guard();
    recordShortBurst(g);

    expect(g.recordDirectClose({ remotePeerId: REMOTE_A, durationMs: 50 })).toBe(0);
    expect(g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 30 }).deny).toBe(true);
  });

  it('does not accumulate short closes that age out of the rolling window', () => {
    const g = guard();
    // Two short closes early, then one AFTER the window has fully elapsed. The
    // first two must be pruned, so the late one is the only in-window close and
    // never reaches the quarantine threshold (a regression that stops pruning
    // would let three closes across a >window span trip quarantine).
    expect(g.recordRelayedClose({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, durationMs: 50, now: 0 }).enteredQuarantine).toBe(false);
    expect(g.recordRelayedClose({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, durationMs: 50, now: 10 }).enteredQuarantine).toBe(false);
    const late = g.recordRelayedClose({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, durationMs: 50, now: 1_100 });
    expect(late.enteredQuarantine).toBe(false);
    expect(late.shortCloseCount).toBe(1);
    expect(g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 1_100 }).deny).toBe(false);
  });

  it('evicts idle pairs so the tracking map stays bounded', () => {
    const g = guard();
    recordShortBurst(g); // quarantines RELAY_A/REMOTE_A until now=220
    expect(g.getPairState(RELAY_A, REMOTE_A, 25)).toBeDefined();

    // Once the quarantine lapses, the next check must drop the now-idle entry
    // (no in-window closes, no active quarantine) — otherwise the map leaks one
    // entry per relay/remote pair forever on a long-lived node.
    expect(g.checkRelayedConnection({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, now: 5_000 }).deny).toBe(false);
    expect(g.getPairState(RELAY_A, REMOTE_A, 5_000)).toBeUndefined();
  });
});

describe('buildRelayFlapConnectionGater (libp2p wiring)', () => {
  it('denies the quarantined relayed path through the actual gater hook arg-shapes', () => {
    // Long quarantine so the gater's real-clock checkRelayedConnection() stays
    // inside the window for the synchronous assertions below.
    const g = new RelayFlapGuard({
      shortCloseMs: 100,
      windowMs: 60_000,
      threshold: 3,
      baseQuarantineMs: 60_000,
      maxQuarantineMs: 60_000,
      stableCloseMs: 60_000,
    });
    const now = Date.now();
    g.recordRelayedClose({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, durationMs: 50, now });
    g.recordRelayedClose({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, durationMs: 50, now: now + 10 });
    expect(
      g.recordRelayedClose({ relayPeerId: RELAY_A, remotePeerId: REMOTE_A, durationMs: 50, now: now + 20 }).enteredQuarantine,
    ).toBe(true);

    const gater = buildRelayFlapConnectionGater(g);

    // denyDialMultiaddr is SINGLE-ARG in libp2p >=3.x — the peer ids ride in the
    // /p2p-circuit multiaddr. A regression to a (peerId, multiaddr) shape would
    // break this assertion (which is what the review comment feared).
    expect(gater.denyDialMultiaddr(`/ip4/1.2.3.4/tcp/9090/p2p/${RELAY_A}/p2p-circuit/p2p/${REMOTE_A}`)).toBe(true);
    // A different relayed pair is not quarantined → allowed.
    expect(gater.denyDialMultiaddr(`/ip4/1.2.3.4/tcp/9090/p2p/${RELAY_B}/p2p-circuit/p2p/${REMOTE_B}`)).toBe(false);
    // A direct (non-circuit) multiaddr is never gated.
    expect(gater.denyDialMultiaddr(`/ip4/1.2.3.4/tcp/9090/p2p/${REMOTE_A}`)).toBe(false);

    // The inbound hook (relay, remotePeer) also denies the quarantined pair.
    expect(gater.denyInboundRelayedConnection({ toString: () => RELAY_A }, { toString: () => REMOTE_A })).toBe(true);
    expect(gater.denyInboundRelayedConnection({ toString: () => RELAY_B }, { toString: () => REMOTE_B })).toBe(false);
  });

});
