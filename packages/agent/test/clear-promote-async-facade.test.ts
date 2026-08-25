import { afterEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncPromoteQueue,
  type PromoteRequest,
} from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/dkg-agent.js';

// #1837 — verifies the PRODUCTION DKGAgent facade wiring between
// `agent.assertion.clearPromoteAsync` and `promoteQueue.clearTerminalJob`, driving a REAL
// promote queue. The SWM route tests stub `clearPromoteAsync` onto a fake agent, so they
// cover the route + queue contract but NOT this delegation: a regression that pointed the
// facade at `cancel()` (which retains the row) or any other queue method would leave those
// route tests green yet be caught here.
describe('DKGAgent assertion.clearPromoteAsync facade wiring (#1837)', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  });

  function makeRequest(overrides: Partial<PromoteRequest> = {}): PromoteRequest {
    return { contextGraphId: 'graphify', subGraphName: 'code', assertionName: 'shard-1', entities: 'all', ...overrides };
  }

  function newQueue(): TripleStoreAsyncPromoteQueue {
    const store = new OxigraphStore();
    stores.push(store);
    let id = 0;
    return new TripleStoreAsyncPromoteQueue(store, { now: () => 1_000_000, idGenerator: () => `job-${++id}` });
  }

  // Real DKGAgent facade over an injected real queue — `agent.assertion.clearPromoteAsync`
  // routes through the public `promoteQueue` getter, exactly as production does.
  // `defaultAgentAddress` is set so the `assertion` getter's `this.defaultAgentAddress ??
  // this.peerId` resolves without touching the unbuilt libp2p `node` (mirrors the sibling
  // promote-async-default-agent facade test).
  function agentFor(queue: TripleStoreAsyncPromoteQueue): { assertion: { clearPromoteAsync(jobId: string): Promise<unknown> } } {
    const agent = Object.create(DKGAgent.prototype) as {
      _promoteQueue: TripleStoreAsyncPromoteQueue;
      defaultAgentAddress: string;
    };
    agent.defaultAgentAddress = `0x${'11'.repeat(20)}`;
    agent._promoteQueue = queue;
    return agent as unknown as { assertion: { clearPromoteAsync(jobId: string): Promise<unknown> } };
  }

  async function driveToSucceeded(queue: TripleStoreAsyncPromoteQueue): Promise<string> {
    const jobId = await queue.enqueue(makeRequest());
    const claimed = await queue.claimNext('worker-1');
    const token = claimed!.lease!.claimToken;
    for (const marker of ['swmInserted', 'wmCleaned', 'lifecycleStamped', 'gossiped'] as const) {
      await queue.recordCommitMarker(jobId, token, marker);
    }
    await queue.succeed(jobId, token, { promotedCount: 1, succeededAt: 1_000_000 });
    return jobId;
  }

  it('clears a terminal job through the real facade, removes only that row, and is idempotent', async () => {
    const queue = newQueue();
    const target = await driveToSucceeded(queue);
    const other = await driveToSucceeded(queue);
    const agent = agentFor(queue);

    // cleared — and the row is actually gone (a mis-delegation to cancel() would retain it).
    expect(await agent.assertion.clearPromoteAsync(target)).toEqual({ outcome: 'cleared' });
    expect(await queue.getStatus(target)).toBeNull();
    expect((await queue.getStatus(other))?.state).toBe('succeeded'); // only the exact row cleared

    // Idempotent repeat via the facade.
    expect(await agent.assertion.clearPromoteAsync(target)).toEqual({ outcome: 'already_absent' });
  });

  it('rejects a nonterminal (queued) job through the facade without mutation', async () => {
    const queue = newQueue();
    const queued = await queue.enqueue(makeRequest());
    const agent = agentFor(queue);

    expect(await agent.assertion.clearPromoteAsync(queued)).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    expect((await queue.getStatus(queued))?.state).toBe('queued'); // untouched
  });
});
