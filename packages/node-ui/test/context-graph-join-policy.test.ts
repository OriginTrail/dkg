import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardDB } from '../src/db.js';

describe('DashboardDB context graph join policy', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function createDb(): { db: DashboardDB; dataDir: string } {
    const dataDir = mkdtempSync(join(tmpdir(), 'dkg-join-policy-'));
    directories.push(dataDir);
    return { db: new DashboardDB({ dataDir }), dataDir };
  }

  it('persists an owner-bound open policy across restart and fails closed on corruption', () => {
    const { db: first, dataDir } = createDb();
    const contextGraphId = '0x1234567890123456789012345678901234567890/private';
    first.setContextGraphJoinPolicy({
      version: 1,
      contextGraphId,
      mode: 'open',
      ownerDid: 'did:dkg:agent:0x1234567890123456789012345678901234567890',
      maxMembers: 100,
      maxApprovalsPerHour: 20,
      updatedAt: 1234,
    });
    first.close();

    const second = new DashboardDB({ dataDir });
    expect(second.getContextGraphJoinPolicy(contextGraphId)).toEqual({
      version: 1,
      contextGraphId,
      mode: 'open',
      ownerDid: 'did:dkg:agent:0x1234567890123456789012345678901234567890',
      maxMembers: 100,
      maxApprovalsPerHour: 20,
      updatedAt: 1234,
    });

    second.db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
      JSON.stringify({ version: 1, mode: 'open', ownerDid: 'attacker' }),
      `contextGraphJoinPolicy:${contextGraphId}`,
    );
    expect(second.getContextGraphJoinPolicy(contextGraphId)).toBeNull();
    second.close();
  });

  it('atomically enforces per-CG and node-wide rolling approval ceilings', () => {
    const { db } = createDb();
    const at = 10_000_000;
    const reserve = (contextGraphId: string, agentAddress: string) =>
      db.reserveContextGraphAutomaticApproval({
        contextGraphId,
        timestamp: at,
        contextGraphLimit: 2,
        nodeLimit: 3,
        actor: 'did:dkg:agent:0x1111111111111111111111111111111111111111',
        agentAddress,
        requestDigest: `digest-${agentAddress}`,
        policyVersion: 1,
        policyEpoch: 100,
      });

    expect(reserve('cg-a', '0x0000000000000000000000000000000000000001')).toMatchObject({ allowed: true });
    expect(reserve('cg-a', '0x0000000000000000000000000000000000000001')).toMatchObject({
      allowed: true,
      contextGraphApprovalsLastHour: 1,
      nodeApprovalsLastHour: 1,
    });
    expect(reserve('cg-a', '0x0000000000000000000000000000000000000002')).toMatchObject({
      allowed: true,
      contextGraphApprovalsLastHour: 2,
    });
    expect(reserve('cg-a', '0x0000000000000000000000000000000000000003')).toMatchObject({
      allowed: false,
      reason: 'context-graph-rate-limit',
    });
    expect(reserve('cg-b', '0x0000000000000000000000000000000000000004')).toMatchObject({
      allowed: true,
      nodeApprovalsLastHour: 3,
    });
    expect(reserve('cg-b', '0x0000000000000000000000000000000000000005')).toMatchObject({
      allowed: false,
      reason: 'node-rate-limit',
    });

    expect(db.getContextGraphAutomaticApprovalUsage('cg-a', at)).toEqual({
      contextGraphApprovalsLastHour: 2,
      nodeApprovalsLastHour: 3,
    });

    expect(db.listContextGraphJoinPolicyAudit('cg-a')).toHaveLength(2);
    expect(db.listContextGraphJoinPolicyAudit('cg-b')).toHaveLength(1);
    db.close();
  });

  it('stores redacted audit metadata without raw credentials', () => {
    const { db } = createDb();
    db.appendContextGraphJoinPolicyAudit({
      timestamp: 42,
      contextGraphId: 'cg-audit',
      eventType: 'join_admission_committed',
      actor: 'did:dkg:agent:owner',
      agentAddress: '0x0000000000000000000000000000000000000001',
      outcome: 'approved',
      requestDigest: 'sha256-only',
      policyVersion: 1,
      details: { maxMembers: 10 },
    });

    const [row] = db.listContextGraphJoinPolicyAudit('cg-audit');
    expect(row.request_digest).toBe('sha256-only');
    expect(JSON.stringify(row)).not.toContain('signature');
    db.close();
  });

  it('durably commits only reserved approvals and remains idempotent across restart', () => {
    const { db: first, dataDir } = createDb();
    const contextGraphId = 'cg-durable-commit';
    const timestamp = Date.now();
    const commit = {
      contextGraphId,
      timestamp: timestamp + 1,
      actor: 'did:dkg:agent:caller',
      agentAddress: '0x0000000000000000000000000000000000000002',
      requestDigest: 'reserved-request',
      details: { memberCountBefore: 1, policyEpoch: -1 },
    };

    expect(first.commitContextGraphAutomaticApproval(commit)).toBe(false);
    expect(first.reserveContextGraphAutomaticApproval({
      contextGraphId,
      timestamp,
      contextGraphLimit: 5,
      nodeLimit: 10,
      actor: 'did:dkg:agent:curator',
      agentAddress: '0x0000000000000000000000000000000000000001',
      requestDigest: commit.requestDigest,
      policyVersion: 1,
      policyEpoch: 1234,
    })).toMatchObject({ allowed: true });
    expect(first.commitContextGraphAutomaticApproval(commit)).toBe(true);
    expect(first.commitContextGraphAutomaticApproval({
      ...commit,
      timestamp: commit.timestamp + 1,
    })).toBe(true);

    const firstRows = first.listContextGraphJoinPolicyAudit(contextGraphId);
    const firstCommitted = firstRows.filter((row) => row.event_type === 'join_admission_committed');
    expect(firstCommitted).toHaveLength(1);
    expect(firstCommitted[0]).toMatchObject({
      actor: 'did:dkg:agent:curator',
      agent_address: '0x0000000000000000000000000000000000000001',
      request_digest: commit.requestDigest,
      policy_version: 1,
    });
    expect(JSON.parse(firstCommitted[0].details as string)).toMatchObject({
      memberCountBefore: 1,
      policyEpoch: 1234,
    });
    first.close();

    const second = new DashboardDB({ dataDir });
    expect(second.commitContextGraphAutomaticApproval({
      ...commit,
      timestamp: commit.timestamp + 2,
    })).toBe(true);
    expect(second.listContextGraphJoinPolicyAudit(contextGraphId).filter(
      (row) => row.event_type === 'join_admission_committed',
    )).toHaveLength(1);
    expect(second.commitContextGraphAutomaticApproval({
      ...commit,
      requestDigest: 'not-reserved',
    })).toBe(false);
    second.close();
  });

  it('rolls back a policy transition when its audit insert fails', () => {
    const { db } = createDb();
    const contextGraphId = 'cg-atomic-policy';
    db.db.exec(`
      CREATE TRIGGER fail_join_policy_audit
      BEFORE INSERT ON context_graph_join_policy_audit
      BEGIN
        SELECT RAISE(ABORT, 'audit unavailable');
      END;
    `);

    expect(() => db.setContextGraphJoinPolicyWithAudit({
      version: 1,
      contextGraphId,
      mode: 'open',
      ownerDid: 'did:dkg:agent:0x1111111111111111111111111111111111111111',
      maxMembers: 10,
      maxApprovalsPerHour: 2,
      updatedAt: 100,
    }, {
      timestamp: 100,
      contextGraphId,
      eventType: 'join_policy_changed',
      outcome: 'open',
    })).toThrow(/audit unavailable/i);
    expect(db.getContextGraphJoinPolicy(contextGraphId)).toBeNull();
    db.close();
  });

  it('time-prunes policy audit rows and installs a hard row-cap trigger', () => {
    const { db } = createDb();
    db.appendContextGraphJoinPolicyAudit({
      timestamp: 1,
      contextGraphId: 'cg-old-audit',
      eventType: 'join_auto_decision',
      outcome: 'pending',
    });
    db.appendContextGraphJoinPolicyAudit({
      timestamp: Date.now(),
      contextGraphId: 'cg-new-audit',
      eventType: 'join_auto_decision',
      outcome: 'pending',
    });

    db.prune();
    expect(db.listContextGraphJoinPolicyAudit('cg-old-audit')).toHaveLength(0);
    expect(db.listContextGraphJoinPolicyAudit('cg-new-audit')).toHaveLength(1);
    expect(db.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name = 'cap_cg_join_policy_audit_rows'
    `).get()).toEqual({ name: 'cap_cg_join_policy_audit_rows' });
    db.close();
  });

  it('never evicts a live approval reservation while volume-capping audit rows', () => {
    const { db } = createDb();
    const now = Date.now();
    const first = db.reserveContextGraphAutomaticApproval({
      contextGraphId: 'cg-reservation-cap',
      timestamp: now,
      contextGraphLimit: 1,
      nodeLimit: 100,
      actor: 'did:dkg:agent:owner',
      agentAddress: '0x0000000000000000000000000000000000000001',
      requestDigest: 'first-request',
      policyVersion: 1,
      policyEpoch: 100,
    });
    expect(first.allowed).toBe(true);

    // Jump the autoincrement sequence so one ordinary audit insert exercises
    // the 100k-row trigger boundary without creating 100k test records.
    db.db.prepare(`UPDATE sqlite_sequence SET seq = 100001 WHERE name = ?`)
      .run('context_graph_join_policy_audit');
    db.appendContextGraphJoinPolicyAudit({
      timestamp: now,
      contextGraphId: 'cg-noise',
      eventType: 'join_auto_decision',
      outcome: 'pending',
    });

    expect(db.reserveContextGraphAutomaticApproval({
      contextGraphId: 'cg-reservation-cap',
      timestamp: now + 1,
      contextGraphLimit: 1,
      nodeLimit: 100,
      actor: 'did:dkg:agent:owner',
      agentAddress: '0x0000000000000000000000000000000000000002',
      requestDigest: 'second-request',
      policyVersion: 1,
      policyEpoch: 100,
    })).toMatchObject({ allowed: false, reason: 'context-graph-rate-limit' });
    db.close();
  });

  it('does not reuse a reservation after the policy epoch changes', () => {
    const { db } = createDb();
    const input = {
      contextGraphId: 'cg-policy-epoch',
      timestamp: 20_000_000,
      contextGraphLimit: 1,
      nodeLimit: 100,
      actor: 'did:dkg:agent:owner',
      agentAddress: '0x0000000000000000000000000000000000000001',
      requestDigest: 'same-signed-request',
      policyVersion: 1,
    };
    expect(db.reserveContextGraphAutomaticApproval({
      ...input,
      policyEpoch: 100,
    })).toMatchObject({ allowed: true });
    expect(db.reserveContextGraphAutomaticApproval({
      ...input,
      policyEpoch: 101,
    })).toMatchObject({
      allowed: false,
      reason: 'context-graph-rate-limit',
    });
    db.close();
  });
});
