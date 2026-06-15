/**
 * Rung-1 SWM strip — non-participant nodes custody ZERO private-CG ciphertext.
 *
 * The strip inverts host-mode custody: a third-party core that merely LEARNED of
 * a private CG (via the chain-event / discovery-beacon auto-host path) must NOT
 * subscribe to or store that CG's SWM ciphertext. Only the curator and members
 * custody it; members backfill from the curator (REPLACE-recovery), not cores.
 *
 * Two layers are pinned here:
 *   1. `isNodeParticipantOfCg` decision logic — curator OR local-meta member OR
 *      on-chain participant ⇒ true; bystander ⇒ false; positive answer is
 *      memoized (`participantCgIds`), negative is re-evaluated (self-healing for
 *      a freshly-joined member).
 *   2. `reconcileSwmHostModeSubscription` gate — a curated CG the node is NOT a
 *      participant of DECLINES (no host handler wired); a participant WIRES.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGAgent } from '../../src/index.js';
import { SwmHostModeStore } from '../../src/swm/host-mode-store.js';

interface GateInternals {
  swmHostModeStore?: SwmHostModeStore;
  swmHostModeHandlers: Map<string, unknown>;
  subscribedContextGraphs: Map<string, { subscribed: boolean; synced: boolean; onChainHash?: string }>;
  participantCgIds: Set<string>;
  localAgents: Map<string, unknown>;
  isCuratorOf(cgId: string): Promise<boolean>;
  getContextGraphAgentGateAddresses(cgId: string): Promise<string[] | null>;
  resolveOnChainParticipantAgents(cgId: string): Promise<string[] | null>;
  isNodeParticipantOfCg(cgId: string): Promise<boolean>;
  wireSwmHostModeHandler(cgId: string, source?: unknown): void;
  reconcileSwmHostModeSubscription(cgId: string): Promise<void>;
}

const CURATED = (id: string): { subscribed: boolean; synced: boolean; onChainHash: string } => ({
  subscribed: true,
  synced: true,
  // any onChainHash makes the three-source curation probe resolve "curated"
  // via its cheapest branch — see reconcileSwmHostModeSubscription.
  onChainHash: ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase(),
});

describe('rung-1 strip — host-mode participant gate', () => {
  const tempDirs: string[] = [];
  const agents: DKGAgent[] = [];

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((a) => a.stop().catch(() => {}).then(() => a.store.close().catch(() => {}))));
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeCore(): Promise<DKGAgent> {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-participant-gate-'));
    tempDirs.push(dataDir);
    const core = await DKGAgent.create({
      name: 'ParticipantGateCore',
      listenHost: '127.0.0.1',
      dataDir,
      nodeRole: 'core',
      swmHostMode: { enabled: true },
    });
    agents.push(core);
    const store = new SwmHostModeStore({
      dataDir: join(dataDir, 'swm-host'),
      ...SwmHostModeStore.defaultLimits(),
    });
    await store.init();
    (core as unknown as GateInternals).swmHostModeStore = store;
    return core;
  }

  /** Stub the three constituents so the decision logic is exercised in isolation. */
  function stubConstituents(
    core: DKGAgent,
    opts: { curator?: boolean; localMeta?: string[] | null; onChain?: string[] | null; localAgent?: string },
  ): void {
    const g = core as unknown as GateInternals;
    const addr = opts.localAgent ?? '0x1111111111111111111111111111111111111111';
    g.localAgents.set(addr, {});
    g.isCuratorOf = async () => !!opts.curator;
    g.getContextGraphAgentGateAddresses = async () => opts.localMeta ?? null;
    g.resolveOnChainParticipantAgents = async () => opts.onChain ?? null;
  }

  it('bystander (not curator, not in local meta, not on-chain participant) ⇒ NOT a participant, not memoized', async () => {
    const core = await makeCore();
    const g = core as unknown as GateInternals;
    stubConstituents(core, { curator: false, localMeta: null, onChain: null });

    expect(await g.isNodeParticipantOfCg('cg-bystander')).toBe(false);
    // negative answers are deliberately NOT cached (self-heal on later join)
    expect(g.participantCgIds.has('cg-bystander')).toBe(false);
  });

  it('curator ⇒ participant (resolved locally, no chain) and memoized', async () => {
    const core = await makeCore();
    const g = core as unknown as GateInternals;
    stubConstituents(core, { curator: true });

    expect(await g.isNodeParticipantOfCg('cg-curated-by-me')).toBe(true);
    expect(g.participantCgIds.has('cg-curated-by-me')).toBe(true);

    // memo sticks even if the constituent later flips to false
    g.isCuratorOf = async () => false;
    expect(await g.isNodeParticipantOfCg('cg-curated-by-me')).toBe(true);
  });

  it('member via local `_meta` allowlist (case-insensitive) ⇒ participant', async () => {
    const core = await makeCore();
    const g = core as unknown as GateInternals;
    const me = '0xAbCdEf0000000000000000000000000000000001';
    // local agent stored lower; allowlist returns checksum/mixed case — must still match
    stubConstituents(core, { localMeta: [me], localAgent: me.toLowerCase() });

    expect(await g.isNodeParticipantOfCg('cg-i-joined')).toBe(true);
    expect(g.participantCgIds.has('cg-i-joined')).toBe(true);
  });

  it('member via on-chain participant set ⇒ participant (form-robust backstop)', async () => {
    const core = await makeCore();
    const g = core as unknown as GateInternals;
    const me = '0x2222222222222222222222222222222222222222';
    stubConstituents(core, { localMeta: null, onChain: [me], localAgent: me });

    expect(await g.isNodeParticipantOfCg('cg-onchain-member')).toBe(true);
  });

  it('local-meta allowlist that excludes this node ⇒ NOT a participant', async () => {
    const core = await makeCore();
    const g = core as unknown as GateInternals;
    stubConstituents(core, {
      localMeta: ['0x9999999999999999999999999999999999999999'], // someone else
      localAgent: '0x1111111111111111111111111111111111111111',
    });

    expect(await g.isNodeParticipantOfCg('cg-others-only')).toBe(false);
  });

  it('reconcile DECLINES host-mode for a curated CG the node is NOT a participant of (no handler wired)', async () => {
    const core = await makeCore();
    const g = core as unknown as GateInternals;
    const cgId = 'cg-private-bystander';
    g.subscribedContextGraphs.set(cgId, CURATED(cgId));
    g.isNodeParticipantOfCg = async () => false;
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); };

    await g.reconcileSwmHostModeSubscription(cgId);

    expect(wired).toEqual([]);
    expect(g.swmHostModeHandlers.size).toBe(0);
  });

  it('reconcile WIRES host-mode for a curated CG the node IS a participant of', async () => {
    const core = await makeCore();
    const g = core as unknown as GateInternals;
    const cgId = 'cg-private-participant';
    g.subscribedContextGraphs.set(cgId, CURATED(cgId));
    g.isNodeParticipantOfCg = async () => true;
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); };

    await g.reconcileSwmHostModeSubscription(cgId);

    expect(wired).toEqual([cgId]);
  });
});
