/**
 * W2 (#2435) — the kill switch, and what "off" has to mean.
 *
 * Off is not "the feature does nothing useful". Off is **byte-identical to the
 * base release**: no chain lane subscribed, no drain running, and — the part
 * that is easy to get wrong and expensive to get wrong — **no file created in
 * the data directory**. The whole reason the intents live in their own SQLite
 * file rather than as a table in the finalization inbox is that a rollback must
 * be a non-event, and that only holds if the gate is on the OPEN rather than on
 * the writes.
 *
 * The effective state is also the operator-facing answer to "why is this node
 * not converging?", so each way of being off has to name itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';

import { DKGAgent } from '../src/index.js';
import { VM_REVERIFY_INTENTS_DATABASE_FILENAME } from '../src/vm-reverify-intent-store.js';

const INTENT_ENV = 'DKG_VM_UPDATE_CONVERGENCE_ENABLED';
const RECONCILER_ENV = 'DKG_SYNC_RECONCILER_ENABLED';

function stubNode(agent: DKGAgent): void {
  (agent as unknown as { node: unknown }).node = {
    peerId: '12D3KooWVmReverifyWiringTestPeer',
    libp2p: { getPeers: () => [], getConnections: () => [] },
  };
  (agent as unknown as { gossip: unknown }).gossip = {
    subscribe: () => undefined,
    unsubscribe: () => undefined,
    publish: async () => undefined,
    onMessage: () => undefined,
    getSubscribers: () => [],
  };
}

/**
 * A chain adapter that CAN yield the four root-mutation events.
 *
 * `supportsEventTypes` returns the names it cannot serve, so an empty array
 * means "all four available" — the shape PR-A's adapter provides. Read
 * structurally by the gate, so this is the real production predicate and not a
 * stand-in for it.
 */
function capableChain(): MockChainAdapter {
  const chain = new MockChainAdapter();
  (chain as unknown as { supportsEventTypes: unknown }).supportsEventTypes =
    (): string[] => [];
  return chain;
}

describe('W2 kill switch — the effective gate and what it opens', () => {
  const agents: DKGAgent[] = [];
  const directories: string[] = [];
  const savedEnv = { intent: process.env[INTENT_ENV], reconciler: process.env[RECONCILER_ENV] };

  afterEach(async () => {
    for (const agent of agents.splice(0)) {
      await (agent as unknown as { closeVmReverifyIntentStore(): Promise<void> })
        .closeVmReverifyIntentStore().catch(() => undefined);
    }
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
    for (const [key, value] of [
      [INTENT_ENV, savedEnv.intent],
      [RECONCILER_ENV, savedEnv.reconciler],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function boot(config: Record<string, unknown> = {}): Promise<{
    agent: DKGAgent;
    internals: any;
    dataDir: string;
    intentFile: string;
  }> {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-w2r-wiring-'));
    directories.push(dataDir);
    const agent = await DKGAgent.create({
      name: 'W2RWiring',
      chainAdapter: capableChain(),
      dataDir,
      contextGraphSubscriptionStore: {
        loadAll: async () => [],
        save: async () => undefined,
        delete: async () => undefined,
      },
      ...config,
    } as any);
    agents.push(agent);
    stubNode(agent);
    return {
      agent,
      internals: agent as any,
      dataDir,
      intentFile: join(dataDir, VM_REVERIFY_INTENTS_DATABASE_FILENAME),
    };
  }

  it('ON: opens the intent store and reports an effective state with no reason', async () => {
    delete process.env[INTENT_ENV];
    delete process.env[RECONCILER_ENV];
    const { internals, intentFile } = await boot();

    expect(internals.vmUpdateConvergenceState()).toEqual({ effective: true });
    expect(
      existsSync(intentFile),
      'the file must not exist before the store is opened',
    ).toBe(false);

    await internals.prepareVmReverifyIntentStore();

    expect(internals.vmReverifyIntents, 'the store is the feature').toBeDefined();
    expect(existsSync(intentFile)).toBe(true);
  }, 60_000);

  it('OFF via config: no store, and NOTHING is written to the data directory', async () => {
    delete process.env[INTENT_ENV];
    const { internals, intentFile } = await boot({ vmUpdateConvergenceEnabled: false });

    expect(internals.vmUpdateConvergenceState()).toEqual({
      effective: false,
      reason: 'flag-off',
    });

    await internals.prepareVmReverifyIntentStore();

    expect(internals.vmReverifyIntents).toBeUndefined();
    expect(
      existsSync(intentFile),
      'with the switch off a rollback must be a non-event: the base release '
      + 'never looks at this file, so this release must never create it',
    ).toBe(false);
  }, 60_000);

  it('OFF via environment: the env wins over an enabling config', async () => {
    process.env[INTENT_ENV] = '0';
    const { internals, intentFile } = await boot({ vmUpdateConvergenceEnabled: true });

    expect(internals.vmUpdateConvergenceState()).toMatchObject({
      effective: false,
      reason: 'flag-off',
    });
    await internals.prepareVmReverifyIntentStore();
    expect(existsSync(intentFile)).toBe(false);
  }, 60_000);

  it('OFF because the background reconciler is off — the third polarity', async () => {
    // W2 rides on the reconciler. With that off, W2 off is the intended
    // reading, and the reason has to say so rather than blaming the W2 flag.
    delete process.env[INTENT_ENV];
    process.env[RECONCILER_ENV] = '0';
    const { internals, intentFile } = await boot({ vmUpdateConvergenceEnabled: true });

    expect(internals.vmUpdateConvergenceState()).toEqual({
      effective: false,
      reason: 'reconcile-disabled',
    });
    await internals.prepareVmReverifyIntentStore();
    expect(existsSync(intentFile)).toBe(false);
  }, 60_000);

  it('with BOTH switches off, names the one an operator can act on', async () => {
    // Reporting `flag-off` here would send an operator to flip the W2 flag,
    // which would change nothing while the reconciler this feature rides on is
    // still down. The reason has to point at the actual blocker.
    process.env[INTENT_ENV] = '0';
    process.env[RECONCILER_ENV] = '0';
    const { internals } = await boot();

    expect(internals.vmUpdateConvergenceState()).toEqual({
      effective: false,
      reason: 'reconcile-disabled',
    });
  }, 60_000);

  it('OFF without a data directory: an intent that cannot survive a restart is not an intent', async () => {
    delete process.env[INTENT_ENV];
    delete process.env[RECONCILER_ENV];
    const agent = await DKGAgent.create({
      name: 'W2RWiringNoDataDir',
      chainAdapter: capableChain(),
    } as any);
    agents.push(agent);
    stubNode(agent);

    expect((agent as any).vmUpdateConvergenceState()).toEqual({
      effective: false,
      reason: 'no-data-dir',
    });
  }, 60_000);

  it('OFF on an adapter that cannot yield the events — and it names which one', async () => {
    // Fail closed and be specific. A partial subscription would silently miss
    // every mutation of the kinds it cannot see, which is the failure this
    // feature exists to end.
    delete process.env[INTENT_ENV];
    delete process.env[RECONCILER_ENV];
    const { internals, intentFile } = await boot({ chainAdapter: new MockChainAdapter() });

    expect(internals.vmUpdateConvergenceState()).toEqual({
      effective: false,
      reason: 'abi-missing:KnowledgeAssetUpdated',
    });
    await internals.prepareVmReverifyIntentStore();
    expect(existsSync(intentFile)).toBe(false);
  }, 60_000);

  it('stops the drain BEFORE closing the file it writes to', async () => {
    // The worker is the store's only writer. Closing the file under a running
    // drain would surface as a rejected write during shutdown — or, worse, as a
    // half-applied transition — so the ordering is enforced inside
    // `closeVmReverifyIntentStore` rather than left to its callers.
    delete process.env[INTENT_ENV];
    const order: string[] = [];
    const { internals } = await boot();
    internals.vmReverifyWorker = { stop: async () => { order.push('worker-stop'); } };
    internals.vmReverifyIntents = { close: async () => { order.push('store-close'); } };

    await internals.closeVmReverifyIntentStore();

    expect(order).toEqual(['worker-stop', 'store-close']);
    expect(internals.vmReverifyWorker).toBeUndefined();
    expect(internals.vmReverifyIntents).toBeUndefined();
  }, 60_000);

  it('an INJECTED store is honoured and is never closed by the agent that borrowed it', async () => {
    delete process.env[INTENT_ENV];
    let closed = 0;
    const injected = {
      close: async () => { closed += 1; },
      reviveForContextGraph: async () => 0,
    };
    const { internals, intentFile } = await boot({ vmReverifyIntentStore: injected });

    await internals.prepareVmReverifyIntentStore();
    expect(internals.vmReverifyIntents).toBe(injected);
    expect(existsSync(intentFile), 'an injected store means no file at all').toBe(false);

    await internals.closeVmReverifyIntentStore();
    expect(internals.vmReverifyIntents).toBeUndefined();
    expect(closed, 'the borrower must not close a store it does not own').toBe(0);
  }, 60_000);
});

describe('W2 revive — taking a Context Graph back is new evidence', () => {
  const agents: DKGAgent[] = [];

  afterEach(async () => {
    agents.splice(0);
  });

  async function bootWithRecordingStore(): Promise<{
    agent: DKGAgent;
    internals: any;
    revived: string[];
  }> {
    const revived: string[] = [];
    const agent = await DKGAgent.create({
      name: 'W2RRevive',
      chainAdapter: capableChain(),
      vmReverifyIntentStore: {
        reviveForContextGraph: async (localCgId: string) => {
          revived.push(localCgId);
          return 1;
        },
        close: async () => undefined,
      },
      contextGraphSubscriptionStore: {
        loadAll: async () => [],
        save: async () => undefined,
        delete: async () => undefined,
      },
    } as any);
    agents.push(agent);
    stubNode(agent);
    const internals = agent as any;
    internals.vmReverifyIntents = internals.config.vmReverifyIntentStore;
    return { agent, internals, revived };
  }

  it('revives abandoned intents when a Context Graph is (re-)subscribed', async () => {
    const { agent, revived } = await bootWithRecordingStore();

    agent.subscribeToContextGraph('revive-cg');
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      revived,
      'without this, `abandoned` is terminal in practice: the mutation that '
      + 'raised the intent is long past, so nothing would ever raise it again',
    ).toContain('revive-cg');
  }, 60_000);

  it('revives abandoned intents when a public Context Graph is (re-)hosted', async () => {
    const { agent, internals, revived } = await bootWithRecordingStore();
    internals.chain.getContextGraphAccessPolicy = async () => 0; // public
    internals.chain.isContextGraphActiveOnChain = async () => true;

    await agent.recordCoreHostedPublicCg('4242');
    await new Promise((resolve) => setImmediate(resolve));

    expect(revived).toContain('4242');
  }, 60_000);

  it('never lets a failing revive break the subscription it hangs off', async () => {
    // A background convergence hint must not be able to fail a subscribe.
    const agent = await DKGAgent.create({
      name: 'W2RReviveFailure',
      chainAdapter: capableChain(),
      vmReverifyIntentStore: {
        reviveForContextGraph: async () => { throw new Error('store is gone'); },
        close: async () => undefined,
      },
    } as any);
    agents.push(agent);
    stubNode(agent);
    (agent as any).vmReverifyIntents = (agent as any).config.vmReverifyIntentStore;

    expect(() => agent.subscribeToContextGraph('revive-failure-cg')).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  }, 60_000);
});
