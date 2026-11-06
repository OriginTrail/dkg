import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DashboardDB } from '@origintrail-official/dkg-node-ui';
import { createContextGraphJoinPolicyStore } from '../src/daemon/join-policy-store.js';

const CONTEXT_GRAPH = 'cg-join-policy-store';
const OWNER = 'did:dkg:agent:0x1234567890123456789012345678901234567890';
const AGENT = '0x0000000000000000000000000000000000000001';

describe('the daemon join policy store', () => {
  let directory: string | undefined;
  let dashboard: DashboardDB | undefined;

  afterEach(async () => {
    dashboard?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    dashboard = undefined;
    directory = undefined;
  });

  async function openStore() {
    directory = await mkdtemp(join(tmpdir(), 'dkg-join-policy-store-'));
    dashboard = new DashboardDB({ dataDir: directory });
    return { store: createContextGraphJoinPolicyStore(dashboard), db: dashboard };
  }

  it('keeps the policy and its audit in the dashboard database', async () => {
    const { store, db } = await openStore();
    const policy = {
      version: 1 as const, contextGraphId: CONTEXT_GRAPH, mode: 'open' as const, ownerDid: OWNER,
      maxMembers: 10, maxApprovalsPerHour: 5, updatedAt: 1_000,
    };

    await store.save(policy);
    expect(await store.load(CONTEXT_GRAPH)).toEqual(policy);
    await store.saveWithAudit({ ...policy, mode: 'manual', updatedAt: 2_000 }, {
      timestamp: 2_000, contextGraphId: CONTEXT_GRAPH, eventType: 'join_policy_changed', outcome: 'manual',
    });
    expect(await store.load(CONTEXT_GRAPH)).toMatchObject({ mode: 'manual', updatedAt: 2_000 });
    await store.appendAudit({
      timestamp: 3_000, contextGraphId: CONTEXT_GRAPH, eventType: 'join_auto_decision', outcome: 'pending', reason: 'manual-policy',
    });
    expect(db.listContextGraphJoinPolicyAudit(CONTEXT_GRAPH).map((row) => row.event_type))
      .toEqual(['join_policy_changed', 'join_auto_decision']);
  });

  it('reserves, releases, repairs and commits automatic approvals in the ledger', async () => {
    const { store } = await openStore();
    const timestamp = 40_000_000;
    const reserve = (requestDigest: string) => store.reserveAutomaticApproval({
      contextGraphId: CONTEXT_GRAPH, timestamp, contextGraphLimit: 5, nodeLimit: 10, actor: OWNER,
      agentAddress: AGENT, requestDigest, policyVersion: 1, policyEpoch: 7,
    });

    expect(await reserve('released')).toMatchObject({ allowed: true });
    expect(await reserve('committed')).toMatchObject({ allowed: true });
    expect(await store.getAutomaticApprovalUsage(CONTEXT_GRAPH, timestamp))
      .toEqual({ contextGraphApprovalsLastHour: 2, nodeApprovalsLastHour: 2 });

    expect(await store.releaseAutomaticApproval?.({
      contextGraphId: CONTEXT_GRAPH, requestDigest: 'released', policyEpoch: 7, timestamp, reason: 'test',
    })).toBe(true);
    expect(await store.getAutomaticApprovalUsage(CONTEXT_GRAPH, timestamp))
      .toEqual({ contextGraphApprovalsLastHour: 1, nodeApprovalsLastHour: 1 });

    expect(await store.markAutomaticApprovalRepairPending({
      contextGraphId: CONTEXT_GRAPH, requestDigest: 'committed', policyEpoch: 7,
    })).toBe(true);
    expect(await store.getAutomaticApprovalRepair(CONTEXT_GRAPH, 'committed'))
      .toEqual({ policyEpoch: 7, actor: OWNER, agentAddress: AGENT });
    expect(await store.commitAutomaticApproval({
      contextGraphId: CONTEXT_GRAPH, timestamp, actor: OWNER, agentAddress: AGENT,
      requestDigest: 'committed', policyEpoch: 7,
    })).toBe(true);
    expect(await store.getAutomaticApprovalRepair(CONTEXT_GRAPH, 'committed')).toBeNull();
  });
});
