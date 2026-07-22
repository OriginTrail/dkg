/**
 * OT-RFC-38 / LU-6 Phase B — host-mode bookkeeping key canonicalisation.
 *
 * Regression coverage for PR #672 Codex review `id=3302086589`: the four
 * LU-6 Phase B discovery paths (chain-event, beacon, reconciler, manual)
 * deliver the same CG to host-mode wiring in different shapes —
 * chain-event/beacon carry the curator-committed wire hash, manual /
 * reconciler typically carry the cleartext local id. Before this fix the
 * `swmHostModeSubscribed.has()` / `swmHostModeHandlers.has()` checks ran
 * against the raw caller-supplied id and missed the prior subscription,
 * wiring a second handler on the same topic and doubling host-mode
 * ingest + persistence.
 *
 * The fix funnels every insert/lookup/delete through
 * {@link DKGAgent.canonicalSwmHostModeKey} (delegates to
 * {@link DKGAgent.gossipWireIdFor}), which returns the curator-committed
 * `nameHash` regardless of input shape. These tests pin that invariant
 * by exercising `enableSwmHostModeFor` once with the cleartext form and
 * once with the wire-hash form (in both orders) and asserting the
 * second call is reported as `alreadySubscribed` with the
 * `swmHostModeSubscribed` / `swmHostModeHandlers` maps holding exactly
 * one entry keyed by the wire hash.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGAgent } from '../../src/index.js';
import { SwmHostModeStore } from '../../src/swm/host-mode-store.js';
import { GraphManager } from '@origintrail-official/dkg-storage';

/**
 * Minimal in-memory gossip transport — mirrors the surface the agent
 * touches (`subscribe` / `onMessage` / `offMessage` / `unsubscribe`).
 * Same shape as the bus in `cg-discovery-integration.test.ts`; kept
 * local so this file is self-contained.
 */
class InMemoryGossipBus {
  private handlers = new Map<string, Array<(topic: string, data: Uint8Array, from: string) => void | Promise<void>>>();
  private subscribed = new Set<string>();

  subscribe(topic: string): void {
    this.subscribed.add(topic);
  }

  unsubscribe(topic: string): void {
    this.subscribed.delete(topic);
    this.handlers.delete(topic);
  }

  onMessage(topic: string, handler: (topic: string, data: Uint8Array, from: string) => void | Promise<void>): void {
    let list = this.handlers.get(topic);
    if (!list) {
      list = [];
      this.handlers.set(topic, list);
    }
    list.push(handler);
  }

  offMessage(topic: string, handler: (topic: string, data: Uint8Array, from: string) => void | Promise<void>): void {
    const list = this.handlers.get(topic);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }

  /** Test-only — every (topic, handler) pair currently wired on the bus. */
  allHandlers(): Array<[string, unknown]> {
    const out: Array<[string, unknown]> = [];
    for (const [topic, list] of this.handlers) {
      for (const h of list) out.push([topic, h]);
    }
    return out;
  }

  getSubscribers(_topic: string): string[] { return []; }
}

/** Total `onMessage` handlers across every topic on the bus. */
function totalHandlers(bus: InMemoryGossipBus): number {
  return bus.allHandlers().length;
}

interface AgentInternals {
  gossip: InMemoryGossipBus;
  swmHostModeStore?: SwmHostModeStore;
  swmHostModeSubscribed: Map<string, string>;
  swmHostModeHandlers: Map<string, unknown>;
  wireIdToLocalCgId: Map<string, string>;
  config: { swmHostMode?: { reconcileBatchSize?: number } };
  hostModeReconcileCursor: number;
  reconcileSwmHostModeSubscription(contextGraphId: string): Promise<void>;
  enqueueHostModePersistence(contextGraphId: string, subscribe: boolean): void;
  awaitHostModePersistence(contextGraphId: string): Promise<void>;
  hostModePersistenceStoreKey(rawCgId: string): string;
  contextGraphWireId(contextGraphId: string): string;
  bindOnChainContextGraphIdFromNameHash(
    nameHash: string,
    onChainContextGraphId: string,
    options?: { persist?: boolean },
  ): string | null;
  setContextGraphSubscription(
    contextGraphId: string,
    next: { subscribed: boolean; synced: boolean },
    options?: { persist?: boolean },
  ): void;
}

async function installHostModeStore(core: DKGAgent, dataDir: string): Promise<SwmHostModeStore> {
  const defaults = SwmHostModeStore.defaultLimits();
  const store = new SwmHostModeStore({
    dataDir: join(dataDir, 'swm-host'),
    unregisteredLimits: defaults.unregistered,
    registeredLimits: defaults.registered,
  });
  await store.init();
  (core as unknown as AgentInternals).swmHostModeStore = store;
  return store;
}

describe('host-mode bookkeeping key canonicalisation', () => {
  const tempDirs: string[] = [];
  const agents: DKGAgent[] = [];

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((a) => a.stop().catch(() => {}).then(() => a.store.close().catch(() => {}))));
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeCore(): Promise<{ core: DKGAgent; bus: InMemoryGossipBus }> {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-canon-key-'));
    tempDirs.push(dataDir);
    const core = await DKGAgent.create({
      name: 'CanonKeyCore',
      listenHost: '127.0.0.1',
      dataDir,
      nodeRole: 'core',
      swmHostMode: { enabled: true },
    });
    agents.push(core);
    const bus = new InMemoryGossipBus();
    (core as unknown as AgentInternals).gossip = bus;
    await installHostModeStore(core, dataDir);
    return { core, bus };
  }

  it('reconcileHostModeSubscriptions advances a bounded cursor instead of sweeping every CG per tick', async () => {
    const { core } = await makeCore();
    const internals = core as unknown as AgentInternals;
    internals.config.swmHostMode = { ...(internals.config.swmHostMode ?? {}), reconcileBatchSize: 2 };
    const graphManager = new GraphManager(core.store);
    const cgIds = ['cursor-cg-d', 'cursor-cg-b', 'cursor-cg-a', 'cursor-cg-c'];
    for (const cgId of cgIds) {
      await core.store.insert([{
        subject: `http://example.org/${cgId}`,
        predicate: 'http://schema.org/name',
        object: `"${cgId}"`,
        graph: graphManager.dataGraphUri(cgId),
      }]);
    }
    const knownCgs = (await graphManager.listContextGraphs()).sort();
    expect(knownCgs.length).toBeGreaterThanOrEqual(4);
    const calls: string[] = [];
    internals.reconcileSwmHostModeSubscription = async (contextGraphId: string) => {
      calls.push(contextGraphId);
    };

    await core.reconcileHostModeSubscriptions();
    expect(calls).toEqual(knownCgs.slice(0, 2));
    expect(internals.hostModeReconcileCursor).toBe(2);

    await core.reconcileHostModeSubscriptions();
    expect(calls).toEqual([...knownCgs.slice(0, 2), ...knownCgs.slice(2, 4)]);
    expect(internals.hostModeReconcileCursor).toBe(4 % knownCgs.length);
  });

  it('reconcileHostModeSubscriptions advances past a failing CG so later CGs are not starved', async () => {
    const { core } = await makeCore();
    const internals = core as unknown as AgentInternals;
    internals.config.swmHostMode = { ...(internals.config.swmHostMode ?? {}), reconcileBatchSize: 2 };
    const graphManager = new GraphManager(core.store);
    const cgIds = ['failing-cursor-cg-a', 'failing-cursor-cg-b', 'failing-cursor-cg-c'];
    for (const cgId of cgIds) {
      await core.store.insert([{
        subject: `http://example.org/${cgId}`,
        predicate: 'http://schema.org/name',
        object: `"${cgId}"`,
        graph: graphManager.dataGraphUri(cgId),
      }]);
    }
    const knownCgs = (await graphManager.listContextGraphs()).sort();
    const calls: string[] = [];
    internals.reconcileSwmHostModeSubscription = async (contextGraphId: string) => {
      calls.push(contextGraphId);
      if (contextGraphId === knownCgs[0]) throw new Error('boom');
    };

    await expect(core.reconcileHostModeSubscriptions()).rejects.toThrow('boom');
    expect(calls).toEqual([knownCgs[0]]);
    expect(internals.hostModeReconcileCursor).toBe(1);

    await core.reconcileHostModeSubscriptions();
    expect(calls).toEqual([knownCgs[0], knownCgs[1], knownCgs[2]]);
  });

  it('cleartext subscribe followed by wire-hash subscribe for the same CG is idempotent', async () => {
    const { core } = await makeCore();
    const cleartext = 'canon-cg-cleartext-first';
    const wireHash = ethers.keccak256(ethers.toUtf8Bytes(cleartext)).toLowerCase();

    const first = await core.enableSwmHostModeFor(cleartext);
    expect(first).toEqual({ subscribed: true, alreadySubscribed: false, hostingEnabled: true });

    const second = await core.enableSwmHostModeFor(wireHash);
    expect(second).toEqual({ subscribed: false, alreadySubscribed: true, hostingEnabled: true });

    const internals = core as unknown as AgentInternals;
    expect(internals.swmHostModeSubscribed.size).toBe(1);
    expect(internals.swmHostModeHandlers.size).toBe(1);
    // Canonical form is the wire hash — both subscribes funnel to it.
    expect(internals.swmHostModeSubscribed.has(wireHash)).toBe(true);
    expect(internals.swmHostModeHandlers.has(wireHash)).toBe(true);
  });

  it('wire-hash subscribe followed by cleartext subscribe for the same CG is idempotent', async () => {
    const { core } = await makeCore();
    const cleartext = 'canon-cg-hash-first';
    const wireHash = ethers.keccak256(ethers.toUtf8Bytes(cleartext)).toLowerCase();

    const first = await core.enableSwmHostModeFor(wireHash);
    expect(first).toEqual({ subscribed: true, alreadySubscribed: false, hostingEnabled: true });

    const second = await core.enableSwmHostModeFor(cleartext);
    expect(second).toEqual({ subscribed: false, alreadySubscribed: true, hostingEnabled: true });

    const internals = core as unknown as AgentInternals;
    expect(internals.swmHostModeSubscribed.size).toBe(1);
    expect(internals.swmHostModeHandlers.size).toBe(1);
    expect(internals.swmHostModeSubscribed.has(wireHash)).toBe(true);
    expect(internals.swmHostModeHandlers.has(wireHash)).toBe(true);
  });

  it('uses one indexed wire-id helper for event binding and store-free registry lookup', async () => {
    const { core } = await makeCore();
    const internals = core as unknown as AgentInternals;
    const cleartext = 'canon-cg-event-binding';
    const wireHash = ethers.keccak256(ethers.toUtf8Bytes(cleartext)).toLowerCase();
    internals.setContextGraphSubscription(
      cleartext,
      { subscribed: true, synced: false },
      { persist: false },
    );

    expect(internals.contextGraphWireId(cleartext)).toBe(wireHash);
    expect(internals.contextGraphWireId(wireHash.toUpperCase().replace('0X', '0x'))).toBe(wireHash);
    expect(internals.bindOnChainContextGraphIdFromNameHash(
      wireHash,
      '14',
      { persist: false },
    )).toBe(cleartext);

    const storeQuery = vi.spyOn(core.store, 'query');
    await expect(core.getContextGraphOnChainId(cleartext)).resolves.toBe('14');
    await expect(core.getContextGraphOnChainId(wireHash)).resolves.toBe('14');
    expect(storeQuery).not.toHaveBeenCalled();
  });

  it('exactly one gossip handler is wired on the underlying topic regardless of subscribe shape', async () => {
    const { core, bus } = await makeCore();
    // Use the wire-hash form first to mirror the chain-event /
    // discovery-beacon path on a host-only core (no cleartext meta).
    const cleartext = 'canon-cg-handler-count';
    const wireHash = ethers.keccak256(ethers.toUtf8Bytes(cleartext)).toLowerCase();

    await core.enableSwmHostModeFor(wireHash);
    // The bookkeeping handler count is per-topic-equivalent — both
    // wire and cleartext forms canonicalize to the same wire hash
    // and resolve to the same gossip topic via
    // `contextGraphWorkspaceTopic`. Counting handlers across ALL
    // bus topics is equivalent to counting host-mode handlers for
    // this CG (the bus is fresh; nothing else subscribed).
    const totalHandlersAfterFirst = totalHandlers(bus);
    expect(totalHandlersAfterFirst).toBe(1);

    // Second subscribe under the cleartext form would, pre-fix, wire
    // a second handler on the same topic. After the fix it short-
    // circuits at the canonical `has()` check, so the bus's per-topic
    // handler count stays at 1.
    await core.enableSwmHostModeFor(cleartext);
    expect(totalHandlers(bus)).toBe(totalHandlersAfterFirst);
  });

  it('subscribe via cleartext, then unwire via wire-hash, leaves both maps empty', async () => {
    const { core } = await makeCore();
    const cleartext = 'canon-cg-unwire-mixed';
    const wireHash = ethers.keccak256(ethers.toUtf8Bytes(cleartext)).toLowerCase();

    await core.enableSwmHostModeFor(cleartext);
    const internals = core as unknown as AgentInternals;
    expect(internals.swmHostModeSubscribed.size).toBe(1);

    // `unwireSwmHostModeHandler` is private; reach through the
    // standard `disableSwmHostModeFor` if it exists, otherwise drive
    // the private path via the cast. The PR adds canonicalisation on
    // the unwire side too — a hash-form delete must release the
    // cleartext-form wire (and vice versa).
    const agent = core as unknown as { unwireSwmHostModeHandler(cgId: string): void };
    agent.unwireSwmHostModeHandler(wireHash);

    expect(internals.swmHostModeSubscribed.size).toBe(0);
    expect(internals.swmHostModeHandlers.size).toBe(0);
  });

  // PR #916 Codex review (commit `445a852`): the in-memory maps above
  // canonicalize to the wire hash, but the PERSISTED `hostModeSubscribed`
  // flag in the SwmHostModeStore is keyed by the CLEARTEXT id — the same
  // form `append` / `markRegistered` / catchup use (see the
  // `ingestSwmHostModeEnvelope` design note). `enqueueHostModePersistence`
  // used to forward the raw caller id straight to
  // `markHostModeSubscribed/Unsubscribed`, so a `mark` taken in one shape
  // and an `unmark` in the other landed in different `.meta` files and
  // the flag was never cleared — re-engaging a torn-down CG on restart.
  // The fix resolves the store key to cleartext via the
  // `wireIdToLocalCgId` reverse index while keeping the queue key
  // wire-canonical for ordering.

  it('hostModePersistenceStoreKey maps a known wire-hash to cleartext and leaves cleartext / unmapped hashes alone', async () => {
    const { core } = await makeCore();
    const internals = core as unknown as AgentInternals;
    const cleartext = 'persist-key-unit-cg';
    const wireHash = ethers.keccak256(ethers.toUtf8Bytes(cleartext)).toLowerCase();
    internals.wireIdToLocalCgId.set(wireHash, cleartext);

    expect(internals.hostModePersistenceStoreKey(wireHash)).toBe(cleartext);
    expect(internals.hostModePersistenceStoreKey(cleartext)).toBe(cleartext);
    // A valid wire-hash with no reverse-index entry falls back to a
    // lowercased copy of itself (stable key for the pre-cleartext window).
    const orphanHash = '0x' + 'AB'.repeat(32);
    expect(internals.hostModePersistenceStoreKey(orphanHash)).toBe(orphanHash.toLowerCase());
  });

  it('persisted host-mode flag: mark by wire-hash then unmark by cleartext collapse onto one record', async () => {
    const { core } = await makeCore();
    const internals = core as unknown as AgentInternals;
    const cleartext = 'persist-wire-then-clear-cg';
    const wireHash = ethers.keccak256(ethers.toUtf8Bytes(cleartext)).toLowerCase();
    internals.wireIdToLocalCgId.set(wireHash, cleartext);

    // Beacon/chain auto-host engages by wire-hash.
    internals.enqueueHostModePersistence(wireHash, true);
    await internals.awaitHostModePersistence(wireHash);
    expect(await internals.swmHostModeStore!.listHostModeSubscribedCgs()).toEqual([cleartext]);

    // Promoted-to-member / revoke unwire arrives in cleartext — must
    // clear the SAME record, not write an orphan one.
    internals.enqueueHostModePersistence(cleartext, false);
    await internals.awaitHostModePersistence(cleartext);
    expect(await internals.swmHostModeStore!.listHostModeSubscribedCgs()).toEqual([]);
  });

  it('persisted host-mode flag: mark by cleartext then unmark by wire-hash collapse onto one record', async () => {
    const { core } = await makeCore();
    const internals = core as unknown as AgentInternals;
    const cleartext = 'persist-clear-then-wire-cg';
    const wireHash = ethers.keccak256(ethers.toUtf8Bytes(cleartext)).toLowerCase();
    internals.wireIdToLocalCgId.set(wireHash, cleartext);

    internals.enqueueHostModePersistence(cleartext, true);
    await internals.awaitHostModePersistence(cleartext);
    expect(await internals.swmHostModeStore!.listHostModeSubscribedCgs()).toEqual([cleartext]);

    internals.enqueueHostModePersistence(wireHash, false);
    await internals.awaitHostModePersistence(wireHash);
    expect(await internals.swmHostModeStore!.listHostModeSubscribedCgs()).toEqual([]);
  });
});
