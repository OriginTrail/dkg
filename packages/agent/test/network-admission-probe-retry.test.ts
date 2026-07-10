import { describe, expect, it } from 'vitest';
import { NetworkAdmissionProbeRetryState } from '../src/p2p/network-admission-probe-retry.js';
import { canonicalPeerIdString } from '../src/p2p/peer-id.js';

const PEER_A = canonicalPeerIdString('12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6');
const PEER_B = canonicalPeerIdString('12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh');
const PEER_C = canonicalPeerIdString('12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb');

function buildRetryState(input: {
  now: () => number;
  maxEntries?: number;
  transientBaseMs?: number;
  transientMaxMs?: number;
  unreadableResponseMs?: number;
}) {
  return new NetworkAdmissionProbeRetryState({
    now: input.now,
    ...(input.maxEntries !== undefined ? { maxEntries: input.maxEntries } : {}),
    backoff: {
      transientBaseMs: input.transientBaseMs ?? 100,
      transientMaxMs: input.transientMaxMs ?? 1_000,
      unreadableResponseMs: input.unreadableResponseMs ?? 250,
    },
  });
}

describe('NetworkAdmissionProbeRetryState', () => {
  it('uses the production transient growth/cap and fixed unreadable defaults', () => {
    let now = 1_000;
    const state = new NetworkAdmissionProbeRetryState({ now: () => now });

    for (const [index, delayMs] of [15_000, 30_000, 60_000, 120_000, 120_000].entries()) {
      state.recordFailure(PEER_A, `transient ${index + 1}`, 'transient');
      expect(state.getActiveSuppression(PEER_A)).toMatchObject({
        failures: index + 1,
        retryAfterMs: delayMs,
      });
      now += delayMs;
      expect(state.getActiveSuppression(PEER_A)).toBeUndefined();
    }

    state.recordFailure(PEER_B, 'unreadable 1', 'unreadable-response');
    expect(state.getActiveSuppression(PEER_B)).toMatchObject({
      failures: 1,
      retryAfterMs: 60_000,
    });
    now += 60_000;
    state.recordFailure(PEER_B, 'unreadable 2', 'unreadable-response');
    expect(state.getActiveSuppression(PEER_B)).toMatchObject({
      failures: 2,
      retryAfterMs: 60_000,
    });
  });

  it('expires active suppression while retaining failure history', () => {
    let now = 1_000;
    const state = buildRetryState({ now: () => now });

    state.recordFailure(PEER_A, 'first', 'transient');
    expect(state.getActiveSuppression(PEER_A)).toMatchObject({
      failures: 1,
      reason: 'first',
      retryAfterMs: 100,
    });

    now += 100;
    expect(state.getActiveSuppression(PEER_A)).toBeUndefined();

    state.recordFailure(PEER_A, 'second', 'transient');
    expect(state.getActiveSuppression(PEER_A)).toMatchObject({
      failures: 2,
      reason: 'second',
      retryAfterMs: 200,
    });
  });

  it('shares failure history across retry kinds while preserving kind-specific delays', () => {
    let now = 1_000;
    const state = buildRetryState({ now: () => now });

    state.recordFailure(PEER_A, 'timeout', 'transient');
    now += 100;
    state.recordFailure(PEER_A, 'malformed', 'unreadable-response');
    expect(state.getActiveSuppression(PEER_A)).toMatchObject({
      failures: 2,
      kind: 'unreadable-response',
      retryAfterMs: 250,
    });

    now += 250;
    state.recordFailure(PEER_A, 'timeout again', 'transient');
    expect(state.getActiveSuppression(PEER_A)).toMatchObject({
      failures: 3,
      kind: 'transient',
      retryAfterMs: 400,
    });
  });

  it('discards expired history before evicting active state at capacity', () => {
    let now = 1_000;
    const state = buildRetryState({ now: () => now, maxEntries: 2 });

    state.recordFailure(PEER_A, 'first', 'transient');
    now += 50;
    state.recordFailure(PEER_B, 'second', 'transient');
    now += 50;
    expect(state.getActiveSuppression(PEER_A)).toBeUndefined();
    expect(state.getActiveSuppression(PEER_B)).toBeDefined();

    state.recordFailure(PEER_C, 'third', 'transient');
    expect(state.getActiveSuppression(PEER_B)).toBeDefined();
    expect(state.getActiveSuppression(PEER_C)).toBeDefined();

    state.recordFailure(PEER_A, 'new history', 'transient');
    expect(state.getActiveSuppression(PEER_A)).toMatchObject({ failures: 1 });
  });

  it('evicts the least-recently-updated active entry when all entries are active', () => {
    const state = buildRetryState({ now: () => 1_000, maxEntries: 2, transientBaseMs: 1_000 });

    state.recordFailure(PEER_A, 'first', 'transient');
    state.recordFailure(PEER_B, 'second', 'transient');
    state.recordFailure(PEER_C, 'third', 'transient');

    expect(state.getActiveSuppression(PEER_A)).toBeUndefined();
    expect(state.getActiveSuppression(PEER_B)).toBeDefined();
    expect(state.getActiveSuppression(PEER_C)).toBeDefined();

    state.recordFailure(PEER_A, 'after eviction', 'transient');
    expect(state.getActiveSuppression(PEER_A)).toMatchObject({ failures: 1 });
  });

  it('refreshes recency when an existing peer records another failure', () => {
    const state = buildRetryState({ now: () => 1_000, maxEntries: 2, transientBaseMs: 1_000 });

    state.recordFailure(PEER_A, 'first', 'transient');
    state.recordFailure(PEER_B, 'second', 'transient');
    state.recordFailure(PEER_A, 'first again', 'transient');
    state.recordFailure(PEER_C, 'third', 'transient');

    expect(state.getActiveSuppression(PEER_A)).toMatchObject({ failures: 2 });
    expect(state.getActiveSuppression(PEER_B)).toBeUndefined();
    expect(state.getActiveSuppression(PEER_C)).toBeDefined();

    state.recordFailure(PEER_B, 'after eviction', 'transient');
    expect(state.getActiveSuppression(PEER_B)).toMatchObject({ failures: 1 });
  });

  it('clears failure history and suppression together', () => {
    const state = buildRetryState({ now: () => 1_000 });

    state.recordFailure(PEER_A, 'first', 'transient');
    state.clear(PEER_A);
    expect(state.getActiveSuppression(PEER_A)).toBeUndefined();

    state.recordFailure(PEER_A, 'after clear', 'transient');
    expect(state.getActiveSuppression(PEER_A)).toMatchObject({ failures: 1 });
  });
});
