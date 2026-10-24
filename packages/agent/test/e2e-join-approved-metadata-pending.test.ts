/**
 * E2E (#3421): a member whose join the curator approved, but whose metadata
 * fetches from the curator keep failing, as they do over a relayed connection
 * that closes within a fraction of a second.
 *
 * Two real agents over real libp2p on the shared Hardhat chain. The member's
 * metadata fetches from the curator fail until the scenario lets them through.
 * Before the fix:
 *   - the member's share failed as fatal ("no local allowed signing agent
 *     key") and was lost, although the curator had approved the member;
 *   - the member's next join request reopened the approval: the curator stored
 *     a new pending request for its approver.
 * Now the share is refused as a retryable wait and succeeds when it is tried
 * again after the member list arrives, and a repeated join request is answered
 * from the approval the member holds.
 */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import {
  RealChainAgents,
  dialableAddress,
  pollUntil,
  sleep,
} from './_helpers/real-chain-agent.js';
import type { DKGAgent } from '../src/index.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import {
  takeSnapshot,
  revertSnapshot,
  HARDHAT_KEYS,
} from '../../chain/test/evm-test-context.js';

const NAME = 'http://schema.org/name';
const MEMBER_ENTITY = 'urn:dkg:e2e-3421:member-share';

type FetchSyncPages = (
  ctx: unknown,
  remotePeerId: string,
  contextGraphId: string,
  includeSharedMemory: boolean,
  phase: string,
  ...rest: unknown[]
) => Promise<SyncPageResult>;

let fileSnapshot: string;
beforeAll(async () => {
  fileSnapshot = await takeSnapshot();
});
afterAll(async () => {
  await revertSnapshot(fileSnapshot);
});

async function sharedMemoryNames(agent: DKGAgent, contextGraphId: string, subject: string): Promise<string[]> {
  const result = await agent.query(
    `SELECT ?name WHERE { <${subject}> <${NAME}> ?name }`,
    { contextGraphId, includeSharedMemory: true },
  ).catch(() => ({ bindings: [] as Array<Record<string, unknown>> }));
  return result.bindings.map((row) => String(row['name']));
}

async function allowedAgents(agent: DKGAgent, contextGraphId: string): Promise<string[]> {
  return (await agent.getContextGraphAllowedAgents(contextGraphId).catch(() => []))
    .map((address) => address.toLowerCase());
}

/**
 * Let the member's metadata fetches of `contextGraphId` from `curatorPeerId`
 * fail while `blocked.value` is true; every other fetch runs as it would.
 */
function blockMetadataFetches(member: DKGAgent, curatorPeerId: string, contextGraphId: string) {
  const internals = member as unknown as { fetchSyncPages: FetchSyncPages };
  const original = internals.fetchSyncPages.bind(member);
  const blocked = { value: true, refused: 0 };
  vi.spyOn(internals, 'fetchSyncPages').mockImplementation(async (...args) => {
    const [, remotePeerId, id, , phase] = args;
    if (blocked.value && remotePeerId === curatorPeerId && id === contextGraphId && phase === 'meta') {
      blocked.refused += 1;
      throw new Error('The stream has been reset');
    }
    return original(...args);
  });
  return blocked;
}

describe('E2E: an approved member whose member list is still on its way (#3421)', () => {
  const pool = new RealChainAgents();
  const tempDirs: string[] = [];

  afterAll(async () => {
    vi.restoreAllMocks();
    await pool.stopAll();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** A started agent with a data directory: without one an agent serves no owner-signed policy. */
  async function startNode(name: string, operationalKey: string): Promise<{ agent: DKGAgent; address: string }> {
    const dataDir = await mkdtemp(join(tmpdir(), `dkg-e2e-3421-${name.toLowerCase()}-`));
    tempDirs.push(dataDir);
    const agent = await pool.create({ name, operationalKey, dataDir });
    await agent.start();
    return { agent, address: agent.getDefaultAgentAddress()!.toLowerCase() };
  }

  // One irreversible state machine, so one test: a failing phase stops the
  // scenario instead of cascading into later phases on half-built state.
  it('retries the member\'s share instead of losing it, and does not reopen the approval', async () => {
    const { agent: curator, address: curatorAgent } = await startNode('PendingCurator', HARDHAT_KEYS.CORE_OP);
    const { agent: member, address: memberAgent } = await startNode('PendingMember', HARDHAT_KEYS.EXTRA1);
    expect(memberAgent).not.toBe(curatorAgent);
    await sleep(800);
    await member.connectTo(dialableAddress(curator));
    await sleep(1_500);

    // A public graph whose curator keeps an allowlist of the agents that may
    // write, with one member admitted earlier. Before joining, the member
    // holds the curator's declaration and allowlist, without itself in it.
    const contextGraphId = `${curatorAgent}/approved-metadata-pending-e2e`;
    await curator.createContextGraph({
      id: contextGraphId,
      name: 'Approved, member list pending',
      description: '',
      accessPolicy: 0,
      callerAgentAddress: curatorAgent,
    });
    const earlierMember = ethers.Wallet.createRandom().address.toLowerCase();
    await curator.inviteAgentToContextGraph(contextGraphId, earlierMember, curatorAgent);
    const admission = await member.resolveContextGraphSubscriptionBootstrapAuthority(contextGraphId);
    expect(admission.outcome, JSON.stringify(admission)).toBe('allowed');
    member.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on' });
    await member.reconcileRfc64CatalogResponsibilityV1(contextGraphId);
    expect(await pollUntil(
      async () => member.hasAcceptedRfc64PublicUnregisteredAuthorityV1(contextGraphId),
      (value) => value === true,
      60_000,
      1_000,
    ), 'the member accepted the owner-signed public policy').toBe(true);
    // The refresh a subscriber runs on its own schedule, here at once.
    await member.refreshMetaFromCurator(contextGraphId, { trustedCuratorPeerId: curator.peerId, force: true });
    const heldAllowlist = await pollUntil(
      () => allowedAgents(member, contextGraphId),
      (agents) => agents.includes(earlierMember),
      60_000,
      1_000,
    );
    expect(heldAllowlist, 'the member holds the curator\'s allowlist').toContain(earlierMember);
    expect(heldAllowlist).not.toContain(memberAgent);

    // From here on the curator cannot serve the member its metadata.
    const blocked = blockMetadataFetches(member, curator.peerId, contextGraphId);

    const delegation = await member.signJoinRequest(contextGraphId);
    const forwarded = await member.forwardJoinRequest(contextGraphId, delegation, undefined, curator.peerId);
    expect(forwarded.delivered, JSON.stringify(forwarded)).toBe(1);
    await pollUntil(
      () => curator.listPendingJoinRequests(contextGraphId),
      (rows) => rows.some((row: any) => String(row.agentAddress).toLowerCase() === memberAgent),
      30_000,
      500,
    );
    await curator.approveJoinRequest(contextGraphId, memberAgent, curatorAgent);
    expect(await pollUntil(
      () => member.readRequesterJoinRequestState(contextGraphId, memberAgent),
      (state) => state?.status === 'approved',
      30_000,
      500,
    )).toMatchObject({ status: 'approved' });
    const approved = await member.readRequesterJoinRequestState(contextGraphId, memberAgent);
    await pollUntil(async () => blocked.refused, (refused) => refused > 0, 30_000, 250);

    // The approval is pending, not missing: the listing says so.
    const [pendingRow] = (await member.listContextGraphs({ callerAgentAddress: memberAgent }))
      .filter((row) => row.id === contextGraphId);
    expect(pendingRow).toMatchObject({ callerInvolved: false, joinState: 'approved-metadata-pending' });

    // A share is refused as a retryable wait, not lost as a fatal refusal.
    const assertionName = 'member-share';
    await member.assertion.create(contextGraphId, assertionName);
    await member.assertion.write(contextGraphId, assertionName, [
      { subject: MEMBER_ENTITY, predicate: NAME, object: '"Member share"' },
    ]);
    const refusal = await member.assertion.promote(contextGraphId, assertionName)
      .then(() => undefined, (error: unknown) => error);
    expect((refusal as { code?: string } | undefined)?.code, String(refusal)).toBe('PROMOTE_RETRYABLE_FAILURE');
    expect((refusal as { cause?: { reason?: string } }).cause?.reason).toBe('approved-member-metadata-pending');

    // A repeated join request is answered from the approval the member holds:
    // nothing reaches the curator, and its approver is not asked again.
    await sleep(5);
    const repeat = await member.forwardJoinRequest(
      contextGraphId,
      await member.signJoinRequest(contextGraphId),
      undefined,
      curator.peerId,
    );
    expect(repeat).toMatchObject({ delivered: 0, alreadyMember: true, approvedMetadataPending: true });
    await expect(member.readRequesterJoinRequestState(contextGraphId, memberAgent)).resolves.toEqual(approved);
    await sleep(1_000);
    expect((await curator.listPendingJoinRequests(contextGraphId))
      .filter((row: any) => String(row.agentAddress).toLowerCase() === memberAgent)).toEqual([]);

    // The curator becomes reachable. Asking again brings the member's next
    // metadata fetch forward; the member list arrives.
    blocked.value = false;
    await member.forwardJoinRequest(contextGraphId, await member.signJoinRequest(contextGraphId), undefined, curator.peerId);
    expect(await pollUntil(
      () => allowedAgents(member, contextGraphId),
      (agents) => agents.includes(memberAgent),
      90_000,
      1_000,
    ), 'the member list names the member').toContain(memberAgent);
    const [joinedRow] = (await pollUntil(
      () => member.listContextGraphs({ callerAgentAddress: memberAgent }),
      (rows) => rows.some((row) => row.id === contextGraphId && row.callerInvolved === true),
      30_000,
      1_000,
    )).filter((row) => row.id === contextGraphId);
    expect(joinedRow).toMatchObject({ callerInvolved: true });
    expect(joinedRow).not.toHaveProperty('joinState');

    // The same share, tried again, reaches the curator.
    await member.assertion.promote(contextGraphId, assertionName);
    const names = await pollUntil(
      () => sharedMemoryNames(curator, contextGraphId, MEMBER_ENTITY),
      (values) => values.length > 0,
      150_000,
      2_000,
    );
    expect(names.some((name) => name.includes('Member share'))).toBe(true);
  }, 600_000);
});
