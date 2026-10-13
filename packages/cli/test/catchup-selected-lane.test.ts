// The wait of a catch-up job for the selected SWM lane of its graph, on its
// own: an authority double, fake timers and the window. What the wait does to
// a whole job is covered where the job runs: through the bridge in
// `catchup-runner-worker-lifecycle.test.ts`, and through the bridge and the
// worker in `context-graph-catchup-readiness.test.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SELECTED_LANE_ACTIVATION_WAIT_MS,
  SelectedLaneActivationWait,
  legacySharedMemoryLaneAllowed,
  selectedSharedMemoryLaneActive,
} from '../src/catchup-selected-lane.js';

type Authority = { lane: string | null; active: boolean };

/** The public policy is accepted; the selection that activates the lane is not committed. */
const PENDING: Authority = { lane: 'selected-public', active: false };
const ACTIVE: Authority = { lane: 'selected-public', active: true };
/** No accepted public policy: a graph the node is no member of, say. */
const NONE: Authority = { lane: null, active: false };

function waitingNode(initial: Authority = PENDING) {
  let authority = initial;
  const info = vi.fn();
  return {
    agent: { resolveRfc64SwmRecoveryRuntimeAuthorityV1: () => authority, log: { info } },
    info,
    // A window of one second, looked at every 50 ms.
    wait: new SelectedLaneActivationWait(1_000, 50),
    becomes: (next: Authority) => { authority = next; },
  };
}

/** What a call has resolved to so far, without awaiting it. */
function outcome(pending: Promise<boolean>): { value?: boolean } {
  const seen: { value?: boolean } = {};
  void pending.then((value) => { seen.value = value; });
  return seen;
}

describe('SelectedLaneActivationWait', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('gives a job ten seconds by default', () => {
    expect(SELECTED_LANE_ACTIVATION_WAIT_MS).toBe(10_000);
  });

  it('answers at once when no job has opened a window for the graph', async () => {
    const { agent, info, wait } = waitingNode();

    await expect(wait.untilActive(agent, 'cg')).resolves.toBe(false);
    expect(info).not.toHaveBeenCalled();
  });

  it('lets the calls of one job wait out one window together, and says so once', async () => {
    // A lane that is accepted and never activated.
    const { agent, info, wait } = waitingNode();

    wait.begin('cg');
    const walk = [0, 1, 2].map(() => outcome(wait.untilActive(agent, 'cg')));
    await vi.advanceTimersByTimeAsync(999);
    expect(walk.map((call) => call.value)).toEqual([undefined, undefined, undefined]);
    await vi.advanceTimersByTimeAsync(2);
    expect(walk.map((call) => call.value)).toEqual([false, false, false]);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![1]).toBe(
      'Catch-up for "cg": the selected SWM lane is still not active after 1000 ms',
    );

    // Later peers of the same job, and its later passes, do not wait again.
    await expect(wait.untilActive(agent, 'cg')).resolves.toBe(false);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('ends the wait at the next look once the lane is active', async () => {
    const { agent, info, wait, becomes } = waitingNode();

    wait.begin('cg');
    const call = outcome(wait.untilActive(agent, 'cg'));
    await vi.advanceTimersByTimeAsync(120);
    expect(call.value).toBeUndefined();
    becomes(ACTIVE);
    await vi.advanceTimersByTimeAsync(50);
    expect(call.value).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![1]).toMatch(
      /^Catch-up for "cg": the selected SWM lane became active after \d+ ms$/,
    );

    // An active lane never waits, inside a window or outside one.
    await expect(wait.untilActive(agent, 'cg')).resolves.toBe(true);
    await expect(wait.untilActive(agent, 'cg-other')).resolves.toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('gives every job a window of its own', async () => {
    const { agent, wait, becomes } = waitingNode();

    wait.begin('cg');
    const first = outcome(wait.untilActive(agent, 'cg'));
    await vi.advanceTimersByTimeAsync(1_001);
    expect(first.value).toBe(false);

    // The next job for the graph waits again, and so does a job for another
    // graph while the first window is long over.
    wait.begin('cg');
    wait.begin('cg-other');
    const second = outcome(wait.untilActive(agent, 'cg'));
    const other = outcome(wait.untilActive(agent, 'cg-other'));
    await vi.advanceTimersByTimeAsync(500);
    expect([second.value, other.value]).toEqual([undefined, undefined]);
    becomes(ACTIVE);
    await vi.advanceTimersByTimeAsync(50);
    expect([second.value, other.value]).toEqual([true, true]);
  });

  it('does not wait for a graph without an accepted public policy', async () => {
    const { agent, info, wait, becomes } = waitingNode(NONE);

    wait.begin('cg-outsider');
    await expect(wait.untilActive(agent, 'cg-outsider')).resolves.toBe(false);
    expect(info).not.toHaveBeenCalled();

    // A policy that goes away ends a wait that was under way.
    becomes(PENDING);
    const call = outcome(wait.untilActive(agent, 'cg-outsider'));
    await vi.advanceTimersByTimeAsync(60);
    expect(call.value).toBeUndefined();
    becomes(NONE);
    await vi.advanceTimersByTimeAsync(50);
    expect(call.value).toBe(false);
  });

  it('ends the wait of a job that is still in its window when the runner closes', async () => {
    const { agent, wait } = waitingNode();

    wait.begin('cg-closing');
    const call = outcome(wait.untilActive(agent, 'cg-closing'));
    await vi.advanceTimersByTimeAsync(60);
    expect(call.value).toBeUndefined();
    wait.close();
    await vi.advanceTimersByTimeAsync(50);
    expect(call.value).toBe(false);
  });
});

describe('selected lane predicates', () => {
  it('reads the lane as active only for an active selected-public authority', () => {
    const withAuthority = (authority: unknown) => ({
      resolveRfc64SwmRecoveryRuntimeAuthorityV1: () => authority,
    });
    expect(selectedSharedMemoryLaneActive(withAuthority(ACTIVE), 'cg')).toBe(true);
    expect(selectedSharedMemoryLaneActive(withAuthority(PENDING), 'cg')).toBe(false);
    expect(selectedSharedMemoryLaneActive(withAuthority(NONE), 'cg')).toBe(false);
    expect(selectedSharedMemoryLaneActive(
      withAuthority({ lane: 'ordinary-private', active: true }),
      'cg',
    )).toBe(false);
    // An agent without the resolver leaves the decision to the lease.
    expect(selectedSharedMemoryLaneActive({}, 'cg')).toBe(true);
  });

  it('allows the ordinary lane only on the agent\'s own word', async () => {
    await expect(legacySharedMemoryLaneAllowed({}, 'cg')).resolves.toBe(false);
    await expect(legacySharedMemoryLaneAllowed(
      { canUseLegacySharedMemorySyncForContextGraphV1: async () => true },
      'cg',
    )).resolves.toBe(true);
    await expect(legacySharedMemoryLaneAllowed(
      { canUseLegacySharedMemorySyncForContextGraphV1: async () => false },
      'cg',
    )).resolves.toBe(false);
  });
});
