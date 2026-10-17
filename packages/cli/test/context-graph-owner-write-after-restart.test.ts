// The owner of a public graph registered on chain restarts its node, and its
// first write into its own graph is refused with CONTEXT_GRAPH_NOT_WRITABLE
// for 13 to 23 s (testnet trials, relay-only Edges). The agent restores the
// owner's subscription unsynced; the job that catches it up walks the graph's
// peers before the node has accepted the graph's RFC-64 authority, so it asks
// nobody and proves nothing; the readiness repeat ran the job again only after
// its first delay, although the job's own last step had just put the authority
// in place; and the write preflight refused the write at once all that time.
//
// Here the owner's node is the member-edge double with the real catch-up
// runner (its worker runs in this thread), the real activation catch-up and
// readiness repeat, the agent's own write-preflight probe over an in-memory
// store that holds the owner's declaration of its graphs and nothing else, and
// the real write preflight that every write route runs.
//
// First: the harness mocks `node:worker_threads`, so the catch-up runner loaded
// below runs its real worker, and its real wait for the selected lane, here.
import './helpers/catchup-runner-worker-test-harness.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { DKG_ONTOLOGY, contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import type { CatchupRunner } from '../src/catchup-runner.js';
import { CG, PEERS, memberEdge, waitUntil } from './_helpers/readiness-member-edge.js';
import { emptyCatchupTracker, nextFinishedJob } from './_helpers/readiness-subscribe-routes.js';

await import('../src/catchup-runner-worker-impl.js');
const { createCatchupRunner } = await import('../src/catchup-runner.js');
const { daemonState } = await import('../src/daemon/state.js');
const {
  CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS,
  readinessRepeatTimers,
  cancelContextGraphReadinessRepeats,
} = await import('../src/daemon/context-graph-readiness-repeat.js');
const { startActivationCatchups } = await import('../src/daemon/context-graph-activation-catchup.js');
const { beginWalkCatchupJob, releaseCatchupJob } = await import('../src/daemon/catchup-telemetry.js');
const { writeReadinessWait } = await import('../src/daemon/context-graph-write-readiness.js');
const { resolveRequiredWriteContextGraphId } = await import('../src/daemon/http-utils.js');

/** The owner's agent: the curator its graph ids are scoped to. */
const OWNER = '0x1111111111111111111111111111111111111111';
/** An agent that the owner's private graph does not admit. */
const NON_MEMBER = '0x3333333333333333333333333333333333333333';
/** The owner's private graph. */
const PRIVATE_CG = `${OWNER}/curated-private`;
/** A graph the owner declared and this node does not subscribe. */
const UNSUBSCRIBED_CG = `${OWNER}/not-subscribed`;

/** Admission of a public graph registered on chain: its finalized public policy. */
const REGISTERED_PUBLIC = Object.freeze({
  outcome: 'allowed', source: 'registered-chain', reason: 'chain-public',
  metadataBootstrap: 'eligible', grantScope: 'public',
});

/** The row the agent installs when it restores a subscription whose job never proved it. */
const RESTORED_UNSYNCED = Object.freeze({
  subscribed: true, synced: false, sharedMemorySynced: false, metaSynced: true, syncMode: 'always-on',
});

const FIRST_DELAY_MS = CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS[0];

interface ArmedTimer {
  readonly callback: () => void;
  readonly delayMs: number;
  cleared: boolean;
  fired: boolean;
}

interface WriteAnswer {
  status?: number;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the first write of a restarted owner into its own registered public graph', () => {
  const previousRunner = daemonState.catchupRunner;
  const originalTimers = { set: readinessRepeatTimers.set, clear: readinessRepeatTimers.clear };
  const originalWait = { ...writeReadinessWait };
  const timers: ArmedTimer[] = [];
  const runners: CatchupRunner[] = [];
  const stores: OxigraphStore[] = [];
  const stops: Array<() => void> = [];

  beforeEach(() => {
    // Repeats are armed on recorded timers that only the test fires.
    readinessRepeatTimers.set = (callback: () => void, delayMs: number) => {
      const timer: ArmedTimer = { callback, delayMs, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    };
    readinessRepeatTimers.clear = (handle: unknown) => {
      (handle as ArmedTimer).cleared = true;
    };
    // A write that waited past this bound would fail its test, not hang it.
    writeReadinessWait.timeoutMs = 5_000;
    writeReadinessWait.pollMs = 5;
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    cancelContextGraphReadinessRepeats();
    readinessRepeatTimers.set = originalTimers.set;
    readinessRepeatTimers.clear = originalTimers.clear;
    Object.assign(writeReadinessWait, originalWait);
    timers.length = 0;
    daemonState.catchupRunner = previousRunner;
    daemonState.catchupAcceptingJobs = true;
    for (const runner of runners.splice(0)) await runner.close();
    for (const store of stores.splice(0)) await store.close();
  });

  /** Timers armed and not yet fired or cleared. */
  const armed = () => timers.filter((timer) => !timer.cleared && !timer.fired);

  function fire(timer: ArmedTimer | undefined): void {
    if (!timer) throw new Error('no repeat armed');
    timer.fired = true;
    timer.callback();
  }

  /**
   * The owner's node after a restart. The graph's authority is not accepted
   * yet, so the graph has no selected shared-memory lane and a walk asks no
   * peer anything; `acceptAuthority` puts it in place and activates the lane.
   */
  async function ownerNode() {
    const member = memberEdge();
    member.node.authority = REGISTERED_PUBLIC;
    member.node.localAgents = [OWNER];
    member.node.namedAgent = OWNER;
    let authorityAccepted = false;
    const asked: string[] = [];
    // In this thread: the harness stands in for every worker thread.
    const store = new OxigraphStore();
    stores.push(store);
    // The owner's declaration of each of its graphs, in the graph's `_meta`.
    for (const [contextGraphId, accessPolicy] of [[CG, 'public'], [PRIVATE_CG, 'private'], [UNSUBSCRIBED_CG, 'public']]) {
      const subject = contextGraphDataGraphUri(contextGraphId);
      const graph = contextGraphMetaGraphUri(contextGraphId);
      await store.insert([
        { subject, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph },
        { subject, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: `"${accessPolicy}"`, graph },
        { subject, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: `did:dkg:agent:${OWNER}`, graph },
      ]);
    }
    Object.assign(member.agent, {
      resolveRfc64SwmRecoveryRuntimeAuthorityV1: (contextGraphId: string) => ({
        kind: 'rfc64-swm-recovery-runtime-authority-v1',
        contextGraphId,
        lane: authorityAccepted ? 'selected-public' : null,
        active: authorityAccepted,
      }),
      syncSelectedSharedMemoryFromPeerDetailed: async (peerId: string) => {
        asked.push(peerId);
        return member.node.answer(peerId);
      },
      // The agent's own write-preflight probe, over the owner's store.
      store,
      probeContextGraphWritePreflight: DKGAgent.prototype.probeContextGraphWritePreflight,
      contextGraphExists: DKGAgent.prototype.contextGraphExists,
      contextGraphHasLocalContent: DKGAgent.prototype.contextGraphHasLocalContent,
      curatorDidMatchesChecksumAgent: DKGAgent.prototype.curatorDidMatchesChecksumAgent,
      // The private graph's allowlist names no agent besides its curator.
      callerIsAllowlistedAgentParticipant: async () => false,
      listContextGraphs: async () => [],
    });
    const runner = createCatchupRunner(member.agent);
    runners.push(runner);
    daemonState.catchupRunner = runner;

    /** The subscription comes back from the restart, and the daemon catches it up. */
    const restart = () => {
      member.restore({ ...RESTORED_UNSYNCED });
      const catchupTracker = emptyCatchupTracker();
      stops.push(startActivationCatchups({ agent: member.agent, store: member.store, catchupTracker, log: () => {} }));
      return catchupTracker;
    };

    /** One write as `caller`, through the preflight that every write route runs first. */
    const write = (contextGraphId: string = CG, caller: string = OWNER) => {
      const answer: WriteAnswer = {};
      const res = {
        writeHead(status: number, headers?: Record<string, string>) {
          answer.status = status;
          answer.headers = headers;
          return res;
        },
        end(body?: string) {
          if (body) answer.body = JSON.parse(body);
        },
      } as unknown as ServerResponse;
      const startedAt = Date.now();
      let settled = false;
      const done = resolveRequiredWriteContextGraphId(member.agent, contextGraphId, res, {
        callerAgentAddress: caller,
        allowLocalExactFallback: false,
      }).then((accepted) => {
        settled = true;
        return { accepted, answer, elapsedMs: Date.now() - startedAt };
      });
      return { done, settled: () => settled };
    };

    return {
      member,
      asked,
      restart,
      write,
      acceptAuthority: () => { authorityAccepted = true; },
    };
  }

  it('goes through once the authority is in place, when it was sent before', async () => {
    const owner = await ownerNode();
    const catchupTracker = owner.restart();

    // The job that catches up the restored subscription walks before the
    // authority: it asks nobody, the graph stays unsynced, and a repeat is
    // armed after its first delay.
    const restored = await nextFinishedJob(catchupTracker);
    expect(restored.selectedLaneFoundInactive).toBe(true);
    expect(owner.asked).toEqual([]);
    expect(owner.member.subscription()).toMatchObject({ subscribed: true, synced: false });
    expect(armed().map((timer) => timer.delayMs)).toEqual([FIRST_DELAY_MS]);

    // The owner's first write comes now. It was refused at once.
    const write = owner.write();
    await sleep(50);
    expect(write.settled()).toBe(false);

    // The authority arrives a moment later. The waiting write starts the
    // armed repeat at once; the repeat proves the graph, and the write goes
    // through with nothing answered for it by the preflight.
    owner.acceptAuthority();
    const { accepted, answer } = await write.done;

    expect(accepted).toBe(CG);
    expect(answer).toEqual({});
    expect([...owner.asked].sort()).toEqual([...PEERS].sort());
    expect(owner.member.subscription()).toMatchObject({ subscribed: true, synced: true, sharedMemorySynced: true });
    expect(timers[0]).toMatchObject({ delayMs: FIRST_DELAY_MS, cleared: true, fired: false });
    expect(armed()).toEqual([]);
  });

  it('is proven writable at once when the catch-up job itself put the authority in place', async () => {
    // In the trial runs the job that catches up the restored subscription
    // settled right when the authority was accepted: the job's last step
    // refreshes the graph's authority from the chain. Its walk had run before.
    const owner = await ownerNode();
    Object.assign(owner.member.agent, {
      reconcileRfc64CatalogResponsibilityV1: async () => { owner.acceptAuthority(); },
    });
    const catchupTracker = owner.restart();

    const restored = await nextFinishedJob(catchupTracker);
    expect(restored.selectedLaneFoundInactive).toBe(true);
    expect(owner.asked).toEqual([]);
    // The repeat is due at once. It waited its first delay with the authority in place.
    expect(armed().map((timer) => timer.delayMs)).toEqual([0]);

    fire(armed()[0]);
    await nextFinishedJob(catchupTracker, restored.jobId);
    expect(owner.member.subscription()).toMatchObject({ subscribed: true, synced: true });

    const { accepted, answer, elapsedMs } = await owner.write().done;
    expect(accepted).toBe(CG);
    expect(answer).toEqual({});
    expect(elapsedMs).toBeLessThan(writeReadinessWait.timeoutMs);
  });

  it('is refused as not writable yet, retryable, when the authority has not arrived within the bound', async () => {
    writeReadinessWait.timeoutMs = 300;
    const owner = await ownerNode();
    const catchupTracker = owner.restart();
    await nextFinishedJob(catchupTracker);

    const { accepted, answer, elapsedMs } = await owner.write().done;

    expect(accepted).toBeNull();
    expect(elapsedMs).toBeGreaterThanOrEqual(300);
    expect(answer.status).toBe(503);
    expect(answer.headers).toMatchObject({ 'Retry-After': '5' });
    expect(answer.body).toEqual({
      code: 'CONTEXT_GRAPH_NOT_WRITABLE',
      retryable: true,
      error: `Context graph "${CG}" is not writable yet: this node is still catching it up. Retry the write shortly.`,
    });
    // Nothing was hurried without the authority: the repeat keeps its delay.
    expect(armed().map((timer) => timer.delayMs)).toEqual([FIRST_DELAY_MS]);
    expect(owner.asked).toEqual([]);
  });

  it('does not hurry a repeat armed after an admission that could not be read', async () => {
    writeReadinessWait.timeoutMs = 200;
    const owner = await ownerNode();
    const catchupTracker = owner.restart();
    await nextFinishedJob(catchupTracker);

    // The first repeat comes due while the graph's admission cannot be read:
    // no job runs, and the next repeat is armed after its delay.
    owner.member.node.authority = { outcome: 'unavailable' };
    fire(armed()[0]);
    await waitUntil(() => (armed().length === 1 ? true : undefined), 'the next repeat to be armed');
    expect(armed().map((timer) => timer.delayMs)).toEqual([CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS[1]]);

    // The authority is in place now, and a write waits: the repeat keeps its
    // delay, since asking for the admission again right away could spend
    // every repeat while the admission cannot be read.
    owner.acceptAuthority();
    const { answer } = await owner.write().done;

    expect(answer.status).toBe(503);
    expect(armed().map((timer) => timer.delayMs)).toEqual([CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS[1]]);
    expect(owner.asked).toEqual([]);
  });

  it('refuses at once a write that the node may not make, while it catches the graph up', async () => {
    const owner = await ownerNode();
    // The node subscribes the owner's private graph and is catching it up.
    owner.member.restore({ ...RESTORED_UNSYNCED }, PRIVATE_CG);
    const catchup = beginWalkCatchupJob({
      jobId: 'private-graph-catchup', contextGraphId: PRIVATE_CG, includeWorkspace: true,
      status: 'running', queuedAt: Date.now(),
    });
    try {
      // An agent that the private graph does not admit: refused at once.
      const nonMember = await owner.write(PRIVATE_CG, NON_MEMBER).done;
      expect(nonMember.accepted).toBeNull();
      expect(nonMember.answer).toMatchObject({ status: 400, body: { code: 'CONTEXT_GRAPH_NOT_FOUND' } });
      expect(nonMember.elapsedMs).toBeLessThan(1_000);

      // A graph this node knows and does not subscribe: refused at once.
      const unsubscribed = await owner.write(UNSUBSCRIBED_CG).done;
      expect(unsubscribed.accepted).toBeNull();
      expect(unsubscribed.answer).toMatchObject({ status: 400, body: { code: 'CONTEXT_GRAPH_NOT_WRITABLE' } });
      expect(unsubscribed.elapsedMs).toBeLessThan(1_000);

      // The private graph's curator waits for the catch-up, and goes
      // through once it has proven the graph.
      const curator = owner.write(PRIVATE_CG, OWNER);
      await sleep(50);
      expect(curator.settled()).toBe(false);
      owner.member.restore({ ...RESTORED_UNSYNCED, synced: true }, PRIVATE_CG);
      expect((await curator.done).accepted).toBe(PRIVATE_CG);
    } finally {
      releaseCatchupJob(catchup);
    }
  });

  it('refuses at once a graph that nothing is catching up, as before', async () => {
    const owner = await ownerNode();
    owner.member.restore({ ...RESTORED_UNSYNCED });

    const { accepted, answer, elapsedMs } = await owner.write().done;

    expect(accepted).toBeNull();
    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({
      code: 'CONTEXT_GRAPH_NOT_WRITABLE',
      error: `Context graph "${CG}" is known but is not locally synced for writes. `
        + 'Subscribe/sync the context graph first, then retry the write.',
    });
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
