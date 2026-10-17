// A write into a graph this node is still catching up waits, bounded, for the
// catch-up to prove the graph (`context-graph-write-readiness.ts`). These are
// the wait's own rules: what counts as catching up, how a wait ends, and how
// the write is answered. The restarted owner's first write, end to end, is in
// `context-graph-owner-write-after-restart.test.ts`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import type { CatchupRunner } from '../src/catchup-runner.js';
import { beginWalkCatchupJob, catchupJobInFlightFor, releaseCatchupJob } from '../src/daemon/catchup-telemetry.js';
import { startActivationCatchups } from '../src/daemon/context-graph-activation-catchup.js';
import {
  contextGraphCatchupInProgress,
  hurryContextGraphCatchup,
  registerContextGraphCatchupProgress,
} from '../src/daemon/context-graph-catchup-progress.js';
import {
  cancelContextGraphReadinessRepeats,
  readinessRepeatTimers,
} from '../src/daemon/context-graph-readiness-repeat.js';
import {
  awaitContextGraphWriteReadiness,
  knownNotWritableAnswer,
  resolveAwaitingWriteReadiness,
  writeReadinessWait,
  type WriteReadinessOutcome,
} from '../src/daemon/context-graph-write-readiness.js';
import { resolveRequiredWriteContextGraphId } from '../src/daemon/http-utils.js';
import { daemonState } from '../src/daemon/state.js';
import type { CatchupJob } from '../src/daemon/types.js';
import {
  CG, PUBLIC_UNREGISTERED, cleanEmptyRound, lossyEmptyRound, memberEdge, waitUntil,
} from './_helpers/readiness-member-edge.js';

const OTHER_CG = '0x1111111111111111111111111111111111111111/another-graph';

function walkJob(overrides: Partial<CatchupJob> = {}): CatchupJob {
  return {
    jobId: `job-${Math.random().toString(36).slice(2)}`,
    contextGraphId: CG,
    includeWorkspace: true,
    status: 'running',
    queuedAt: Date.now(),
    ...overrides,
  };
}

/** An agent whose subscription rows the test sets. */
function agentWith(rows: Record<string, { subscribed?: boolean; synced?: boolean }>) {
  const subscriptions = new Map(Object.entries(rows));
  return { subscriptions, agent: { getSubscribedContextGraphs: () => subscriptions } };
}

interface ArmedTimer {
  readonly callback: () => void;
  readonly delayMs: number;
  cleared: boolean;
}

describe('a write waits for the catch-up of its graph', () => {
  const originalWait = { ...writeReadinessWait };
  const originalTimers = { set: readinessRepeatTimers.set, clear: readinessRepeatTimers.clear };
  const previousRunner = daemonState.catchupRunner;
  const timers: ArmedTimer[] = [];
  const ledger: Array<ReturnType<typeof beginWalkCatchupJob>> = [];
  const stops: Array<() => void> = [];

  beforeEach(() => {
    writeReadinessWait.timeoutMs = 2_000;
    writeReadinessWait.pollMs = 5;
    readinessRepeatTimers.set = (callback: () => void, delayMs: number) => {
      const timer: ArmedTimer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    };
    readinessRepeatTimers.clear = (handle: unknown) => {
      (handle as ArmedTimer).cleared = true;
    };
  });

  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    for (const entry of ledger.splice(0)) releaseCatchupJob(entry);
    cancelContextGraphReadinessRepeats();
    Object.assign(writeReadinessWait, originalWait);
    readinessRepeatTimers.set = originalTimers.set;
    readinessRepeatTimers.clear = originalTimers.clear;
    timers.length = 0;
    daemonState.catchupRunner = previousRunner;
    daemonState.catchupAcceptingJobs = true;
  });

  const inFlight = (job: CatchupJob) => {
    const entry = beginWalkCatchupJob(job);
    ledger.push(entry);
    return entry;
  };

  describe('what counts as catching a graph up', () => {
    it('is a walk job queued or running for the graph, under the id asked or the id it continued under', () => {
      expect(contextGraphCatchupInProgress(CG)).toBe(false);

      const queued = inFlight(walkJob({ status: 'queued' }));
      expect(catchupJobInFlightFor(CG)).toBe(true);
      expect(contextGraphCatchupInProgress(CG)).toBe(true);
      expect(contextGraphCatchupInProgress(OTHER_CG)).toBe(false);

      // A job that ends is no longer catching anything up, even before its
      // ledger slot is released.
      queued.job.status = 'done';
      expect(catchupJobInFlightFor(CG)).toBe(false);

      inFlight(walkJob({ contextGraphId: '0xabc-name-hash', resolvedContextGraphId: CG }));
      expect(catchupJobInFlightFor(CG)).toBe(true);
    });

    it('is a readiness repeat that follows the graph', async () => {
      // A subscribe job the repeat follows; the unregistered public graph's
      // lossy round leaves it unproven, so the repeat is armed afterwards.
      const member = memberEdge();
      member.restore({ subscribed: true, synced: false });
      const runs: string[] = [];
      daemonState.catchupRunner = {
        run: async (request) => {
          runs.push(request.contextGraphId);
          return lossyEmptyRound();
        },
        close: async () => {},
      } satisfies CatchupRunner;
      const catchupTracker = { jobs: new Map<string, any>(), latestByContextGraph: new Map<string, string>() };
      stops.push(startActivationCatchups({ agent: member.agent, store: member.store, catchupTracker, log: () => {} }));

      await waitUntil(() => (timers.length === 1 ? true : undefined), 'the repeat to be armed');
      expect(runs).toEqual([CG]);
      // The job is over and the activation catch-up has let go of the graph:
      // only the armed repeat is left.
      expect(catchupJobInFlightFor(CG)).toBe(false);
      expect(contextGraphCatchupInProgress(CG)).toBe(true);

      cancelContextGraphReadinessRepeats();
      expect(contextGraphCatchupInProgress(CG)).toBe(false);
    });

    it('is an activation catch-up that has the graph queued, in hand, or due for another admission read', async () => {
      const member = memberEdge();
      member.restore({ subscribed: true, synced: false });
      member.restore({ subscribed: true, synced: false }, OTHER_CG);
      // The first graph's admission read is held: no job exists yet.
      let release!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      member.node.authority = ((async () => {
        await hold;
        return PUBLIC_UNREGISTERED;
      }) as unknown) as typeof member.node.authority;
      daemonState.catchupRunner = {
        run: async () => cleanEmptyRound(),
        close: async () => {},
      } satisfies CatchupRunner;
      const catchupTracker = { jobs: new Map<string, any>(), latestByContextGraph: new Map<string, string>() };
      const stop = startActivationCatchups({ agent: member.agent, store: member.store, catchupTracker, log: () => {} });
      stops.push(stop);

      await waitUntil(() => (member.node.admissionCallers.length > 0 ? true : undefined), 'the admission read');
      expect(catchupJobInFlightFor(CG)).toBe(false);
      expect(contextGraphCatchupInProgress(CG)).toBe(true);
      expect(contextGraphCatchupInProgress(OTHER_CG)).toBe(true);

      // Both jobs run and finish; with their repeats ended, nothing has either graph.
      release();
      await waitUntil(
        () => (catchupTracker.jobs.size === 2 && [...catchupTracker.jobs.values()].every((job) => job.finishedAt)
          ? true : undefined),
        'both jobs to finish',
      );
      cancelContextGraphReadinessRepeats();
      await waitUntil(
        () => (contextGraphCatchupInProgress(CG) || contextGraphCatchupInProgress(OTHER_CG) ? undefined : true),
        'the catch-up to let go of both graphs',
      );

      // A graph whose admission cannot be read now is asked again later, and
      // stays in hand until then.
      const unreadable = memberEdge();
      unreadable.node.authority = { outcome: 'unavailable' };
      unreadable.restore({ subscribed: true, synced: false });
      const stopUnreadable = startActivationCatchups({
        agent: unreadable.agent, store: unreadable.store, catchupTracker, log: () => {},
      });
      stops.push(stopUnreadable);
      await waitUntil(() => (timers.some((timer) => !timer.cleared) ? true : undefined), 'the admission to be asked again');
      expect(catchupJobInFlightFor(CG)).toBe(false);
      expect(contextGraphCatchupInProgress(CG)).toBe(true);

      stopUnreadable();
      expect(contextGraphCatchupInProgress(CG)).toBe(false);
    });

    it('asks every kind of catch-up work to hurry, and forgets one that is removed', () => {
      const hurried: string[] = [];
      const remove = registerContextGraphCatchupProgress({
        catchingUp: (contextGraphId) => contextGraphId === OTHER_CG,
        hurry: (contextGraphId) => { hurried.push(contextGraphId); },
      });
      const removeQuiet = registerContextGraphCatchupProgress({ catchingUp: () => false });
      try {
        expect(contextGraphCatchupInProgress(OTHER_CG)).toBe(true);
        hurryContextGraphCatchup(OTHER_CG);
        expect(hurried).toEqual([OTHER_CG]);
      } finally {
        remove();
        removeQuiet();
      }
      expect(contextGraphCatchupInProgress(OTHER_CG)).toBe(false);
      hurryContextGraphCatchup(OTHER_CG);
      expect(hurried).toEqual([OTHER_CG]);
    });
  });

  describe('how the wait ends', () => {
    it('ends at once when there is nothing to wait for', async () => {
      inFlight(walkJob());
      expect(await awaitContextGraphWriteReadiness({}, CG)).toBe('not-catching-up');
      expect(await awaitContextGraphWriteReadiness(agentWith({}).agent, CG)).toBe('not-catching-up');
      expect(await awaitContextGraphWriteReadiness(agentWith({ [CG]: { subscribed: false } }).agent, CG))
        .toBe('not-catching-up');
      expect(await awaitContextGraphWriteReadiness(agentWith({ [CG]: { subscribed: true, synced: true } }).agent, CG))
        .toBe('ready');
      expect(await awaitContextGraphWriteReadiness(agentWith({ [OTHER_CG]: { subscribed: true } }).agent, OTHER_CG))
        .toBe('not-catching-up');
    });

    it('ends when the catch-up proves the graph', async () => {
      const { agent, subscriptions } = agentWith({ [CG]: { subscribed: true, synced: false } });
      inFlight(walkJob());

      const waiting = awaitContextGraphWriteReadiness(agent, CG);
      setTimeout(() => subscriptions.set(CG, { subscribed: true, synced: true }), 30);

      expect(await waiting).toBe('ready');
    });

    it('ends when the catch-up stops without proving the graph', async () => {
      const { agent } = agentWith({ [CG]: { subscribed: true, synced: false } });
      const job = inFlight(walkJob());

      const waiting = awaitContextGraphWriteReadiness(agent, CG);
      setTimeout(() => { job.job.status = 'unreachable'; }, 30);

      expect(await waiting).toBe('not-catching-up');
    });

    it('ends when the bound passes while the graph is still being caught up', async () => {
      writeReadinessWait.timeoutMs = 60;
      const { agent } = agentWith({ [CG]: { subscribed: true, synced: false } });
      inFlight(walkJob());
      const startedAt = Date.now();

      expect(await awaitContextGraphWriteReadiness(agent, CG)).toBe('timed-out');
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60);
    });
  });

  describe('how the write is resolved and answered', () => {
    it('resolves a target once when the first pass settles it', async () => {
      let passes = 0;
      const refused: string[] = [];
      const refuse = (raw: string) => { refused.push(raw); return null; };

      expect(await resolveAwaitingWriteReadiness({}, async () => { passes += 1; return CG; }, refuse)).toBe(CG);
      expect(await resolveAwaitingWriteReadiness({}, async () => { passes += 1; return null; }, refuse)).toBeNull();
      expect(passes).toBe(2);
      expect(refused).toEqual([]);
    });

    it('resolves the target again once the graph is proven, and refuses it if it is still not writable', async () => {
      const { agent } = agentWith({ [CG]: { subscribed: true, synced: true } });
      const passes: Array<string | { notWritable: string; raw: string } | null> = [
        { notWritable: CG, raw: 'raw-id' }, CG,
      ];
      const refused: Array<[string, WriteReadinessOutcome]> = [];
      const refuse = (raw: string, outcome: WriteReadinessOutcome) => { refused.push([raw, outcome]); return null; };

      expect(await resolveAwaitingWriteReadiness(agent, async () => passes.shift()!, refuse)).toBe(CG);
      expect(refused).toEqual([]);

      // Proven synced, and the second pass still finds the graph not writable.
      const again = [{ notWritable: CG, raw: 'raw-id' }, { notWritable: CG, raw: 'raw-id-again' }];
      expect(await resolveAwaitingWriteReadiness(agent, async () => again.shift()!, refuse)).toBeNull();
      expect(refused).toEqual([['raw-id-again', 'ready']]);
    });

    it('refuses without a second pass when the wait did not end ready', async () => {
      writeReadinessWait.timeoutMs = 30;
      const { agent } = agentWith({ [CG]: { subscribed: true, synced: false } });
      inFlight(walkJob());
      let passes = 0;
      const refused: Array<[string, WriteReadinessOutcome]> = [];

      const resolved = await resolveAwaitingWriteReadiness(
        agent,
        async () => { passes += 1; return { notWritable: CG, raw: 'raw-id' }; },
        (raw, outcome) => { refused.push([raw, outcome]); return null; },
      );

      expect(resolved).toBeNull();
      expect(passes).toBe(1);
      expect(refused).toEqual([['raw-id', 'timed-out']]);
    });

    /** A write preflight's response, as the resolver writes it. */
    function captureResponse() {
      const out: { status?: number; body?: Record<string, unknown> } = {};
      const res = {
        writeHead(status: number) { out.status = status; return res; },
        end(body?: string) { if (body) out.body = JSON.parse(body); },
      } as unknown as ServerResponse;
      return { res, out };
    }

    /** An agent without the exact probe: the preflight resolves through its listing. */
    function listingAgent(rows: Array<Record<string, unknown>>) {
      const subscriptions = new Map<string, { subscribed?: boolean; synced?: boolean }>();
      for (const row of rows) {
        if (row.subscribed === true) subscriptions.set(row.id as string, { subscribed: true, synced: row.synced === true });
      }
      return {
        agent: { listContextGraphs: async () => rows, getSubscribedContextGraphs: () => subscriptions },
        /** The catch-up proves the graph: the listing and the subscription say synced. */
        prove: (contextGraphId: string) => {
          for (const row of rows) if (row.id === contextGraphId) row.synced = true;
          subscriptions.set(contextGraphId, { subscribed: true, synced: true });
        },
      };
    }

    it('waits the same way for a graph that the preflight finds through the listing', async () => {
      const qualified = '0x1111111111111111111111111111111111111111/listed';
      const { agent, prove } = listingAgent([
        { id: qualified, uri: `did:dkg:context-graph:${qualified}`, subscribed: true, synced: false },
      ]);
      inFlight(walkJob({ contextGraphId: qualified }));
      const { res, out } = captureResponse();

      const resolving = resolveRequiredWriteContextGraphId(agent, qualified, res);
      setTimeout(() => prove(qualified), 30);

      expect(await resolving).toBe(qualified);
      expect(out).toEqual({});
    });

    it('waits the same way for a bare id that also names a curated graph', async () => {
      const bare = 'shared-slug';
      const { agent, prove } = listingAgent([
        { id: bare, uri: `did:dkg:context-graph:${bare}`, creator: 'did:dkg:agent:0x2222222222222222222222222222222222222222', subscribed: true, synced: false },
        { id: `0x1111111111111111111111111111111111111111/${bare}`, subscribed: false, synced: false },
      ]);
      inFlight(walkJob({ contextGraphId: bare }));
      const { res, out } = captureResponse();

      const resolving = resolveRequiredWriteContextGraphId(agent, bare, res);
      setTimeout(() => prove(bare), 30);

      expect(await resolving).toBe(bare);
      expect(out).toEqual({});
    });

    it('answers not writable yet, retryable, only when the bound passed while catching up', () => {
      expect(knownNotWritableAnswer('graph-x', 'timed-out')).toEqual({
        status: 503,
        body: {
          code: 'CONTEXT_GRAPH_NOT_WRITABLE',
          retryable: true,
          error: 'Context graph "graph-x" is not writable yet: this node is still catching it up. Retry the write shortly.',
        },
        headers: { 'Retry-After': '5' },
      });
      for (const outcome of ['not-catching-up', 'ready'] as const) {
        expect(knownNotWritableAnswer('graph-x', outcome)).toEqual({
          status: 400,
          body: {
            code: 'CONTEXT_GRAPH_NOT_WRITABLE',
            error: 'Context graph "graph-x" is known but is not locally synced for writes. '
              + 'Subscribe/sync the context graph first, then retry the write.',
          },
        });
      }
    });
  });
});

