// A member of a public graph that is registered on chain stayed `synced: false`
// when its catch-up job walked its peers before the node had accepted the
// graph's RFC-64 authority (issue #3281, seen on the devnet with the 10.0.25
// candidate). The graph's selected shared-memory lane was not active yet, so
// the walk asked no peer anything; the authority arrived about a second later,
// and nothing ran the job again. After a restart, the job that catches up the
// restored subscription met the same race, the authority 21 s after the walk.
//
// First: the harness mocks `node:worker_threads`, so the catch-up runner loaded
// below runs its real worker, and its real wait for the selected lane, in this
// thread.
import './helpers/catchup-runner-worker-test-harness.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CatchupRunner } from '../src/catchup-runner.js';
import {
  CG,
  PEERS,
  emptyAnswer,
  memberEdge,
  revokedAnswer,
  waitUntil,
} from './_helpers/readiness-member-edge.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

await import('../src/catchup-runner-worker-impl.js');
const { createCatchupRunner } = await import('../src/catchup-runner.js');
const { handleContextGraphRoutes } = await import('../src/daemon/routes/context-graph.js');
const { daemonState } = await import('../src/daemon/state.js');
const {
  CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS,
  readinessRepeatTimers,
  cancelContextGraphReadinessRepeats,
} = await import('../src/daemon/context-graph-readiness-repeat.js');
const { startActivationCatchups } = await import('../src/daemon/context-graph-activation-catchup.js');

/** Admission of a public graph registered on chain: its finalized public policy. */
const REGISTERED_PUBLIC = Object.freeze({
  outcome: 'allowed', source: 'registered-chain', reason: 'chain-public',
  metadataBootstrap: 'eligible', grantScope: 'public',
});

/** The row the agent installs when it restores a subscription whose job never proved it. */
const RESTORED_UNSYNCED = Object.freeze({
  subscribed: true, synced: false, sharedMemorySynced: false, metaSynced: true, syncMode: 'always-on',
});

type Tracker = { jobs: Map<string, any>; latestByContextGraph: Map<string, string> };

interface ArmedTimer {
  readonly callback: () => void;
  readonly delayMs: number;
  cleared: boolean;
  fired: boolean;
}

describe('a registered public graph whose catch-up ran before its authority was accepted is caught up again', () => {
  const previousRunner = daemonState.catchupRunner;
  const originalTimers = { set: readinessRepeatTimers.set, clear: readinessRepeatTimers.clear };
  const timers: ArmedTimer[] = [];
  const servers: Server[] = [];
  const runners: CatchupRunner[] = [];
  const stops: Array<() => void> = [];

  beforeEach(() => {
    readinessRepeatTimers.set = (callback: () => void, delayMs: number) => {
      const timer: ArmedTimer = { callback, delayMs, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    };
    readinessRepeatTimers.clear = (handle: unknown) => {
      (handle as ArmedTimer).cleared = true;
    };
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    cancelContextGraphReadinessRepeats();
    readinessRepeatTimers.set = originalTimers.set;
    readinessRepeatTimers.clear = originalTimers.clear;
    timers.length = 0;
    daemonState.catchupRunner = previousRunner;
    daemonState.catchupAcceptingJobs = true;
    vi.restoreAllMocks();
    for (const runner of runners.splice(0)) await runner.close();
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  /** Timers armed and not yet fired or cleared. */
  const armed = () => timers.filter((timer) => !timer.cleared && !timer.fired);

  function fire(timer: ArmedTimer | undefined): void {
    if (!timer) throw new Error('no repeat armed');
    timer.fired = true;
    timer.callback();
  }

  /**
   * A member Edge of the registered graph, with the real catch-up runner. The
   * node has not accepted the graph's RFC-64 authority yet: the graph has no
   * selected shared-memory lane, so the runner's wait for the lane has nothing
   * to wait for, and the walk asks no peer anything.
   */
  function registeredMember() {
    const member = memberEdge();
    member.node.authority = REGISTERED_PUBLIC;
    let accepted = false;
    const asked: string[] = [];
    const agent = member.agent as any;
    agent.resolveRfc64SwmRecoveryRuntimeAuthorityV1 = (contextGraphId: string) => ({
      kind: 'rfc64-swm-recovery-runtime-authority-v1',
      contextGraphId,
      lane: accepted ? 'selected-public' : null,
      active: accepted,
    });
    agent.syncSelectedSharedMemoryFromPeerDetailed = async (peerId: string) => {
      asked.push(peerId);
      return member.node.answer(peerId);
    };
    const runner = createCatchupRunner(member.agent);
    runners.push(runner);
    daemonState.catchupRunner = runner;
    return {
      member,
      asked,
      /** The node accepts the graph's authority and activates its lane. */
      acceptAuthority: () => { accepted = true; },
    };
  }

  async function startRoutes(member: ReturnType<typeof memberEdge>) {
    const catchupTracker: Tracker = { jobs: new Map(), latestByContextGraph: new Map() };
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      await handleContextGraphRoutes({
        req,
        res,
        agent: member.agent,
        dashDb: member.store,
        catchupTracker,
        url,
        path: url.pathname,
        authentication: requestAuthentication({ kind: 'nodeOperator' }),
      } as any);
      if (!res.writableEnded) {
        res.statusCode = 404;
        res.end();
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      catchupTracker,
      /** Subscribe; resolves with the job once it has finished. */
      async subscribe(includeSharedMemory = true): Promise<any> {
        const response = await fetch(`http://127.0.0.1:${port}/api/context-graph/subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contextGraphId: CG, includeSharedMemory }),
        });
        expect(response.status).toBe(200);
        const { jobId } = ((await response.json()) as { catchup: { jobId: string } }).catchup;
        return waitUntil(() => {
          const job = catchupTracker.jobs.get(jobId);
          return job?.finishedAt ? job : undefined;
        }, `job ${jobId}`);
      },
    };
  }

  /** The graph's latest job, other than `previousJobId`, once it has finished. */
  function nextFinishedJob(catchupTracker: Tracker, previousJobId?: string): Promise<any> {
    return waitUntil(() => {
      const latest = catchupTracker.latestByContextGraph.get(CG);
      const job = latest === undefined || latest === previousJobId ? undefined : catchupTracker.jobs.get(latest);
      return job?.finishedAt ? job : undefined;
    }, 'the next job to finish');
  }

  it('repeats the subscribe job once the authority is in place, and the member is proven synced', async () => {
    const { member, asked, acceptAuthority } = registeredMember();
    const api = await startRoutes(member);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const first = await api.subscribe();

    // The walk ran before the authority: no peer was asked for the graph's
    // shared memory, and the subscription stays unsynced.
    expect(asked).toEqual([]);
    expect(member.subscription()).toMatchObject({ subscribed: true, synced: false });
    // Before the fix a registered graph was never repeated: synced stayed
    // false until the next restart.
    expect(armed().map((timer) => timer.delayMs)).toEqual([CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS[0]]);
    expect(first.selectedLaneFoundInactive).toBe(true);

    // The authority is accepted a second later; the repeat comes due after it.
    acceptAuthority();
    fire(armed()[0]);
    const repeat = await nextFinishedJob(api.catchupTracker, first.jobId);

    expect([...asked].sort()).toEqual([...PEERS].sort());
    expect(repeat.selectedLaneFoundInactive).toBeUndefined();
    expect(repeat.result.cleanPlaneCompletions.sharedMemory).toMatchObject({ emptyPeers: PEERS.length });
    expect(member.subscription()).toMatchObject({ subscribed: true, synced: true, sharedMemorySynced: true });
    expect(member.readiness()).toMatchObject({ sharedMemoryVerified: true });
    expect(armed()).toEqual([]);
    expect(log.mock.calls.flat().join('\n')).toContain(
      `[catchup] repeating the catch-up of "${CG}" (1 of ${CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS.length}): `
        + 'the graph is not proven synced yet; the last attempt ran before its RFC-64 authority was in place',
    );
  });

  it('repeats the job that catches up a restored subscription, while the authority is still on its way', async () => {
    const { member, asked, acceptAuthority } = registeredMember();
    member.restore({ ...RESTORED_UNSYNCED });
    const catchupTracker: Tracker = { jobs: new Map(), latestByContextGraph: new Map() };
    stops.push(startActivationCatchups({
      agent: member.agent, store: member.store, catchupTracker, log: () => {},
    }));

    const restored = await nextFinishedJob(catchupTracker);
    expect(member.subscription()).toMatchObject({ subscribed: true, synced: false });
    expect(armed().map((timer) => timer.delayMs)).toEqual([CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS[0]]);
    expect(restored.selectedLaneFoundInactive).toBe(true);

    // The first repeat comes due while the authority is still on its way (it
    // took 21 s on the devnet): that walk asks nobody either, and the next
    // repeat is armed.
    fire(armed()[0]);
    const early = await nextFinishedJob(catchupTracker, restored.jobId);
    expect(early.selectedLaneFoundInactive).toBe(true);
    expect(asked).toEqual([]);
    expect(member.subscription()).toMatchObject({ subscribed: true, synced: false });
    expect(armed().map((timer) => timer.delayMs)).toEqual([CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS[1]]);

    acceptAuthority();
    fire(armed()[0]);
    await nextFinishedJob(catchupTracker, early.jobId);

    expect([...asked].sort()).toEqual([...PEERS].sort());
    expect(member.subscription()).toMatchObject({ subscribed: true, synced: true, sharedMemorySynced: true });
    expect(armed()).toEqual([]);
  });

  it('does not repeat a registered graph whose walk had its lane', async () => {
    // The walk had the lane, and a revoked sync left the round incomplete.
    // That is not this race: a registered graph is not repeated for it.
    const { member, asked, acceptAuthority } = registeredMember();
    acceptAuthority();
    member.node.answer = (peerId) => (peerId === 'peer-1' ? revokedAnswer() : emptyAnswer(peerId));
    const api = await startRoutes(member);

    const job = await api.subscribe();

    expect(asked).toHaveLength(PEERS.length);
    expect(job.selectedLaneFoundInactive).toBeUndefined();
    expect(member.subscription()).toMatchObject({ subscribed: true, synced: false });
    expect(armed()).toEqual([]);
  });

  it('records nothing for a job that did not ask for shared memory', async () => {
    // The first call's walk found the lane not active. A later call without
    // shared memory walks no lane, so the earlier job's finding is not its own.
    const { member } = registeredMember();
    const api = await startRoutes(member);
    expect((await api.subscribe()).selectedLaneFoundInactive).toBe(true);

    const durableOnly = await api.subscribe(false);

    expect(durableOnly.selectedLaneFoundInactive).toBeUndefined();
    expect(armed()).toEqual([]);
  });

  it('does not repeat a subscription known only by its on-chain name hash', async () => {
    // Nothing under a name-hash id can be proven: holders key the graph by its
    // cleartext id. Its job records nothing to repeat for.
    const { member } = registeredMember();
    (member.agent as any).describeContextGraphIdentity = () => ({
      state: 'name-hash-only', message: 'known only by its on-chain name hash',
    });
    const api = await startRoutes(member);

    const job = await api.subscribe();

    expect(job.status).toBe('unreachable');
    expect(job.selectedLaneFoundInactive).toBeUndefined();
    expect(armed()).toEqual([]);
  });
});
