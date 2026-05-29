import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardDB, ASSERTION_ACTIVITY_TYPE } from '@origintrail-official/dkg-node-ui';
import {
  recordAssertionActivity,
  toActorAgentDid,
  localNodeInvolvedInContextGraph,
} from '../src/daemon/activity-notification.js';

let db: DashboardDB;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dkg-activity-notif-test-'));
  db = new DashboardDB({ dataDir: dir });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('toActorAgentDid', () => {
  it('wraps a bare EVM address and lowercases it', () => {
    expect(toActorAgentDid('0xAbCdEf0123456789012345678901234567890123'))
      .toBe('did:dkg:agent:0xabcdef0123456789012345678901234567890123');
  });

  it('canonicalises an already-prefixed EVM DID (lowercase address)', () => {
    expect(toActorAgentDid('did:dkg:agent:0xABCDEF0123456789012345678901234567890123'))
      .toBe('did:dkg:agent:0xabcdef0123456789012345678901234567890123');
  });

  it('wraps a peer-id-based actor as an agent DID (case-preserving)', () => {
    expect(toActorAgentDid('12D3KooWExamplePeer'))
      .toBe('did:dkg:agent:12D3KooWExamplePeer');
  });

  it('returns undefined for empty/whitespace/null', () => {
    expect(toActorAgentDid('')).toBeUndefined();
    expect(toActorAgentDid('   ')).toBeUndefined();
    expect(toActorAgentDid(null)).toBeUndefined();
    expect(toActorAgentDid(undefined)).toBeUndefined();
  });
});

describe('recordAssertionActivity', () => {
  it('persists an assertion_activity row with the context_graph_id column + typed meta', () => {
    const id = recordAssertionActivity(db, {
      contextGraphId: 'cg-1',
      kind: 'created',
      actorAgentAddress: '0x1111111111111111111111111111111111111111',
      subGraphName: 'research',
      tripleCount: 7,
    });
    expect(typeof id).toBe('number');

    const { notifications } = db.getNotifications();
    expect(notifications).toHaveLength(1);
    const row = notifications[0];
    expect(row.type).toBe(ASSERTION_ACTIVITY_TYPE);
    expect(row.context_graph_id).toBe('cg-1');
    const meta = JSON.parse(row.meta!);
    expect(meta).toMatchObject({
      contextGraphId: 'cg-1',
      kind: 'created',
      actorAgentDid: 'did:dkg:agent:0x1111111111111111111111111111111111111111',
      subGraph: 'research',
      tripleCount: 7,
    });
  });

  it('omits actorAgentDid when no actor resolves', () => {
    recordAssertionActivity(db, { contextGraphId: 'cg-1', kind: 'promoted' });
    const meta = JSON.parse(db.getNotifications().notifications[0].meta!);
    expect(meta.actorAgentDid).toBeUndefined();
    expect(meta.kind).toBe('promoted');
  });

  it('is a no-op (returns null, writes nothing) for a blank contextGraphId', () => {
    expect(recordAssertionActivity(db, { contextGraphId: '   ', kind: 'published' })).toBeNull();
    expect(db.getNotifications().notifications).toHaveLength(0);
  });

  it('records each lifecycle kind as its own atomic row (digest collapse is a read concern)', () => {
    recordAssertionActivity(db, { contextGraphId: 'cg-1', kind: 'created', actorAgentAddress: '0x1111111111111111111111111111111111111111' });
    recordAssertionActivity(db, { contextGraphId: 'cg-1', kind: 'created', actorAgentAddress: '0x1111111111111111111111111111111111111111' });
    recordAssertionActivity(db, { contextGraphId: 'cg-1', kind: 'promoted', actorAgentAddress: '0x1111111111111111111111111111111111111111' });
    expect(db.getNotifications().notifications).toHaveLength(3);
  });
});

describe('localNodeInvolvedInContextGraph (CR-2 gossip gate)', () => {
  it('true when the CG has an active membership row', () => {
    db.upsertContextGraphMember({
      context_graph_id: 'cg-1',
      principal_type: 'node',
      principal_id: '12D3KooWLocalNode',
      role: 'participant',
      status: 'active',
      source: 'test',
      updated_at: Date.now(),
    });
    expect(localNodeInvolvedInContextGraph(db, 'cg-1')).toBe(true);
  });

  it('false when the only membership row is not active (e.g. removed)', () => {
    db.upsertContextGraphMember({
      context_graph_id: 'cg-2',
      principal_type: 'agent',
      principal_id: '0x2222222222222222222222222222222222222222',
      role: 'requester',
      status: 'removed',
      source: 'join-rejected',
      updated_at: Date.now(),
    });
    expect(localNodeInvolvedInContextGraph(db, 'cg-2')).toBe(false);
  });

  it('false for a CG with no membership rows at all (merely overheard)', () => {
    expect(localNodeInvolvedInContextGraph(db, 'cg-unknown')).toBe(false);
  });

  it('false for a blank contextGraphId', () => {
    expect(localNodeInvolvedInContextGraph(db, '  ')).toBe(false);
  });
});
