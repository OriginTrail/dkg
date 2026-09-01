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
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
    async (): Promise<string[]> => [];
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

    expect(await internals.vmUpdateConvergenceState()).toEqual({ effective: true });
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

    expect(await internals.vmUpdateConvergenceState()).toEqual({
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

    expect(await internals.vmUpdateConvergenceState()).toMatchObject({
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

    expect(await internals.vmUpdateConvergenceState()).toEqual({
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

    expect(await internals.vmUpdateConvergenceState()).toEqual({
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

    expect(await (agent as any).vmUpdateConvergenceState()).toEqual({
      effective: false,
      reason: 'no-data-dir',
    });
  }, 60_000);

  it('OFF on an adapter that PREDATES the capability probe', async () => {
    // An adapter with no `supportsEventTypes` at all cannot say what it serves,
    // and "cannot say" must never read as "serves everything".
    //
    // `MockChainAdapter` implements the probe as of PR-A's parity fix, so the
    // absence has to be constructed deliberately — which is exactly the point:
    // this row pins the fail-closed DEFAULT rather than an accident of whatever
    // the mock happens not to implement today.
    delete process.env[INTENT_ENV];
    delete process.env[RECONCILER_ENV];
    const chain = new MockChainAdapter();
    // SHADOWED, not `delete`d: the probe is a class method, so it lives on the
    // prototype and `delete instance.method` silently removes nothing — an own
    // property set to `undefined` is what actually models an adapter that does
    // not implement it.
    (chain as unknown as { supportsEventTypes?: unknown }).supportsEventTypes = undefined;
    const { internals, intentFile } = await boot({ chainAdapter: chain });

    expect(await internals.vmUpdateConvergenceState()).toEqual({
      effective: false,
      reason: 'abi-missing:KnowledgeAssetUpdated',
    });
    await internals.prepareVmReverifyIntentStore();
    expect(existsSync(intentFile)).toBe(false);
  }, 60_000);

  it('OFF on a LEGACY ABI, naming the specific event it cannot serve', async () => {
    // A partial subscription is the failure this feature exists to end: a lane
    // that quietly skips the kinds its ABI lacks converges on some root
    // mutations and silently never sees the rest. So ANY missing name disables
    // the feature outright, and the diagnostic names one instead of reporting
    // an opaque "unsupported".
    delete process.env[INTENT_ENV];
    delete process.env[RECONCILER_ENV];
    const chain = new MockChainAdapter();
    (chain as unknown as { supportsEventTypes: unknown }).supportsEventTypes =
      async (): Promise<string[]> => ['KnowledgeAssetMerkleRootRemoved'];
    const { internals, intentFile } = await boot({ chainAdapter: chain });

    expect(await internals.vmUpdateConvergenceState()).toEqual({
      effective: false,
      reason: 'abi-missing:KnowledgeAssetMerkleRootRemoved',
    });
    await internals.prepareVmReverifyIntentStore();
    expect(existsSync(intentFile)).toBe(false);
  }, 60_000);

  it('a store that FAILS to open is loud, leaves the feature off, and does NOT kill the boot', async () => {
    // This open runs inside the startup `try` whose contract is "fail the
    // boot" — correct for the finalization inbox, catastrophic for an optional
    // background feature. Unguarded, a stray permission on a scratch file makes
    // the node unbootable, and the remedy (turn the switch off) needs a boot to
    // discover the cause. That is the very property ADR-W2R-6 gave this feature
    // its own file to avoid.
    //
    // The opposite error is just as bad: swallowing it silently would leave an
    // operator who enabled convergence with no way to see it never armed — a
    // documented bypass wearing a guard's clothes. So all three properties are
    // pinned together: NOT fatal, feature OFF, and LOUD.
    delete process.env[INTENT_ENV];
    delete process.env[RECONCILER_ENV];
    const { internals, dataDir, intentFile } = await boot();

    // A directory where the database file belongs: the open cannot succeed, and
    // it fails the way a real filesystem fault does rather than via a stub.
    await mkdir(intentFile, { recursive: true });
    const errors: string[] = [];
    internals.log.error = (_ctx: unknown, message: string) => { errors.push(message); };

    await expect(
      internals.prepareVmReverifyIntentStore(),
      'a failed intent-store open must never propagate into startup',
    ).resolves.toBeUndefined();

    expect(internals.vmReverifyIntents, 'the feature stays off').toBeUndefined();
    expect(
      await internals.vmUpdateConvergenceState(),
      'and the single operator-facing resolver says WHY',
    ).toEqual({ effective: false, reason: 'store-open-failed' });

    expect(errors, 'the failure must be reported at ERROR level').toHaveLength(1);
    expect(errors[0], 'naming the flag an operator would look for').toContain(
      'DKG_VM_UPDATE_CONVERGENCE_ENABLED',
    );
    expect(errors[0], 'and the path they would inspect').toContain(dataDir);
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

  it('fails CLOSED when the capability probe rejects — a transient probe is not proof', async () => {
    // `supportsEventTypes` awaits lazily-resolved contract bindings, so it can
    // reject when the Hub is unreachable at boot. Treating that as capable
    // would subscribe a lane that yields nothing, forever, with no signal.
    delete process.env[INTENT_ENV];
    delete process.env[RECONCILER_ENV];
    const chain = new MockChainAdapter();
    (chain as unknown as { supportsEventTypes: unknown }).supportsEventTypes =
      async (): Promise<string[]> => { throw new Error('hub unreachable'); };
    const { internals, intentFile } = await boot({ chainAdapter: chain });

    expect(await internals.vmUpdateConvergenceState()).toEqual({
      effective: false,
      reason: 'abi-probe-failed',
    });
    await internals.prepareVmReverifyIntentStore();
    expect(existsSync(intentFile)).toBe(false);
  }, 60_000);

  it('fails CLOSED on a probe that is not awaited into an array', async () => {
    // The failure this row exists for: an UNAWAITED promise has no `.length`,
    // and `undefined > 0` is false — so a gate that forgot the await would call
    // every adapter capable. Anything that is not an array is refused.
    delete process.env[INTENT_ENV];
    delete process.env[RECONCILER_ENV];
    const chain = new MockChainAdapter();
    (chain as unknown as { supportsEventTypes: unknown }).supportsEventTypes =
      (): unknown => ({ length: undefined });
    const { internals } = await boot({ chainAdapter: chain });

    expect(await internals.vmUpdateConvergenceState()).toEqual({
      effective: false,
      reason: 'abi-probe-failed',
    });
  }, 60_000);

  it('the no-backing latch preserves the resolver reason PRECEDENCE (review r4)', async () => {
    // With no durable backing, preparation must still send the operator to
    // the right remediation: a disabled reconciler outranks the flag, the
    // flag outranks the missing data directory — the same order the live
    // resolver documents.
    delete process.env[INTENT_ENV];
    delete process.env[RECONCILER_ENV];
    const combos: Array<{ config: Record<string, unknown>; env?: string; reason: string }> = [
      { config: { vmUpdateConvergenceEnabled: false }, reason: 'flag-off' },
      { config: {}, env: '0', reason: 'reconcile-disabled' },
      { config: {}, reason: 'no-data-dir' },
    ];
    for (const combo of combos) {
      if (combo.env === undefined) delete process.env[RECONCILER_ENV];
      else process.env[RECONCILER_ENV] = combo.env;
      const agent = await DKGAgent.create({
        name: 'W2RWiringNoBackingReasons',
        chainAdapter: capableChain(),
        ...combo.config,
      } as any);
      agents.push(agent);
      stubNode(agent);
      const internals = agent as any;

      await internals.prepareVmReverifyIntentStore();

      expect(
        await internals.vmUpdateConvergenceState(),
        `no-backing prepare must latch ${combo.reason}`,
      ).toEqual({ effective: false, reason: combo.reason });
    }
  }, 120_000);
  it('an INJECTED store cannot bypass the kill switch (review r1)', async () => {
    // Injection substitutes for the durable FILE, not for the operator flag:
    // with the switch off, an injected store must wire neither lane nor
    // worker, exactly like the SQLite path.
    delete process.env[INTENT_ENV];
    delete process.env[RECONCILER_ENV];
    const injected = { close: async () => undefined, reviveForContextGraph: async () => 0 };
    const { internals } = await boot({
      vmUpdateConvergenceEnabled: false,
      vmReverifyIntentStore: injected,
    });

    await internals.prepareVmReverifyIntentStore();

    expect(internals.vmReverifyIntents, 'the injected store must NOT be armed').toBeUndefined();
    expect(await internals.vmUpdateConvergenceState()).toEqual({
      effective: false,
      reason: 'flag-off',
    });
  }, 60_000);

  it('an INJECTED store satisfies the durability condition WITHOUT a dataDir (review r1)', async () => {
    // The opposite polarity: injection IS a deliberate persistence
    // substitute, so with every real gate open the absence of a dataDir must
    // not disable the feature for a caller that supplied durable storage.
    delete process.env[INTENT_ENV];
    delete process.env[RECONCILER_ENV];
    const injected = { close: async () => undefined, reviveForContextGraph: async () => 0 };
    const agent = await DKGAgent.create({
      name: 'W2RWiringInjectedNoDataDir',
      chainAdapter: capableChain(),
      vmReverifyIntentStore: injected,
    } as any);
    agents.push(agent);
    stubNode(agent);
    const internals = agent as any;

    expect(await internals.vmUpdateConvergenceState()).toEqual({ effective: true });
    await internals.prepareVmReverifyIntentStore();
    expect(internals.vmReverifyIntents).toBe(injected);
  }, 60_000);

  it('a probe that recovers AFTER boot cannot report an unwired feature as effective (review r1)', async () => {
    // Store, lane and worker are wired ONLY at startup. If the resolver
    // re-probed live, a Hub that recovers after a failed boot-time probe
    // would answer {effective: true} about a process in which nothing is
    // armed — the operator-facing status lying in the optimistic direction.
    delete process.env[INTENT_ENV];
    delete process.env[RECONCILER_ENV];
    const chain = new MockChainAdapter();
    (chain as unknown as { supportsEventTypes: unknown }).supportsEventTypes =
      async (): Promise<string[]> => { throw new Error('hub unreachable'); };
    const { internals } = await boot({ chainAdapter: chain });

    await internals.prepareVmReverifyIntentStore();
    expect(internals.vmReverifyIntents).toBeUndefined();

    // The Hub recovers. The latched startup outcome must still win…
    (chain as unknown as { supportsEventTypes: unknown }).supportsEventTypes =
      async (): Promise<string[]> => [];
    expect(await internals.vmUpdateConvergenceState()).toEqual({
      effective: false,
      reason: 'abi-probe-failed',
    });

    // …until the store lifecycle is torn down, which is the restart
    // boundary at which arming can actually happen again.
    await internals.closeVmReverifyIntentStore();
    expect(await internals.vmUpdateConvergenceState()).toEqual({ effective: true });
  }, 60_000);

  it('fails CLOSED for an adapter that can emit events but not map or repair them (review r1)', async () => {
    // Solo removal per capability: event support alone would let the lane
    // arm, then drop-and-acknowledge every mutation — the cursor advances
    // forever past events that never became intents.
    delete process.env[INTENT_ENV];
    delete process.env[RECONCILER_ENV];
    for (const capability of [
      'getDKGKnowledgeAssetsAddress',
      'getKAContextGraphId',
      'readKnowledgeAssetVersionSnapshot',
    ]) {
      const chain = capableChain();
      (chain as unknown as Record<string, unknown>)[capability] = undefined;
      const { internals, intentFile } = await boot({ chainAdapter: chain });

      expect(
        await internals.vmUpdateConvergenceState(),
        `an adapter without ${capability} must fail activation closed`,
      ).toEqual({ effective: false, reason: `adapter-missing:${capability}` });
      await internals.prepareVmReverifyIntentStore();
      expect(existsSync(intentFile)).toBe(false);
    }
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
