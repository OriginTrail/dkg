/**
 * E2E: cross-node curated-CG JOIN approval/rejection over REAL libp2p
 * (2 real DKGAgents, shared real chain).
 *
 * This closes a coverage gap that NO single-node test can reach: the
 * `join_approved` / `join_rejected` decision is delivered from the curator
 * to the REQUESTER'S node over a real P2P stream (PROTOCOL_JOIN_REQUEST /
 * the join-decision return path), and only on that delivery does the
 * requester's `getJoinRequestStatus` flip to approved/rejected. A
 * same-node requester short-circuits to `delivered:'local'` and never
 * exercises the cross-node decision delivery (see notifications-route
 * test, which documents this as devnet-tier).
 *
 * Mirrors the e2e-context-graph harness: real agents, real libp2p
 * (`joiner.connectTo(curator multiaddr)`), shared EVMChainAdapter.
 */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { installHardhatACKProvider } from './_helpers/v10-acks.js';
import { DKGAgent } from '../src/index.js';
import type { ContextGraphSubscriptionRecord } from '../src/index.js';
import {
  decodeReliableEnvelope,
  DKGEvent,
  PROTOCOL_JOIN_REQUEST,
} from '@origintrail-official/dkg-core';
import {
  createEVMAdapter,
  getSharedContext,
  createProvider,
  takeSnapshot,
  revertSnapshot,
  HARDHAT_KEYS,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';

const CG = 'curated-join-e2e';

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs = 20_000,
  stepMs = 400,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!pred(last) && Date.now() < deadline) {
    await sleep(stepMs);
    last = await fn();
  }
  return last;
}

let _fileSnapshot: string;
beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

describe('E2E: cross-node curated-CG join over real libp2p (shared chain)', () => {
  const sharedChain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  let curator: DKGAgent; // owns + curates the CG
  let joiner: DKGAgent; // hosts the requesting agents
  let approvedAddr: string;
  let rejectedAddr: string;
  let retryAddr: string;
  let preapprovedAddr: string;
  const tempDirs: string[] = [];
  const joinerPersistedSubscriptions = new Map<string, ContextGraphSubscriptionRecord>();

  afterAll(async () => {
    try { await curator?.stop(); } catch { /* ignore */ }
    try { await joiner?.stop(); } catch { /* ignore */ }
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('boots two real agents, connects them over libp2p, and registers the requesting agents', async () => {
    const curatorDataDir = await mkdtemp(join(tmpdir(), 'dkg-e2e-join-curator-'));
    const joinerDataDir = await mkdtemp(join(tmpdir(), 'dkg-e2e-join-joiner-'));
    tempDirs.push(curatorDataDir, joinerDataDir);
    curator = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'Curator',
      listenPort: 0,
      skills: [],
      chainAdapter: sharedChain,
      nodeRole: 'core',
      dataDir: curatorDataDir,
    });
    joiner = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'Joiner',
      listenPort: 0,
      skills: [],
      chainAdapter: sharedChain,
      nodeRole: 'edge',
      dataDir: joinerDataDir,
      contextGraphSubscriptionStore: {
        loadAll: async () => [...joinerPersistedSubscriptions.values()],
        save: async (record) => { joinerPersistedSubscriptions.set(record.id, { ...record }); },
        delete: async (id) => { joinerPersistedSubscriptions.delete(id); },
      },
    });

    await curator.start();
    await installHardhatACKProvider(curator, sharedChain);
    await joiner.start();
    await sleep(800);

    const addrA = curator.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await joiner.connectTo(addrA);
    await sleep(1500);

    expect(curator.node.libp2p.getPeers().length, 'curator has no peers').toBeGreaterThanOrEqual(1);
    expect(joiner.node.libp2p.getPeers().length, 'joiner has no peers').toBeGreaterThanOrEqual(1);

    // Two custodial requesting agents on the joiner node (each holds a real
    // signing key so signJoinRequest can produce a real SignedAgentDelegation).
    const recApprove = await joiner.registerAgent('joiner-approve', { framework: 'test' });
    const recReject = await joiner.registerAgent('joiner-reject', { framework: 'test' });
    const recRetry = await joiner.registerAgent('joiner-retry', { framework: 'test' });
    const recPreapproved = await joiner.registerAgent('joiner-preapproved', { framework: 'test' });
    approvedAddr = recApprove.agentAddress;
    rejectedAddr = recReject.agentAddress;
    retryAddr = recRetry.agentAddress;
    preapprovedAddr = recPreapproved.agentAddress;
    expect(approvedAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(rejectedAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(retryAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(preapprovedAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }, 25_000);

  it('the curator owns a CURATED context graph (join-gated)', async () => {
    await curator.createContextGraph({ id: CG, name: 'Curated Join E2E', description: '', accessPolicy: 1 });
    await curator.registerContextGraph(CG);
    expect(await curator.isCuratorOf(CG), 'curator should curate the CG').toBe(true);
    // The joiner is NOT the curator → its join requests must go over the wire.
    expect(await joiner.isCuratorOf(CG)).toBe(false);
  }, 15_000);

  it('add-agent stays passive until request-join, then already-member approval catches up in the same cycle', async () => {
    const subject = 'urn:dkg:e2e-join:preapproved-catchup';
    // Seed a valid graph-scoped SWM asset. A raw triple in the legacy CG data
    // bucket is intentionally rejected by durable sync because it has no
    // Merkle-bound V2 descriptor. Create it before adding the remote member:
    // until that member's join delegation arrives, the curator does not yet
    // have its verified workspace encryption key.
    await curator.assertion.create(CG, 'preapproved-catchup');
    await curator.assertion.write(CG, 'preapproved-catchup', [{
      subject,
      predicate: 'http://schema.org/name',
      object: '"Preapproved Catchup"',
    }]);
    await curator.assertion.promote(CG, 'preapproved-catchup');
    const published = await curator.publishFromFinalizedAssertion(CG, 'preapproved-catchup');
    expect(published.status).toBe('confirmed');
    await curator.inviteAgentToContextGraph(CG, preapprovedAddr);

    // add-agent grants authorization on the curator. It is not local join
    // intent on the edge and must not install any subscription machinery.
    expect(joiner.getSubscribedContextGraphs().get(CG)?.subscribed ?? false).toBe(false);
    expect((joiner as any).gossipRegistered.has(CG)).toBe(false);
    expect((joiner as any).config.syncContextGraphs ?? []).not.toContain(CG);
    expect(joinerPersistedSubscriptions.has(CG)).toBe(false);

    const delegation = await joiner.signJoinRequest(CG, preapprovedAddr);
    const forwarded = await joiner.forwardJoinRequest(
      CG,
      delegation,
      'joiner-preapproved',
      curator.peerId,
    );
    expect(forwarded).toMatchObject({ delivered: 1, alreadyMember: true });

    const caughtUp = await pollUntil(
      async () => {
        const data = await joiner.query(
          `SELECT ?name WHERE { <${subject}> <http://schema.org/name> ?name . }`,
          CG,
        );
        return {
          subscribed: joiner.getSubscribedContextGraphs().get(CG)?.subscribed === true,
          hasData: data.bindings.length > 0,
        };
      },
      (state) => state.subscribed && state.hasData,
      30_000,
    );

    expect(caughtUp).toEqual({ subscribed: true, hasData: true });
    // The 10.0.16 default installs RFC-64 catalog responsibility for an
    // approved private member. Catch-up must complete without reviving the
    // legacy GossipSub or durable-sync receiver lanes.
    expect((joiner as any).gossipRegistered.has(CG)).toBe(false);
    expect((joiner as any).config.syncContextGraphs ?? []).not.toContain(CG);
    expect(joiner.readRfc64CatalogResponsibilitiesV1()).toEqual([
      expect.objectContaining({
        contextGraphId: CG,
        responsibilityReason: 'private-membership',
        mode: 'catalog',
        selectionSource: 'default',
      }),
    ]);
    expect(joinerPersistedSubscriptions.get(CG)).toMatchObject({
      subscribed: true,
      syncScoped: false,
    });
  }, 45_000);

  it('a join request forwarded over real libp2p lands as PENDING on the curator', async () => {
    const delegation = await joiner.signJoinRequest(CG, approvedAddr);
    const result = await joiner.forwardJoinRequest(CG, delegation, 'joiner-approve', curator.peerId);
    expect(result.delivered, `forward result: ${JSON.stringify(result)}`).toBeGreaterThanOrEqual(1);

    const pending = await pollUntil(
      () => curator.listPendingJoinRequests(CG),
      (rows) => rows.some((r: any) => String(r.agentAddress).toLowerCase() === approvedAddr.toLowerCase()),
    );
    expect(
      pending.some((r: any) => String(r.agentAddress).toLowerCase() === approvedAddr.toLowerCase()),
      `curator pending list: ${JSON.stringify(pending)}`,
    ).toBe(true);
  }, 30_000);

  it('curator APPROVAL is delivered back to the requester node cross-node (status → approved)', async () => {
    await curator.approveJoinRequest(CG, approvedAddr);
    const status = await pollUntil(
      () => joiner.getJoinRequestStatus(CG, approvedAddr),
      (s) => s === 'approved',
    );
    expect(status, 'approval did not reach the requester node over P2P').toBe('approved');
  }, 30_000);

  it('curator REJECTION is delivered back to the requester node cross-node (status → rejected)', async () => {
    // Second agent forwards a request, curator rejects it, and the rejection
    // must reach the requester node the same way an approval does.
    const delegation = await joiner.signJoinRequest(CG, rejectedAddr);
    const fwd = await joiner.forwardJoinRequest(CG, delegation, 'joiner-reject', curator.peerId);
    expect(fwd.delivered, `forward(reject) result: ${JSON.stringify(fwd)}`).toBeGreaterThanOrEqual(1);

    await pollUntil(
      () => curator.listPendingJoinRequests(CG),
      (rows) => rows.some((r: any) => String(r.agentAddress).toLowerCase() === rejectedAddr.toLowerCase()),
    );

    await curator.rejectJoinRequest(CG, rejectedAddr);
    const status = await pollUntil(
      () => joiner.getJoinRequestStatus(CG, rejectedAddr),
      (s) => s === 'rejected',
    );
    expect(status, 'rejection did not reach the requester node over P2P').toBe('rejected');
  }, 30_000);

  it('retries the identical approval envelope when requester persistence aborts the first receive', async () => {
    const delegation = await joiner.signJoinRequest(CG, retryAddr);
    const requestGeneration = joiner.getJoinRequestGeneration(delegation);
    const forwarded = await joiner.forwardJoinRequest(
      CG,
      delegation,
      'joiner-retry',
      curator.peerId,
    );
    expect(forwarded.delivered, `forward(retry) result: ${JSON.stringify(forwarded)}`)
      .toBeGreaterThanOrEqual(1);
    await pollUntil(
      () => curator.listPendingJoinRequests(CG),
      (rows) => rows.some((row: any) =>
        String(row.agentAddress).toLowerCase() === retryAddr.toLowerCase()),
    );

    let failMembershipPersistence = true;
    let membershipAttempts = 0;
    let subscriptionWrites = 0;
    let approvedEvents = 0;
    (joiner as any).config.contextGraphMembershipStore = {
      upsert: async (record: any) => {
        if (
          record.source === 'join-approved' &&
          String(record.principalId).toLowerCase() === retryAddr.toLowerCase()
        ) {
          membershipAttempts += 1;
          if (failMembershipPersistence) {
            throw new Error('simulated durable membership failure');
          }
        }
      },
      delete: async () => {},
    };
    (joiner as any).config.contextGraphSubscriptionStore = {
      loadAll: async () => [],
      save: async () => { subscriptionWrites += 1; },
      delete: async () => {},
    };
    const immediateSync = vi.fn(async () => {});
    (joiner as any).runImmediatePostApprovalSync = immediateSync;
    const onApproved = (event: any) => {
      if (String(event?.agentAddress).toLowerCase() === retryAddr.toLowerCase()) {
        approvedEvents += 1;
      }
    };
    (joiner as any).eventBus.on(DKGEvent.JOIN_APPROVED, onApproved);

    try {
      await curator.approveJoinRequest(CG, retryAddr);
      await pollUntil(
        async () => membershipAttempts,
        (attempts) => attempts > 0,
        10_000,
        100,
      );
      expect(approvedEvents).toBe(0);
      expect(immediateSync).not.toHaveBeenCalled();

      const pending = await pollUntil(
        async () => (curator as any).messenger.listOutbox()
          .filter((entry: any) =>
            entry.peer === joiner.peerId && entry.protocol === PROTOCOL_JOIN_REQUEST),
        (entries) => entries.length === 1,
        10_000,
        100,
      );
      expect(pending).toHaveLength(1);
      const entry = pending[0];
      const envelope = decodeReliableEnvelope(entry.payload);
      expect(JSON.parse(new TextDecoder().decode(envelope.payload))).toMatchObject({
        type: 'join-approved',
        contextGraphId: CG,
        agentAddress: retryAddr,
        requestGeneration,
      });
      expect((joiner as any).messenger.idempotencyStore.check(
        curator.peerId,
        PROTOCOL_JOIN_REQUEST,
        envelope.messageId,
        'in',
      ).seen).toBe(false);

      const attemptsBeforeRecovery = membershipAttempts;
      failMembershipPersistence = false;
      await (curator as any).messenger.processOutboxTick(entry.nextAttemptAt);
      await pollUntil(
        async () => (curator as any).messenger.listOutbox()
          .filter((row: any) => row.messageId === envelope.messageId),
        (entries) => entries.length === 0,
        10_000,
        100,
      );

      // ProtocolRouter may make more than one bounded wire attempt before
      // Messenger queues the envelope. The outbox recovery must add exactly
      // one successful application attempt, regardless of that retry count.
      expect(membershipAttempts).toBe(attemptsBeforeRecovery + 1);
      expect(subscriptionWrites).toBeGreaterThan(0);
      expect(approvedEvents).toBe(1);
      expect(immediateSync).toHaveBeenCalledTimes(1);
      expect((joiner as any).messenger.idempotencyStore.check(
        curator.peerId,
        PROTOCOL_JOIN_REQUEST,
        envelope.messageId,
        'in',
      ).seen).toBe(true);

      const attemptsAfterRecovery = membershipAttempts;
      await (curator as any).messenger.processOutboxTick(entry.nextAttemptAt + 60_000);
      expect(membershipAttempts).toBe(attemptsAfterRecovery);
      expect(approvedEvents).toBe(1);
    } finally {
      (joiner as any).eventBus.off(DKGEvent.JOIN_APPROVED, onApproved);
    }
  }, 45_000);
});
