import { describe, it, expect } from 'vitest';
import { scopeNotifications, type NotificationScopeContext } from '../src/notifications-scope.js';
import { ACTIVITY_DIGEST_WINDOW_MS, type NotificationRow } from '../src/db.js';

let nextId = 1;
function row(over: Partial<NotificationRow> & Pick<NotificationRow, 'type'>): NotificationRow {
  return {
    id: over.id ?? nextId++,
    ts: over.ts ?? 1_000,
    type: over.type,
    title: over.title ?? 't',
    message: over.message ?? 'm',
    source: over.source ?? null,
    peer: over.peer ?? null,
    read: over.read ?? 0,
    meta: over.meta ?? null,
    context_graph_id: over.context_graph_id ?? null,
  };
}

function activityRow(cgId: string, kind: string, ts: number, actorAgentDid?: string, read = 0): NotificationRow {
  return row({
    type: 'assertion_activity',
    ts,
    read,
    context_graph_id: cgId,
    meta: JSON.stringify({ contextGraphId: cgId, kind, ...(actorAgentDid ? { actorAgentDid } : {}) }),
  });
}

function joinRequestRow(cgId: string, agentAddress: string, ts: number, read = 0, agentName?: string): NotificationRow {
  return row({
    type: 'join_request',
    ts,
    read,
    context_graph_id: cgId,
    meta: JSON.stringify({ contextGraphId: cgId, agentAddress, ...(agentName ? { agentName } : {}) }),
  });
}

function baseCtx(over: Partial<NotificationScopeContext> = {}): NotificationScopeContext {
  return {
    callerResolved: true,
    memberCgIds: new Set(['cg-1']),
    curatedCgIds: new Set(['cg-1']),
    pendingByGraph: new Map(),
    // The reading agent. join_approved/join_rejected confirmations are scoped
    // to this address (they are the caller's own outbound-request resolutions),
    // and activity self-suppression keys off it (R3-1).
    selfAgentDid: 'did:dkg:agent:0xme',
    ...over,
  };
}

describe('scopeNotifications — fail closed', () => {
  it('returns scopeUnknown + empty when caller identity is unresolved', () => {
    const out = scopeNotifications([activityRow('cg-1', 'created', 1000, 'did:dkg:agent:0xother')], baseCtx({ callerResolved: false }));
    expect(out.scopeUnknown).toBe(true);
    expect(out.notifications).toEqual([]);
    expect(out.badgeCount).toBe(0);
  });
});

describe('scopeNotifications — membership + type allowlist', () => {
  it('drops rows for non-member CGs', () => {
    const out = scopeNotifications(
      [activityRow('cg-OTHER', 'created', 1000, 'did:dkg:agent:0xother')],
      baseCtx({ memberCgIds: new Set(['cg-1']) }),
    );
    expect(out.notifications).toHaveLength(0);
  });

  it('drops legacy/noise notification types', () => {
    const out = scopeNotifications(
      [
        row({ type: 'kc_published', context_graph_id: 'cg-1' }),
        row({ type: 'peer_connected', context_graph_id: 'cg-1' }),
        row({ type: 'chat_message', context_graph_id: 'cg-1' }),
      ],
      baseCtx(),
    );
    expect(out.notifications).toHaveLength(0);
  });

  it('drops rows with a null context_graph_id (legacy/global scope)', () => {
    const out = scopeNotifications(
      [row({ type: 'join_approved', context_graph_id: null, meta: JSON.stringify({ agentAddress: '0xabc' }) })],
      baseCtx(),
    );
    expect(out.notifications).toHaveLength(0);
  });
});

describe('scopeNotifications — join_request curated-narrowing + reconcile (G3)', () => {
  it('keeps a pending join_request on a curated CG', () => {
    const out = scopeNotifications(
      [joinRequestRow('cg-1', '0xRequester', 2000, 0, 'Alice')],
      baseCtx({ pendingByGraph: new Map([['cg-1', new Set(['0xrequester'])]]) }),
    );
    expect(out.notifications).toHaveLength(1);
    const n = out.notifications[0];
    expect(n.type).toBe('join_request');
    expect(n.type === 'join_request' && n.meta.agentName).toBe('Alice');
  });

  it('drops a join_request whose CG the caller does NOT curate', () => {
    const out = scopeNotifications(
      [joinRequestRow('cg-1', '0xRequester', 2000)],
      baseCtx({ curatedCgIds: new Set(), pendingByGraph: new Map([['cg-1', new Set(['0xrequester'])]]) }),
    );
    expect(out.notifications).toHaveLength(0);
  });

  it('drops a join_request no longer in the authoritative pending set (already resolved)', () => {
    const out = scopeNotifications(
      [joinRequestRow('cg-1', '0xRequester', 2000)],
      baseCtx({ pendingByGraph: new Map([['cg-1', new Set()]]) }),
    );
    expect(out.notifications).toHaveLength(0);
  });

  it('dedups multiple join_request rows for the same (cg, agent) to the newest', () => {
    const out = scopeNotifications(
      [
        joinRequestRow('cg-1', '0xReq', 1000),
        joinRequestRow('cg-1', '0xReq', 3000),
        joinRequestRow('cg-1', '0xReq', 2000),
      ],
      baseCtx({ pendingByGraph: new Map([['cg-1', new Set(['0xreq'])]]) }),
    );
    expect(out.notifications).toHaveLength(1);
    expect(out.notifications[0].ts).toBe(3000);
  });
});

describe('scopeNotifications — activity digest collapse + self-suppression', () => {
  it('collapses many same-(cg,kind,window) events into one digest with a count', () => {
    const baseTs = 5 * ACTIVITY_DIGEST_WINDOW_MS + 1000;
    const out = scopeNotifications(
      [
        activityRow('cg-1', 'created', baseTs, 'did:dkg:agent:0xother'),
        activityRow('cg-1', 'created', baseTs + 100, 'did:dkg:agent:0xother'),
        activityRow('cg-1', 'created', baseTs + 200, 'did:dkg:agent:0xother'),
      ],
      baseCtx(),
    );
    expect(out.notifications).toHaveLength(1);
    const n = out.notifications[0];
    expect(n.type).toBe('assertion_activity');
    if (n.type === 'assertion_activity') {
      expect(n.meta.count).toBe(3);
      expect(n.meta.kind).toBe('created');
      expect(n.meta.soleAuthor).toBe(true);
      expect(n.meta.actorAgentDid).toBe('did:dkg:agent:0xother');
      expect(n.id).toMatch(/^activity:cg-1:created:\d+$/);
    }
  });

  it('excludes the reading agent OWN events from the count and omits self-only digests', () => {
    const baseTs = 5 * ACTIVITY_DIGEST_WINDOW_MS + 1000;
    const self = 'did:dkg:agent:0xme';
    const out = scopeNotifications(
      [
        activityRow('cg-1', 'created', baseTs, self),
        activityRow('cg-1', 'created', baseTs + 100, self),
      ],
      baseCtx({ selfAgentDid: self }),
    );
    expect(out.notifications).toHaveLength(0); // all-self → omitted
  });

  it('counts only the others when self + others are mixed', () => {
    const baseTs = 5 * ACTIVITY_DIGEST_WINDOW_MS + 1000;
    const self = 'did:dkg:agent:0xme';
    const out = scopeNotifications(
      [
        activityRow('cg-1', 'created', baseTs, self),
        activityRow('cg-1', 'created', baseTs + 100, 'did:dkg:agent:0xother'),
      ],
      baseCtx({ selfAgentDid: self }),
    );
    expect(out.notifications).toHaveLength(1);
    const n = out.notifications[0];
    expect(n.type === 'assertion_activity' && n.meta.count).toBe(1);
    expect(n.type === 'assertion_activity' && n.meta.soleAuthor).toBe(true);
  });

  it('soleAuthor=false and no actorAgentDid when multiple non-self authors', () => {
    const baseTs = 5 * ACTIVITY_DIGEST_WINDOW_MS + 1000;
    const out = scopeNotifications(
      [
        activityRow('cg-1', 'promoted', baseTs, 'did:dkg:agent:0xa'),
        activityRow('cg-1', 'promoted', baseTs + 100, 'did:dkg:agent:0xb'),
      ],
      baseCtx(),
    );
    expect(out.notifications).toHaveLength(1);
    const n = out.notifications[0];
    if (n.type === 'assertion_activity') {
      expect(n.meta.count).toBe(2);
      expect(n.meta.soleAuthor).toBe(false);
      expect(n.meta.actorAgentDid).toBeUndefined();
    }
  });

  it('separates different kinds and different window buckets into distinct digests', () => {
    const b0 = 5 * ACTIVITY_DIGEST_WINDOW_MS + 1000;
    const out = scopeNotifications(
      [
        activityRow('cg-1', 'created', b0, 'did:dkg:agent:0xo'),
        activityRow('cg-1', 'promoted', b0, 'did:dkg:agent:0xo'),
        activityRow('cg-1', 'created', b0 + ACTIVITY_DIGEST_WINDOW_MS, 'did:dkg:agent:0xo'),
      ],
      baseCtx(),
    );
    expect(out.notifications).toHaveLength(3);
  });
});

describe('scopeNotifications — badgeCount', () => {
  it('counts unread join_request + join_approved + activity digests, EXCLUDES join_rejected', () => {
    const baseTs = 5 * ACTIVITY_DIGEST_WINDOW_MS + 1000;
    const out = scopeNotifications(
      [
        joinRequestRow('cg-1', '0xReq', 2000, 0),
        row({ type: 'join_approved', read: 0, context_graph_id: 'cg-1', meta: JSON.stringify({ agentAddress: '0xme' }) }),
        row({ type: 'join_rejected', read: 0, context_graph_id: 'cg-1', meta: JSON.stringify({ agentAddress: '0xme' }) }),
        activityRow('cg-1', 'created', baseTs, 'did:dkg:agent:0xother', 0),
      ],
      baseCtx({ pendingByGraph: new Map([['cg-1', new Set(['0xreq'])]]) }),
    );
    // join_request + join_approved + 1 activity digest = 3; rejection excluded.
    expect(out.badgeCount).toBe(3);
  });

  it('does not count read items', () => {
    const out = scopeNotifications(
      [row({ type: 'join_approved', read: 1, context_graph_id: 'cg-1', meta: JSON.stringify({ agentAddress: '0xme' }) })],
      baseCtx(),
    );
    expect(out.badgeCount).toBe(0);
  });

  it('a digest is unread (counts) if ANY underlying row is unread', () => {
    const baseTs = 5 * ACTIVITY_DIGEST_WINDOW_MS + 1000;
    const out = scopeNotifications(
      [
        activityRow('cg-1', 'created', baseTs, 'did:dkg:agent:0xo', 1),
        activityRow('cg-1', 'created', baseTs + 100, 'did:dkg:agent:0xo', 0),
      ],
      baseCtx(),
    );
    expect(out.notifications).toHaveLength(1);
    expect(out.notifications[0].read).toBe(0);
    expect(out.badgeCount).toBe(1);
  });
});

describe('scopeNotifications — ordering + names', () => {
  it('sorts newest-first across kinds', () => {
    const baseTs = 5 * ACTIVITY_DIGEST_WINDOW_MS + 1000;
    const out = scopeNotifications(
      [
        row({ type: 'join_approved', ts: 1000, context_graph_id: 'cg-1', meta: JSON.stringify({ agentAddress: '0xme' }) }),
        activityRow('cg-1', 'created', baseTs, 'did:dkg:agent:0xo'),
      ],
      baseCtx(),
    );
    expect(out.notifications[0].ts).toBeGreaterThan(out.notifications[1].ts);
  });

  it('resolves contextGraphName + actorAgentName when provided', () => {
    const baseTs = 5 * ACTIVITY_DIGEST_WINDOW_MS + 1000;
    const out = scopeNotifications(
      [activityRow('cg-1', 'created', baseTs, 'did:dkg:agent:0xo')],
      baseCtx({
        contextGraphNames: new Map([['cg-1', 'Acme Research']]),
        agentNames: new Map([['did:dkg:agent:0xo', 'Dana']]),
      }),
    );
    const n = out.notifications[0];
    if (n.type === 'assertion_activity') {
      expect(n.meta.contextGraphName).toBe('Acme Research');
      expect(n.meta.actorAgentName).toBe('Dana');
    }
  });
});

describe('scopeNotifications — join confirmations are caller-scoped, not member-scoped (R3-1)', () => {
  const rejected = (cgId: string, agentAddress: string, read: 0 | 1 = 0): NotificationRow =>
    row({ type: 'join_rejected', ts: 2000, read, context_graph_id: cgId, meta: JSON.stringify({ agentAddress }) });

  it("keeps the caller's own join_rejected even when its CG is NOT a member CG", () => {
    // A rejected requester is removed from the CG, so the CG is never in
    // memberCgIds — yet the rejection confirmation must still reach the pane.
    const out = scopeNotifications(
      [rejected('cg-REJECTED', '0xme')],
      baseCtx({ memberCgIds: new Set(['cg-1']), curatedCgIds: new Set(['cg-1']) }),
    );
    expect(out.notifications).toHaveLength(1);
    expect(out.notifications[0].type).toBe('join_rejected');
    expect(out.badgeCount).toBe(0); // rejection never counts toward the badge
  });

  it('drops a join_rejected addressed to a DIFFERENT agent (multi-agent-node safety)', () => {
    const out = scopeNotifications([rejected('cg-REJECTED', '0xsomeoneelse')], baseCtx());
    expect(out.notifications).toHaveLength(0);
  });

  it("keeps the caller's own join_approved on a non-member CG too (caller-scoped)", () => {
    const out = scopeNotifications(
      [row({ type: 'join_approved', ts: 2000, context_graph_id: 'cg-NOTYET', meta: JSON.stringify({ agentAddress: '0xme' }) })],
      baseCtx({ memberCgIds: new Set(['cg-1']) }),
    );
    expect(out.notifications).toHaveLength(1);
    expect(out.notifications[0].type).toBe('join_approved');
  });

  it('drops confirmations when the caller address is unknown (fail closed)', () => {
    const out = scopeNotifications([rejected('cg-REJECTED', '0xme')], baseCtx({ selfAgentDid: undefined }));
    expect(out.notifications).toHaveLength(0);
  });
});
