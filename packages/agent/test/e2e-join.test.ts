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
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { DKGAgent } from '../src/index.js';
import type { ContextGraphSubscriptionRecord } from '../src/index.js';
import { contextGraphDataGraphUri } from '@origintrail-official/dkg-core';
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
  let preapprovedAddr: string;
  const joinerPersistedSubscriptions = new Map<string, ContextGraphSubscriptionRecord>();

  afterAll(async () => {
    try { await curator?.stop(); } catch { /* ignore */ }
    try { await joiner?.stop(); } catch { /* ignore */ }
  });

  it('boots two real agents, connects them over libp2p, and registers the requesting agents', async () => {
    curator = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'Curator',
      listenPort: 0,
      skills: [],
      chainAdapter: sharedChain,
      nodeRole: 'core',
    });
    joiner = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'Joiner',
      listenPort: 0,
      skills: [],
      chainAdapter: sharedChain,
      nodeRole: 'edge',
      contextGraphSubscriptionStore: {
        loadAll: async () => [...joinerPersistedSubscriptions.values()],
        save: async (record) => { joinerPersistedSubscriptions.set(record.id, { ...record }); },
        delete: async (id) => { joinerPersistedSubscriptions.delete(id); },
      },
    });

    await curator.start();
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
    const recPreapproved = await joiner.registerAgent('joiner-preapproved', { framework: 'test' });
    approvedAddr = recApprove.agentAddress;
    rejectedAddr = recReject.agentAddress;
    preapprovedAddr = recPreapproved.agentAddress;
    expect(approvedAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(rejectedAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(preapprovedAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }, 25_000);

  it('the curator owns a CURATED context graph (join-gated)', async () => {
    await curator.createContextGraph({ id: CG, name: 'Curated Join E2E', description: '', accessPolicy: 1 });
    expect(await curator.isCuratorOf(CG), 'curator should curate the CG').toBe(true);
    // The joiner is NOT the curator → its join requests must go over the wire.
    expect(await joiner.isCuratorOf(CG)).toBe(false);
  }, 15_000);

  it('add-agent stays passive until request-join, then already-member approval catches up in the same cycle', async () => {
    const subject = 'urn:dkg:e2e-join:preapproved-catchup';
    await curator.inviteAgentToContextGraph(CG, preapprovedAddr);
    await curator.store.insert([{
      subject,
      predicate: 'http://schema.org/name',
      object: '"Preapproved Catchup"',
      graph: contextGraphDataGraphUri(CG),
    }]);

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
        const data = await joiner.store.query(`
          ASK WHERE {
            GRAPH <${contextGraphDataGraphUri(CG)}> {
              <${subject}> <http://schema.org/name> "Preapproved Catchup" .
            }
          }
        `);
        return {
          subscribed: joiner.getSubscribedContextGraphs().get(CG)?.subscribed === true,
          hasData: data.type === 'boolean' && data.value,
        };
      },
      (state) => state.subscribed && state.hasData,
      30_000,
    );

    expect(caughtUp).toEqual({ subscribed: true, hasData: true });
    expect((joiner as any).gossipRegistered.has(CG)).toBe(true);
    expect((joiner as any).config.syncContextGraphs ?? []).toContain(CG);
    expect(joinerPersistedSubscriptions.get(CG)).toMatchObject({
      subscribed: true,
      syncScoped: true,
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
});
