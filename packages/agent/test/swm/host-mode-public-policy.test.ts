import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { SUBSCRIPTION_SOURCES, type SubscriptionSource } from '@origintrail-official/dkg-core';
import { decodeSwmHostCatchupResponse, encodeSwmHostCatchupRequest, SWM_HOST_CATCHUP_WIRE_VERSION } from '../../src/swm/host-catchup-wire.js';
import { mintSignedCatchupRequest } from '../../src/swm/host-catchup-sign.js';
import { createHostModeTestFixture, installGossipStub, type StripInternals } from './host-mode.fixture.js';
import { ContextGraphBindingState } from '../../src/context-graph-binding-state.js';
import { captureHostPolicyIdentityCurrent } from '../../src/internal/swm-host-catchup-policy.js';

describe('confirmed-public host-mode policy', () => {
  const { makeCore } = createHostModeTestFixture();

  it.each(['authoritative', 'reverse', 'unbound'] as const)('captures the canonical %s policy target until its binding changes', kind => {
    const id = 'captured-host-policy';
    const hash = ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
    const bindings = new ContextGraphBindingState();
    const row: { onChainId?: string; onChainHash: string } = { onChainHash: hash };
    const subscriptions = new Map([[id, row]]);
    if (kind === 'authoritative') row.onChainId = '10';
    if (kind === 'reverse') bindings.bindReverseCandidate(id, row, '10', hash);
    const current = captureHostPolicyIdentityCurrent({ subscriptions, bindings, wireOwners: new Map(),
      localId: () => id, hostKey: () => hash }, id);
    expect(current()).toBe(true);
    if (kind === 'reverse') bindings.bindReverseCandidate(id, row, '11', hash);
    else row.onChainId = '11';
    expect(current()).toBe(false);
  });

  it('serves a fresh ordinary public reader while refusing bad signatures, stale requests, replay and private data', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const id = 'ordinary-public-reader';
    const hash = ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
    g.config.swmHostMode = { enabled: true, hostPublic: true, stripCiphertext: true };
    const registration = await g.chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: hash });
    g.subscribedContextGraphs.set(id, { subscribed: false, coreHosted: true, synced: true, syncMode: 'always-on', onChainHash: hash, onChainId: String(registration.contextGraphId) });
    await g.reconcileSwmHostModeSubscription(id);
    const bytes = new Uint8Array([4, 5, 6]);
    await g.swmHostModeStore!.append(id, bytes);
    const wallet = ethers.Wallet.createRandom();
    expect(await g.chain.getIdentityIdForAddress(wallet.address)).toBe(0n);
    const signed = await mintSignedCatchupRequest({ contextGraphId: id, sinceSeqno: 0,
      maxEntries: 32, maxBytes: 65536, requesterEoa: wallet.address, sign: digest => wallet.signMessage(digest) });
    const send = async (request: typeof signed) => decodeSwmHostCatchupResponse(
      await g.handleSwmHostCatchup(encodeSwmHostCatchupRequest(request), 'ordinary-peer'));
    const bad = await send({ ...signed, sig: '0x' + '44'.repeat(65) });
    expect(bad.denied).toBeTruthy();
    const oldRequest = await mintSignedCatchupRequest({ contextGraphId: id, sinceSeqno: 0,
      maxEntries: 32, maxBytes: 65536, issuedAtMs: Date.now() - 600_000,
      requesterEoa: wallet.address, sign: digest => wallet.signMessage(digest) });
    const stale = await send(oldRequest);
    expect(stale.denied).toBeTruthy();
    const first = await send(signed);
    expect(first.denied).toBeUndefined();
    expect(first.entries).toHaveLength(1);
    expect(Uint8Array.from(Buffer.from(first.entries[0].envelopeB64, 'base64'))).toEqual(bytes);
    expect(first.nextSeqno).toBe(1);
    expect((await send(signed)).denied).toMatch(/replayed/);
    const privateId = 'ordinary-private-reader';
    g.wireSwmHostModeHandler(privateId, undefined, true);
    await g.swmHostModeStore!.append(privateId, new Uint8Array([9]));
    const privateRequest = await mintSignedCatchupRequest({ contextGraphId: privateId, sinceSeqno: 0,
      maxEntries: 32, maxBytes: 65536, requesterEoa: wallet.address, sign: digest => wallet.signMessage(digest) });
    const denied = await send(privateRequest);
    expect(denied.entries).toEqual([]);
    expect(denied.denied).toMatch(/strip is on/);
    g.config.swmHostMode!.stripCiphertext = false;
    const privateBaseline = await send(privateRequest);
    expect(privateBaseline.entries).toEqual([]);
    expect(privateBaseline.denied).toMatch(/authority/);
  });

  it.each([true, false])('rejects a signed nonmember when catch-up public proof loses its binding (strip=%s)', async strip => {
    const core = await makeCore(strip, { hostPublic: true });
    const g = core as unknown as StripInternals;
    const id = 'held-catchup-public-binding';
    const hash = ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
    const registered = await g.chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: hash });
    g.setContextGraphSubscription(id, { subscribed: false, synced: false, syncMode: 'always-on',
      onChainHash: hash, onChainId: String(registered.contextGraphId) }, { persist: false });
    await g.reconcileSwmHostModeSubscription(id);
    await g.swmHostModeStore!.append(id, new Uint8Array([19, 20, 21]));
    const wallet = ethers.Wallet.createRandom();
    expect(await g.chain.getIdentityIdForAddress(wallet.address)).toBe(0n);
    const signed = await mintSignedCatchupRequest({ contextGraphId: id, sinceSeqno: 0,
      maxEntries: 32, maxBytes: 65536, requesterEoa: wallet.address, sign: digest => wallet.signMessage(digest) });
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const actualPublicProof = g.isConfirmedPublicForHostMode.bind(g);
    const proof = vi.spyOn(g, 'isConfirmedPublicForHostMode').mockImplementation(async graph => {
      const confirmed = await actualPublicProof(graph);
      expect(confirmed).toBe(true);
      entered(); await gate; return confirmed;
    });
    const catching = g.handleSwmHostCatchup(encodeSwmHostCatchupRequest(signed), 'ordinary-held-peer');
    try {
      await reached;
      const replacement = await g.chain.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 1,
        nameHash: ethers.keccak256(ethers.toUtf8Bytes('catchup-private-slot')).toLowerCase() });
      g.setContextGraphSubscription(id, { subscribed: false, synced: false, syncMode: 'always-on',
        onChainHash: hash, onChainId: String(replacement.contextGraphId) }, { persist: false });
      expect(g.swmHostModeCurated.get(hash)).toBe(false);
      release();
      const response = decodeSwmHostCatchupResponse(await catching);
      expect(response.denied).toBeDefined();
      expect(response.entries).toEqual([]);
      expect((await g.swmHostModeStore!.stats()).perCg[id].entries).toBe(1);
    } finally { release(); await catching; proof.mockRestore(); }
  });

  it('hostPublic opt-in wires a confirmed public CG even while private strip is ON', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-public-core-tier';
    g.config.swmHostMode = { enabled: true, hostPublic: true, stripCiphertext: true };
    g.onChainAccessPolicyCache.set('2', 0);
    g.subscribedContextGraphs.set(cgId, { subscribed: false, synced: false, onChainId: '2' });
    g.isPrivateContextGraph = async () => false;
    g.isConfirmedPublicForHostMode = async () => true;
    expect(await (g as any).isCuratedForHostMode(cgId)).toBe(false);
    const wired: Array<{ id: string; curated?: boolean }> = [];
    g.wireSwmHostModeHandler = (id: string, _source?: SubscriptionSource, curated?: boolean) => {
      wired.push({ id, curated });
    };

    await g.reconcileSwmHostModeSubscription(cgId);

    expect(wired).toEqual([{ id: cgId, curated: false }]);
  });

  it('chain-event auto-host eligibility covers the full operator matrix', async () => {
    // Live observations, storage discovery and checkpoint restoration share
    // one owner. Drive its event path, not only its eligibility predicate.
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const eligible = (accessPolicy?: number, publishPolicy?: number): boolean =>
      (g as any).hostModeAutoHostEligible(accessPolicy, publishPolicy) as boolean;

    // Without the opt-in: only the curated tier auto-hosts.
    g.config.swmHostMode = { enabled: true, stripCiphertext: true };
    expect(eligible(1, 1)).toBe(true);
    expect(eligible(1, 0)).toBe(true);
    expect(eligible(0, 1)).toBe(false);
    expect(eligible(0, 0)).toBe(false);

    // With the opt-in: public AND open-publish joins it. accessPolicy 0 +
    // publishPolicy 0 is PCA — publicly readable but CURATED publish — and
    // stays OUT of the public host tier.
    g.config.swmHostMode = { enabled: true, hostPublic: true, stripCiphertext: true };
    expect(eligible(1, 1)).toBe(true);
    expect(eligible(1, 0)).toBe(true);
    expect(eligible(0, 1)).toBe(true);
    expect(eligible(0, 0)).toBe(false);
    // An event that carried no publishPolicy proves nothing about write
    // authority, so it is not the public tier either.
    expect(eligible(0, undefined)).toBe(false);
    expect(eligible(undefined, 1)).toBe(false);
    const reconcile = vi.spyOn(g, 'reconcileSwmHostModeSubscription').mockResolvedValue();
    let nextId = 100;
    for (const hostPublic of [false, true]) {
      g.config.swmHostMode = { enabled: true, hostPublic, stripCiphertext: true };
      for (const [accessPolicy, publishPolicy, expected] of [
        [0, 1, hostPublic], [0, 0, false], [1, 1, true],
      ] as const) {
        const onChainId = String(nextId++);
        const nameHash = ethers.keccak256(ethers.toUtf8Bytes(`observed-${onChainId}`)).toLowerCase();
        reconcile.mockClear();
        core.applyOnChainContextGraphObservation({ contextGraphId: onChainId,
          owner: ethers.ZeroAddress, nameHash, accessPolicy, publishPolicy,
          observedAtBlock: nextId }, { source: 'event' });
        expect(g.subscribedContextGraphs.get(nameHash)?.onChainId).toBe(onChainId);
        expect(g.onChainAccessPolicyCache.get(onChainId)).toBe(accessPolicy);
        if (expected) expect(reconcile).toHaveBeenCalledWith(nameHash, SUBSCRIPTION_SOURCES.CHAIN_EVENT);
        else expect(reconcile).not.toHaveBeenCalled();
      }
    }
    reconcile.mockRestore();
  });

  it('WITHOUT the hostPublic opt-in a confirmed public CG is NOT wired (dark by default)', async () => {
    // Codex review #2614 — every other test that reaches the non-curated admit
    // branch sets `hostPublic: true`, and the "default (no flag) DECLINES" case
    // uses a CURATED CG, so it is refused one branch earlier. Nothing pinned
    // the opt-in being off by default — the property the config doc promises.
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-public-no-opt-in';
    g.config.swmHostMode = { enabled: true, stripCiphertext: true }; // no hostPublic
    g.onChainAccessPolicyCache.set('2', 0);
    g.subscribedContextGraphs.set(cgId, { subscribed: false, synced: false, onChainId: '2' });
    g.isPrivateContextGraph = async () => false;
    const confirmed: string[] = [];
    g.isConfirmedPublicForHostMode = async (id: string) => { confirmed.push(id); return true; };
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); return true; };

    await g.reconcileSwmHostModeSubscription(cgId);

    expect(wired).toEqual([]);
    expect(g.swmHostModeHandlers.size).toBe(0);
    // The opt-in check returns BEFORE the chain probe — no RPC is spent on a
    // core that is not serving the public tier at all.
    expect(confirmed).toEqual([]);
  });

  it('hostPublic refuses an unconfirmed or restricted CG', async () => {
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    const cgId = 'cg-public-policy-unknown';
    g.config.swmHostMode = { enabled: true, hostPublic: true, stripCiphertext: true };
    g.onChainAccessPolicyCache.set('2', 0);
    g.subscribedContextGraphs.set(cgId, { subscribed: false, synced: false, onChainId: '2' });
    g.isPrivateContextGraph = async () => false;
    g.isConfirmedPublicForHostMode = async () => false;
    const wired: string[] = [];
    g.wireSwmHostModeHandler = (id: string) => { wired.push(id); return true; };

    await g.reconcileSwmHostModeSubscription(cgId);

    expect(wired).toEqual([]);
    expect(g.swmHostModeHandlers.size).toBe(0);
  });



  it('strip ON EXEMPTS a confirmed-public host-tier CG from the catch-up retirement', async () => {
    // GH #1611 — the public tier appends envelopes under the strip; denying
    // every catch-up would make that retention permanently unreadable. The
    // exemption is per CG and re-confirmed against chain state, so a curated
    // (or unclassified) CG on the SAME core is still refused at the strip gate.
    const core = await makeCore(true);
    const g = core as unknown as StripInternals;
    installGossipStub(g);
    const publicCg = 'cg-public-catchup';
    const curatedCg = 'cg-curated-catchup';
    // Codex review #2614 — a CG hosted as non-curated whose owner curated it
    // AFTER the marker was written. It passes the free local gate, so it is the
    // only case where the chain re-confirmation actually decides the outcome.
    const lateCuratedCg = 'cg-late-curated-catchup';
    const throwingCg = 'cg-policy-throws-catchup';
    g.wireSwmHostModeHandler(publicCg, undefined, false); // public host tier
    g.wireSwmHostModeHandler(curatedCg, undefined, true);
    g.wireSwmHostModeHandler(lateCuratedCg, undefined, false);
    g.wireSwmHostModeHandler(throwingCg, undefined, false);
    const confirmed: string[] = [];
    g.isConfirmedPublicForHostMode = async (id: string) => {
      confirmed.push(id);
      if (id === throwingCg) throw new Error('simulated policy resolver failure');
      return id === publicCg;
    };

    const request = (cgId: string): Uint8Array => encodeSwmHostCatchupRequest({
      version: SWM_HOST_CATCHUP_WIRE_VERSION,
      contextGraphId: cgId,
      sinceSeqno: 0,
      requesterEoa: '0x' + '22'.repeat(20),
      issuedAtMs: Date.now(),
      nonce: '0x' + '33'.repeat(16),
      sig: '0x' + '44'.repeat(65),
    });

    // The public CG gets PAST the strip gate — it fails later, on the ordinary
    // LU-6 B1 authorization of an unsigned-by-anyone request, not on the strip.
    const publicResp = decodeSwmHostCatchupResponse(
      await g.handleSwmHostCatchup(request(publicCg), '12D3KooWPeer'),
    );
    expect(publicResp.denied ?? '').not.toMatch(/strip is on/i);
    expect(confirmed).toEqual([publicCg]);

    // The curated CG on the same core never reaches the chain re-confirmation:
    // the free `swmHostModeCurated` gate refuses it first.
    const curatedResp = decodeSwmHostCatchupResponse(
      await g.handleSwmHostCatchup(request(curatedCg), '12D3KooWPeer'),
    );
    expect(curatedResp.entries).toEqual([]);
    expect(curatedResp.denied ?? '').toMatch(/strip is on/i);
    expect(confirmed).toEqual([publicCg]);

    // An unclassified CG (e.g. legacy ciphertext left on disk from before the
    // strip rolled out) fails closed the same way.
    const unknownResp = decodeSwmHostCatchupResponse(
      await g.handleSwmHostCatchup(request('cg-never-wired'), '12D3KooWPeer'),
    );
    expect(unknownResp.denied ?? '').toMatch(/strip is on/i);
    expect(confirmed).toEqual([publicCg]);

    // The chain leg is the DECIDING condition here: the CG passes the free
    // local gate and is refused only because chain state says it is no longer
    // public. Deleting the leg would serve it.
    const lateCuratedResp = decodeSwmHostCatchupResponse(
      await g.handleSwmHostCatchup(request(lateCuratedCg), '12D3KooWPeer'),
    );
    expect(lateCuratedResp.entries).toEqual([]);
    expect(lateCuratedResp.denied ?? '').toMatch(/strip is on/i);
    expect(confirmed).toEqual([publicCg, lateCuratedCg]);

    // A resolver failure denies too (fail closed), and still answers with a
    // structured response rather than throwing at the messenger substrate.
    const throwingResp = decodeSwmHostCatchupResponse(
      await g.handleSwmHostCatchup(request(throwingCg), '12D3KooWPeer'),
    );
    expect(throwingResp.entries).toEqual([]);
    expect(throwingResp.denied ?? '').toMatch(/strip is on/i);
    expect(confirmed).toEqual([publicCg, lateCuratedCg, throwingCg]);
  });

});
