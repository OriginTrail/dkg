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
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGAgent } from '../../src/index.js';
import { SwmHostModeStore } from '../../src/swm/host-mode-store.js';

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
});
