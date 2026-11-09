import { describe, expect, it } from 'vitest';
import {
  PEER_PROFILE_FOLLOW_UP_DELAYS_MS,
  PeerProfileFollowUp,
  peerProfileFollowUpFor,
} from '../src/sync/peer-profile-follow-up.js';
import { PeerEventLifetime } from '../src/p2p/peer-event-lifetime.js';

const PEER = '12D3KooWPeerProfileFollowUpRemote';

/**
 * A follow-up whose timers the test fires by hand. `profileAfterPulls` is how
 * many pulls the peer's profile needs to show up (Infinity: never).
 */
function harness({ profileAfterPulls = 1, connected = true, failPulls = 0 } = {}) {
  const timers: Array<{ run: () => void; delayMs: number; cleared: boolean }> = [];
  const pulls: string[] = [];
  const logs: string[] = [];
  const state = { connected, pullsDone: 0, failPulls };
  const followUp = new PeerProfileFollowUp({
    hasProfile: async () => state.pullsDone >= profileAfterPulls,
    isConnected: () => state.connected,
    pullAgents: async (peerId) => {
      pulls.push(peerId);
      if (state.failPulls > 0) {
        state.failPulls -= 1;
        throw new Error('stream reset');
      }
      state.pullsDone += 1;
    },
    logInfo: (message) => { logs.push(message); },
    setTimer: (run, delayMs) => {
      const timer = { run, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { (timer as { cleared: boolean }).cleared = true; },
  });
  const pending = () => timers.filter((timer) => !timer.cleared);
  /** Fire the newest pending timer and let its pull settle. */
  const fire = async () => {
    const timer = pending().at(-1);
    if (!timer) throw new Error('no pending timer');
    timer.cleared = true;
    timer.run();
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  };
  return { followUp, timers, pending, fire, pulls, logs, state };
}

describe('peer profile follow-up', () => {
  it('does nothing when the pull already brought the peer\'s own profile', async () => {
    const h = harness({ profileAfterPulls: 0 });
    await h.followUp.observePull(PEER);
    expect(h.timers).toEqual([]);
    expect(h.pulls).toEqual([]);
  });

  it('pulls again after the first delay and stops once the profile is there', async () => {
    const h = harness({ profileAfterPulls: 1 });
    await h.followUp.observePull(PEER);
    expect(h.pending().map((timer) => timer.delayMs)).toEqual([PEER_PROFILE_FOLLOW_UP_DELAYS_MS[0]]);
    expect(h.pulls).toEqual([]);

    await h.fire();
    expect(h.pulls).toEqual([PEER]);
    expect(h.pending()).toEqual([]);
    expect(h.logs).toEqual([`Pulled the own profile of ${PEER.slice(-8)} with follow-up pull 1 of its agents graph`]);
    // The episode is over: the next pull without the profile may start another.
    await h.followUp.observePull(PEER);
    expect(h.pending()).toEqual([]);
  });

  it('gives up after one pull per delay when the profile never shows up', async () => {
    const h = harness({ profileAfterPulls: Infinity });
    await h.followUp.observePull(PEER);
    for (const delayMs of PEER_PROFILE_FOLLOW_UP_DELAYS_MS) {
      expect(h.pending().map((timer) => timer.delayMs)).toEqual([delayMs]);
      await h.fire();
    }
    expect(h.pulls).toHaveLength(PEER_PROFILE_FOLLOW_UP_DELAYS_MS.length);
    expect(h.pending()).toEqual([]);
    expect(h.logs.at(-1)).toBe(
      `Agents graph of ${PEER.slice(-8)} still lacks the peer's own profile after ${PEER_PROFILE_FOLLOW_UP_DELAYS_MS.length} follow-up pull(s)`,
    );
    // Later passes without the profile start no other episode for that peer; another peer still gets one.
    await h.followUp.observePull(PEER);
    expect(h.pending()).toEqual([]);
    await h.followUp.observePull('12D3KooWPeerProfileFollowUpOther');
    expect(h.pending()).toHaveLength(1);
  });

  it('counts a failed pull as an attempt and tries again', async () => {
    const h = harness({ profileAfterPulls: 1, failPulls: 1 });
    await h.followUp.observePull(PEER);
    await h.fire();
    expect(h.pulls).toEqual([PEER]);
    expect(h.pending().map((timer) => timer.delayMs)).toEqual([PEER_PROFILE_FOLLOW_UP_DELAYS_MS[1]]);
    await h.fire();
    expect(h.pulls).toEqual([PEER, PEER]);
    expect(h.pending()).toEqual([]);
  });

  it('ends the episode without a pull once the peer is gone', async () => {
    const h = harness({ profileAfterPulls: 1 });
    await h.followUp.observePull(PEER);
    h.state.connected = false;
    await h.fire();
    expect(h.pulls).toEqual([]);
    expect(h.pending()).toEqual([]);
  });

  it('runs one episode per peer at a time', async () => {
    const h = harness({ profileAfterPulls: 1 });
    await Promise.all([h.followUp.observePull(PEER), h.followUp.observePull(PEER)]);
    await h.followUp.observePull(PEER);
    expect(h.pending()).toHaveLength(1);
    await h.followUp.observePull('12D3KooWPeerProfileFollowUpOther');
    expect(h.pending()).toHaveLength(2);
  });

  it('cancels pending pulls on close and starts nothing afterwards', async () => {
    const h = harness({ profileAfterPulls: 1 });
    await h.followUp.observePull(PEER);
    const [timer] = h.pending();
    h.followUp.close();
    expect(timer.cleared).toBe(true);
    timer.run();
    await Promise.resolve();
    await h.followUp.observePull(PEER);
    expect(h.pulls).toEqual([]);
    expect(h.pending()).toEqual([]);
  });

  it('a store that cannot be read starts no episode', async () => {
    const pulls: string[] = [];
    const followUp = new PeerProfileFollowUp({
      hasProfile: async () => { throw new Error('store closed'); },
      isConnected: () => true,
      pullAgents: async (peerId) => { pulls.push(peerId); },
      logInfo: () => {},
      setTimer: () => { throw new Error('no timer expected'); },
    });
    await followUp.observePull(PEER);
    expect(pulls).toEqual([]);
  });

  it('keeps one follow-up per peer sync session and closes it with the session', async () => {
    const timers: Array<{ cleared: boolean }> = [];
    const create = () => new PeerProfileFollowUp({
      hasProfile: async () => false,
      isConnected: () => true,
      pullAgents: async () => {},
      logInfo: () => {},
      setTimer: () => {
        const timer = { cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => { (timer as { cleared: boolean }).cleared = true; },
    });
    const session = new PeerEventLifetime();
    const followUp = peerProfileFollowUpFor(session, create);
    expect(peerProfileFollowUpFor(session, create)).toBe(followUp);
    await followUp.observePull(PEER);
    expect(timers).toEqual([{ cleared: false }]);
    session.close();
    expect(timers).toEqual([{ cleared: true }]);
    await followUp.observePull(PEER);
    expect(timers).toHaveLength(1);
    // A session closed before first use gets a follow-up that is closed already.
    const closed = new PeerEventLifetime();
    closed.close();
    const late = peerProfileFollowUpFor(closed, create);
    expect(late).not.toBe(followUp);
    await late.observePull(PEER);
    expect(timers).toHaveLength(1);
  });
});
