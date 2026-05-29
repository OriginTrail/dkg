/**
 * Pure-logic unit tests for the notifications-pane data mapping + interaction
 * logic (B1/B3). Covers the wire→view-model mapping, badge/read semantics,
 * the M8 informational-unread selector (actionable join requests are never
 * cleared by a glance / Mark-all-read), the approve/deny error classification
 * (already-handled / role / transient), and the digest copy. DOM/interaction +
 * a11y glue is covered separately in `notifications-pane.dom.test.ts`
 * (happy-dom).
 */
import { describe, it, expect } from 'vitest';
import {
  mapJoinRequests,
  mapActivity,
  classifyActionError,
  selectInformationalUnreadIds,
  ALREADY_HANDLED_ERROR,
} from '../src/ui/hooks/useNotificationsFeed.js';
import { digestText } from '../src/ui/components/Notifications/rows.js';
import type { NotifWire } from '../src/ui/api.js';

const joinReq = (over: Partial<Extract<NotifWire, { type: 'join_request' }>> = {}): NotifWire => ({
  type: 'join_request',
  id: 1,
  ts: 1000,
  read: 0,
  contextGraphId: 'cg:a',
  meta: { contextGraphName: 'Alpha', agentAddress: '0xabc', agentName: 'Dana' },
  ...over,
});

const activity = (over: Partial<Extract<NotifWire, { type: 'assertion_activity' }>> = {}): NotifWire => ({
  type: 'assertion_activity',
  id: 'activity:cg:a:promoted:1',
  ts: 2000,
  read: 0,
  contextGraphId: 'cg:a',
  meta: { contextGraphName: 'Alpha', kind: 'promoted', count: 3, soleAuthor: true, actorAgentDid: 'did:dkg:agent:0xdana', actorAgentName: 'Dana' },
  ...over,
});

const approved = (over: Partial<Extract<NotifWire, { type: 'join_approved' }>> = {}): NotifWire => ({
  type: 'join_approved',
  id: 2,
  ts: 1500,
  read: 1,
  contextGraphId: 'cg:b',
  meta: { contextGraphName: 'Beta', agentAddress: '0xself' },
  ...over,
});

const rejected = (over: Partial<Extract<NotifWire, { type: 'join_rejected' }>> = {}): NotifWire => ({
  type: 'join_rejected',
  id: 3,
  ts: 1200,
  read: 0,
  contextGraphId: 'cg:c',
  meta: { contextGraphName: 'Gamma', agentAddress: '0xself' },
  ...over,
});

describe('mapJoinRequests', () => {
  it('extracts only join_request rows, newest-first', () => {
    const rows = [activity(), joinReq({ id: 10, ts: 100 }), joinReq({ id: 11, ts: 900 }), approved()];
    const out = mapJoinRequests(rows);
    expect(out.map((r) => r.id)).toEqual([11, 10]);
    expect(out.every((r) => typeof r.id === 'number')).toBe(true);
  });

  it('carries name/address/cg fields through', () => {
    const [r] = mapJoinRequests([joinReq()]);
    expect(r).toMatchObject({ cgId: 'cg:a', contextGraphName: 'Alpha', agentAddress: '0xabc', agentName: 'Dana', read: false });
  });
});

describe('mapActivity', () => {
  it('maps digest + confirmations, newest-first, and drops join_request', () => {
    const out = mapActivity([joinReq(), activity({ ts: 2000 }), approved({ ts: 1500 }), rejected({ ts: 1200 })]);
    expect(out.map((i) => i.kind)).toEqual(['digest', 'join_approved', 'join_rejected']);
  });

  it('keeps the digestKey string id for digests', () => {
    const [d] = mapActivity([activity()]);
    expect(d.kind).toBe('digest');
    expect(d.id).toBe('activity:cg:a:promoted:1');
  });

  it('carries the actor only when soleAuthor is true', () => {
    const [withAuthor] = mapActivity([activity({ meta: { kind: 'created', count: 2, soleAuthor: true, actorAgentDid: 'did:dkg:agent:0xx', actorAgentName: 'Ada' } })]);
    expect(withAuthor.kind === 'digest' && withAuthor.actorAgentName).toBe('Ada');

    const [noAuthor] = mapActivity([activity({ meta: { kind: 'created', count: 5, soleAuthor: false, actorAgentDid: 'did:dkg:agent:0xx', actorAgentName: 'Ada' } })]);
    expect(noAuthor.kind === 'digest' && noAuthor.actorAgentDid).toBeUndefined();
    expect(noAuthor.kind === 'digest' && noAuthor.actorAgentName).toBeUndefined();
  });

  it('reflects read flag as boolean', () => {
    const [unreadDigest] = mapActivity([activity({ read: 0 })]);
    const [readConfirm] = mapActivity([approved({ read: 1 })]);
    expect(unreadDigest.read).toBe(false);
    expect(readConfirm.read).toBe(true);
  });
});

describe('classifyActionError', () => {
  it('treats the daemon "No pending join request found" as already-handled success', () => {
    const r = classifyActionError(new Error(`approve failed: ${ALREADY_HANDLED_ERROR}`));
    expect(r).toEqual({ ok: true, alreadyHandled: true });
  });

  it('flags the owner-assertion error as a role error', () => {
    const r = classifyActionError(new Error('Only the context graph creator can manage invitations'));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.roleError).toBe(true);
  });

  it('flags the reject owner-assertion (G1) variant as a role error', () => {
    const r = classifyActionError(new Error('Only the context graph creator can manage join requests'));
    expect(r.ok === false && r.roleError).toBe(true);
  });

  it('treats a network/transient error as a non-role failure', () => {
    const r = classifyActionError(new Error('HTTP 503'));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.roleError).toBe(false);
  });
});

describe('digestText', () => {
  it('pluralises and names the sole author when present', () => {
    expect(digestText('created', 1)).toBe('1 new assertion added');
    expect(digestText('created', 3)).toBe('3 new assertions added');
    expect(digestText('created', 3, 'Dana')).toBe('Dana added 3 assertions');
    expect(digestText('promoted', 2)).toBe('2 assertions promoted');
    expect(digestText('promoted', 2, 'Dana')).toBe('Dana promoted 2 assertions');
    expect(digestText('published', 1)).toBe('1 assertion published to Verifiable Memory');
    expect(digestText('published', 4, 'Dana')).toBe('Dana published 4 assertions to Verifiable Memory');
  });
});

describe('selectInformationalUnreadIds (M8 — actionable rows never auto-clear)', () => {
  it('NEVER includes join_request ids, even when unread', () => {
    const ids = selectInformationalUnreadIds([
      joinReq({ id: 1, read: 0 }),
      joinReq({ id: 2, read: 0 }),
    ]);
    expect(ids).toEqual([]);
  });

  it('includes unread informational ids (digests + approved + rejected)', () => {
    const ids = selectInformationalUnreadIds([
      activity({ id: 'd1', read: 0 }),
      approved({ id: 10, read: 0 }),
      rejected({ id: 11, read: 0 }),
    ]);
    expect(ids).toEqual(['d1', 10, 11]);
  });

  it('excludes already-read informational rows', () => {
    const ids = selectInformationalUnreadIds([
      activity({ id: 'd1', read: 1 }),
      approved({ id: 10, read: 0 }),
    ]);
    expect(ids).toEqual([10]);
  });

  it('mixed feed → only informational-unread, join_request excluded regardless of read', () => {
    const ids = selectInformationalUnreadIds([
      joinReq({ id: 1, read: 0 }),       // actionable, unread → excluded
      activity({ id: 'd1', read: 0 }),   // informational, unread → in
      approved({ id: 10, read: 1 }),     // informational, read → out
      rejected({ id: 11, read: 0 }),     // informational, unread → in
    ]);
    expect(ids).toEqual(['d1', 11]);
  });

  it('preserves numeric vs string id types (digestKey stays a string)', () => {
    const ids = selectInformationalUnreadIds([
      activity({ id: 'activity:cg:a:promoted:1', read: 0 }),
      approved({ id: 42, read: 0 }),
    ]);
    expect(ids).toEqual(['activity:cg:a:promoted:1', 42]);
    expect(typeof ids[0]).toBe('string');
    expect(typeof ids[1]).toBe('number');
  });
});
