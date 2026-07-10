/**
 * OT-RFC-49 WS-A — private-ciphertext strip (the irreversible host-mode strip).
 *
 * "Hosting follows access": with the `swmHostMode.stripCiphertext` flag ON
 * (the DEFAULT — `undefined` strips), a core custodies ZERO private SWM
 * ciphertext for CURATED context graphs. Random sampling now proves the public
 * `_catalog`, so the ciphertext lives member-side and members backfill from the
 * curator (REPLACE-recovery), never from a core. This file pins the five gated
 * entry points:
 *
 *   1. `reconcileSwmHostModeSubscription` — the primary subscribe choke point
 *      (declines, so neither `.meta` nor LU-11 chunk ingest is wired);
 *   2. `enableSwmHostModeFor` — the operator override hatch is CLOSED for
 *      curated CGs (WS-A divergence from rung-1, which left it open);
 *   3. `handleSwmHostCatchup` — the host-mode catch-up egress serves nothing;
 *   4. `handleGetCiphertextChunk` — the LU-11 chunk peer-serve (incl. the
 *      RFC-39 node-operator authority branch) serves nothing;
 *   5. `chooseFanOutTier` — a PRIVATE allowlist CG drops the gossip leg so
 *      curated ciphertext never floods the public mesh.
 *
 * With the flag OFF (baseline), every path engages exactly as before — proving
 * the strip is gated and reversible via the kill-switch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGAgent } from '../../src/index.js';
import { SwmHostModeStore } from '../../src/swm/host-mode-store.js';
import {
  encodeGossipEnvelope,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED,
  type SubscriptionSource,
} from '@origintrail-official/dkg-core';
import {
  chooseFanOutTier,
  type ChooseFanOutTierInput,
} from '../../src/swm/substrate-fanout.js';
import type { CGMemberEnumeration } from '../../src/swm/enumerate-cg-members.js';
import {
  decodeSwmHostCatchupResponse,
} from '../../src/swm/host-catchup-wire.js';
import {
  decodeCiphertextChunkCatchupResponse,
} from '../../src/swm/ciphertext-chunk-catchup.js';

interface StripInternals {
  swmHostModeStore?: SwmHostModeStore;
  swmHostModeHandlers: Map<string, (topic: string, data: Uint8Array, from: string) => void>;
  swmHostModeCurated: Map<string, boolean>;
  gossip: {
    subscribe(topic: string): void;
    onMessage(topic: string, handler: (topic: string, data: Uint8Array, from: string) => void): void;
  };
  subscribedContextGraphs: Map<string, { subscribed: boolean; synced: boolean; onChainHash?: string }>;
  config: { swmHostMode?: { enabled?: boolean; stripCiphertext?: boolean } };
  isPrivateContextGraph(cgId: string): Promise<boolean>;
  wireSwmHostModeHandler(cgId: string, source?: SubscriptionSource, curated?: boolean): void;
  reconcileSwmHostModeSubscription(cgId: string): Promise<void>;
  ingestSwmHostModeEnvelope(cgId: string, data: Uint8Array, from: string): Promise<void>;
  ingestSwmCiphertextChunkEnvelope(cgId: string, data: Uint8Array, from: string): Promise<void>;
  enableSwmHostModeFor(cgId: string): Promise<{
    subscribed: boolean; alreadySubscribed: boolean; hostingEnabled: boolean; memberMode?: boolean;
  }>;
  handleSwmHostCatchup(data: Uint8Array, fromPeerId: string): Promise<Uint8Array>;
  handleGetCiphertextChunk(data: Uint8Array, fromPeerId: string): Promise<Uint8Array>;
}

/** A curated CG: any `onChainHash` makes the three-source curation probe in
 * `reconcileSwmHostModeSubscription` resolve "curated" via its cheapest branch. */
const CURATED = (id: string): { subscribed: boolean; synced: boolean; onChainHash: string } => ({
  subscribed: true,
  synced: true,
  onChainHash: ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase(),
});

function hostEnvelope(contextGraphId: string, chunked: boolean): Uint8Array {
  return encodeGossipEnvelope({
    version: GOSSIP_ENVELOPE_VERSION,
    type: chunked ? GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED : GOSSIP_TYPE_WORKSPACE_PUBLISH,
    contextGraphId,
    agentAddress: ethers.ZeroAddress,
    timestamp: String(Date.now()),
    signature: new Uint8Array(65),
    payload: new Uint8Array([1, 2, 3]),
    ...(chunked ? { swmMessageIndex: 0 } : {}),
  });
}

function installGossipStub(g: StripInternals): void {
  g.gossip = {
    subscribe: vi.fn(),
    onMessage: vi.fn(),
  };
}

describe('OT-RFC-49 WS-A — host-mode private-ciphertext strip', () => {
  const tempDirs: string[] = [];
  const agents: DKGAgent[] = [];

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((a) => a.stop().catch(() => {}).then(() => a.store.close().catch(() => {}))));
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /** A core with a host-mode store installed. `strip` toggles the WS-A flag;
   * omit it to exercise the DEFAULT (strip ON). */
  async function makeCore(strip?: boolean): Promise<DKGAgent> {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-strip-ct-'));
    tempDirs.push(dataDir);
    const core = await DKGAgent.create({
      name: 'StripCiphertextCore',
      listenHost: '127.0.0.1',
      dataDir,
      nodeRole: 'core',
      swmHostMode: strip === undefined ? { enabled: true } : { enabled: true, stripCiphertext: strip },
    });
    agents.push(core);
    const store = new SwmHostModeStore({
      dataDir: join(dataDir, 'swm-host'),
      ...SwmHostModeStore.defaultLimits(),
    });
    await store.init();
    (core as unknown as StripInternals).swmHostModeStore = store;
    return core;
  }

  // ── 1. reconcile subscribe-decline (primary choke point) ─────────────────

  it('default (no flag) DECLINES host-mode subscribe for a curated CG — strip is ON by default', async () => {
    const core = await makeCore(); // no stripCiphertext → undefined → ON
    const g = core as unknown as StripInternals;
    const cgId = 'cg-curated-default';
    g.subscribedContextGraphs.set(cgId, CURATED(cgId));
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); };

    await g.reconcileSwmHostModeSubscription(cgId);

    expect(wired).toEqual([]);
    expect(g.swmHostModeHandlers.size).toBe(0);
  });

  it('strip ON DECLINES host-mode subscribe for a curated CG (no handler wired)', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-curated-stripped';
    g.subscribedContextGraphs.set(cgId, CURATED(cgId));
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); };

    await g.reconcileSwmHostModeSubscription(cgId);

    expect(wired).toEqual([]);
    expect(g.swmHostModeHandlers.size).toBe(0);
  });

  it('strip OFF (baseline) WIRES host-mode subscribe for a curated CG', async () => {
    const core = await makeCore(false);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-curated-baseline';
    g.subscribedContextGraphs.set(cgId, CURATED(cgId));
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); };

    await g.reconcileSwmHostModeSubscription(cgId);

    expect(wired).toEqual([cgId]);
  });

  // ── 2. operator override hatch CLOSED (WS-A divergence from rung-1) ───────

  it('strip ON CLOSES the operator override `enableSwmHostModeFor` for a curated CG', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-operator-curated';
    g.isPrivateContextGraph = async () => true; // curated
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); };

    const result = await g.enableSwmHostModeFor(cgId);

    expect(result).toEqual({ subscribed: false, alreadySubscribed: false, hostingEnabled: true });
    expect(wired).toEqual([]);
  });

  it('strip OFF (baseline) leaves the operator override OPEN for a curated CG', async () => {
    const core = await makeCore(false);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-operator-baseline';
    g.isPrivateContextGraph = async () => true; // curated
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); };

    const result = await g.enableSwmHostModeFor(cgId);

    expect(result.subscribed).toBe(true);
    expect(wired).toEqual([cgId]);
  });

  it('strip ON CLOSES the operator hatch for a host-only core (curated via onChainHash, NO local _meta)', async () => {
    // The WS-A target case: a core that learned of a curated CG via
    // chain-event/beacon has NO local `_meta`, so `isPrivateContextGraph`
    // returns false. The operator hatch must STILL refuse — it consults the
    // same three-source curation probe (`onChainHash`) the auto-host path uses,
    // not `isPrivateContextGraph` alone.
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-host-only-core';
    g.subscribedContextGraphs.set(cgId, CURATED(cgId)); // curated via onChainHash
    g.isPrivateContextGraph = async () => false;        // no local _meta
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); };

    const result = await g.enableSwmHostModeFor(cgId);

    expect(result).toEqual({ subscribed: false, alreadySubscribed: false, hostingEnabled: true });
    expect(wired).toEqual([]);
  });

  it('strip ON does NOT affect the operator override for a PUBLIC/uncurated CG', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-operator-public';
    g.isPrivateContextGraph = async () => false; // public — never stripped
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); };

    const result = await g.enableSwmHostModeFor(cgId);

    expect(result.subscribed).toBe(true);
    expect(wired).toEqual([cgId]);
  });

  it('strip ON gates both legacy and chunked dispatch for a curated handler', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-curated-dispatch';
    const legacyIngest = vi.fn(async () => {});
    const chunkIngest = vi.fn(async () => {});
    g.ingestSwmHostModeEnvelope = legacyIngest;
    g.ingestSwmCiphertextChunkEnvelope = chunkIngest;
    installGossipStub(g);

    g.wireSwmHostModeHandler(cgId, undefined, true);
    const handler = [...g.swmHostModeHandlers.values()][0]!;
    handler('', hostEnvelope(cgId, false), 'peer-legacy');
    handler('', hostEnvelope(cgId, true), 'peer-chunk');

    expect(legacyIngest).not.toHaveBeenCalled();
    expect(chunkIngest).not.toHaveBeenCalled();
  });

  it('strip ON preserves both dispatch branches for an explicitly non-curated handler', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-public-dispatch';
    const legacyIngest = vi.fn(async () => {});
    const chunkIngest = vi.fn(async () => {});
    g.ingestSwmHostModeEnvelope = legacyIngest;
    g.ingestSwmCiphertextChunkEnvelope = chunkIngest;
    installGossipStub(g);

    g.wireSwmHostModeHandler(cgId, undefined, false);
    const handler = [...g.swmHostModeHandlers.values()][0]!;
    handler('', hostEnvelope(cgId, false), 'peer-legacy');
    handler('', hostEnvelope(cgId, true), 'peer-chunk');

    expect(legacyIngest).toHaveBeenCalledOnce();
    expect(chunkIngest).toHaveBeenCalledOnce();
  });

  it('reconciliation upgrades a stale non-curated handler before later dispatch', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-becomes-curated';
    const legacyIngest = vi.fn(async () => {});
    const chunkIngest = vi.fn(async () => {});
    g.ingestSwmHostModeEnvelope = legacyIngest;
    g.ingestSwmCiphertextChunkEnvelope = chunkIngest;
    installGossipStub(g);

    g.wireSwmHostModeHandler(cgId, undefined, false);
    g.subscribedContextGraphs.set(cgId, CURATED(cgId));
    await g.reconcileSwmHostModeSubscription(cgId);

    expect([...g.swmHostModeCurated.values()]).toEqual([true]);
    const handler = [...g.swmHostModeHandlers.values()][0]!;
    handler('', hostEnvelope(cgId, false), 'peer-legacy');
    handler('', hostEnvelope(cgId, true), 'peer-chunk');
    expect(legacyIngest).not.toHaveBeenCalled();
    expect(chunkIngest).not.toHaveBeenCalled();
  });

  // ── 3 + 4. serve responders RETIRED ──────────────────────────────────────

  it('strip ON RETIRES handleSwmHostCatchup — serves nothing private', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    // Garbage request bytes are fine: the strip denies BEFORE decoding.
    const resp = await g.handleSwmHostCatchup(new Uint8Array([1, 2, 3]), '12D3KooWPeer');
    const decoded = decodeSwmHostCatchupResponse(resp);
    expect(decoded.entries).toEqual([]);
    expect(decoded.denied ?? '').toMatch(/strip is on/i);
  });

  it('strip ON RETIRES handleGetCiphertextChunk — serves nothing private (incl. RFC-39 operator branch)', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const resp = await g.handleGetCiphertextChunk(new Uint8Array([4, 5, 6]), '12D3KooWPeer');
    const decoded = decodeCiphertextChunkCatchupResponse(resp);
    expect(decoded.ciphertextB64).toBeUndefined();
    expect(decoded.denied ?? '').toMatch(/strip is on/i);
  });

  it('strip OFF (baseline) does NOT retire the serve responders at the strip gate', async () => {
    const core = await makeCore(false);
    const g = core as unknown as StripInternals;
    // With the strip OFF the responders proceed to decode; garbage bytes now
    // yield a DECODE-level denial, NOT the strip denial. The point is only that
    // the strip gate did not short-circuit the path.
    const hostResp = decodeSwmHostCatchupResponse(await g.handleSwmHostCatchup(new Uint8Array([1, 2, 3]), '12D3KooWPeer'));
    expect(hostResp.denied ?? '').not.toMatch(/strip is on/i);
    const chunkResp = decodeCiphertextChunkCatchupResponse(await g.handleGetCiphertextChunk(new Uint8Array([4, 5, 6]), '12D3KooWPeer'));
    expect(chunkResp.denied ?? '').not.toMatch(/strip is on/i);
  });
});

// ── 5. chooseFanOutTier — private allowlist drops the gossip leg ───────────

describe('OT-RFC-49 WS-A — chooseFanOutTier private-CG gossip gate', () => {
  const allowlist = (members: string[]): CGMemberEnumeration => ({
    members,
    source: 'allowlist',
  } as CGMemberEnumeration);

  const base = (enumeration: CGMemberEnumeration, isPrivate?: boolean): ChooseFanOutTierInput => ({
    enumeration,
    maxSubstrateMembers: 100,
    isPrivate,
  });

  it('private allowlist CG with a roster → substrate ON, gossip OFF', () => {
    const plan = chooseFanOutTier(base(allowlist(['12D3KooWA', '12D3KooWB']), true));
    expect(plan.useSubstrate).toBe(true);
    expect(plan.useGossip).toBe(false);
    expect(plan.substrateMembers).toEqual(['12D3KooWA', '12D3KooWB']);
  });

  it('private allowlist CG with an EMPTY roster → keeps gossip ON (no silent drop)', () => {
    const plan = chooseFanOutTier(base(allowlist([]), true));
    expect(plan.useGossip).toBe(true);
  });

  it('public allowlist CG (isPrivate falsey) → gossip stays ON (cross-version safety net)', () => {
    const plan = chooseFanOutTier(base(allowlist(['12D3KooWA']), undefined));
    expect(plan.useGossip).toBe(true);
  });

  it("private 'none' tier is NOT touched — gossip stays ON (its only transport)", () => {
    const plan = chooseFanOutTier(base({ members: [], source: 'none' } as CGMemberEnumeration, true));
    expect(plan.useSubstrate).toBe(false);
    expect(plan.useGossip).toBe(true);
  });
});
