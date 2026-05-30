/**
 * Pure scoping / digest-collapse / badge logic for the redesigned
 * notifications pane (A4, notifications-pane redesign). Daemon-agnostic and
 * fully unit-testable: the daemon route resolves caller membership + the
 * authoritative pending-join set (which require `agent`), then hands the raw
 * rows + that resolved context here to produce the frozen §3 wire response.
 *
 * Wire contract (plan §3, frozen):
 *   GET /api/notifications → { notifications: NotifWire[]; badgeCount; scopeUnknown? }
 *   NotifWire is discriminated on `type`:
 *     join_request | join_approved | join_rejected  (id:number)
 *     assertion_activity (id:string digestKey, collapsed)
 *
 * Rules implemented here:
 *   - FAIL CLOSED: caller identity unresolved → empty list, badge 0,
 *     scopeUnknown:true (client renders "Verifying access…", never "all
 *     caught up").
 *   - Type allowlist: only join_request / join_approved / join_rejected /
 *     assertion_activity reach the pane (legacy noise + stray types dropped).
 *   - Membership scope: every row must be in the caller's member-CG set.
 *   - join_request narrowing (curated-only) + reconcile (G3): a join_request
 *     survives only if its CG is in the curated set AND its (cg, agent) is
 *     still in the authoritative pending set. Also dedups to one row per
 *     (cg, agent), keeping the newest.
 *   - Activity digest collapse: assertion_activity rows group by
 *     (contextGraphId, kind, windowBucket). The caller's OWN activity is
 *     INCLUDED (operators want visibility into their own agents) — a sole-self
 *     digest is flagged `bySelf` so the client renders a "You" indicator.
 *     `soleAuthor` + `actorAgentDid` are set only when exactly one OTHER
 *     author dominates the digest.
 *   - badgeCount = unread join_request + join_approved + assertion_activity
 *     digests; EXCLUDES join_rejected.
 */

import {
  ASSERTION_ACTIVITY_TYPE,
  buildActivityDigestKey,
  ACTIVITY_DIGEST_WINDOW_MS,
  type NotificationRow,
  type AssertionActivityKind,
} from './db.js';

const JOIN_TYPES = new Set(['join_request', 'join_approved', 'join_rejected']);
const PANE_TYPES = new Set([...JOIN_TYPES, ASSERTION_ACTIVITY_TYPE]);

export type NotifWire =
  | {
      type: 'join_request';
      id: number;
      ts: number;
      read: 0 | 1;
      contextGraphId: string;
      meta: { contextGraphName?: string; agentAddress: string; agentName?: string };
    }
  | {
      type: 'join_approved';
      id: number;
      ts: number;
      read: 0 | 1;
      contextGraphId: string;
      meta: { contextGraphName?: string; agentAddress: string };
    }
  | {
      type: 'join_rejected';
      id: number;
      ts: number;
      read: 0 | 1;
      contextGraphId: string;
      meta: { contextGraphName?: string; agentAddress: string };
    }
  | {
      type: 'assertion_activity';
      id: string;
      ts: number;
      read: 0 | 1;
      contextGraphId: string;
      meta: {
        contextGraphName?: string;
        kind: AssertionActivityKind;
        count: number;
        actorAgentDid?: string;
        actorAgentName?: string;
        soleAuthor?: boolean;
        /** True when the sole author is the reading agent → render "You". */
        bySelf?: boolean;
      };
    };

export interface ScopedNotificationsResult {
  notifications: NotifWire[];
  badgeCount: number;
  scopeUnknown?: boolean;
}

export interface NotificationScopeContext {
  /** False when the request token did not resolve to an agent → fail closed. */
  callerResolved: boolean;
  /** CGs the caller is involved in (curator OR allowlisted participant). */
  memberCgIds: Set<string>;
  /** Subset of member CGs the caller curates (gates incoming join requests). */
  curatedCgIds: Set<string>;
  /**
   * Authoritative pending join set per curated CG: cg → set of lowercased
   * requester agent addresses still `status==='pending'`. A join_request row
   * not present here was resolved (approved/denied) and is dropped (G3).
   */
  pendingByGraph: Map<string, Set<string>>;
  /** The reading agent's DID (`did:dkg:agent:…`) for activity self-suppression. */
  selfAgentDid?: string;
  /** Optional cgId → display name resolution. */
  contextGraphNames?: Map<string, string>;
  /** Optional agentDid → display name resolution (activity sole-author chip). */
  agentNames?: Map<string, string>;
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function lower(addr: string): string {
  return addr.toLowerCase();
}

interface ActivityAccumulator {
  contextGraphId: string;
  kind: AssertionActivityKind;
  windowBucket: number;
  maxTs: number;
  read: 0 | 1;
  count: number;
  /** Distinct non-self author DIDs seen, → kept for sole-author detection. */
  authors: Set<string>;
  lastAuthor?: string;
}

/**
 * Collapse raw rows into the scoped, typed, digest-collapsed wire response.
 * Pure: no I/O. The caller supplies already-resolved membership + pending
 * context (see `NotificationScopeContext`).
 */
export function scopeNotifications(
  rows: NotificationRow[],
  ctx: NotificationScopeContext,
): ScopedNotificationsResult {
  // Fail closed — never claim "all caught up" when we couldn't compute scope.
  if (!ctx.callerResolved) {
    return { notifications: [], badgeCount: 0, scopeUnknown: true };
  }

  const selfDid = ctx.selfAgentDid?.toLowerCase();
  // The caller's bare EVM address, used to scope their OWN join confirmations
  // (join_approved/join_rejected), which are NOT CG-membership-scoped — see the
  // confirmation branch below (R3-1).
  const SELF_DID_PREFIX = 'did:dkg:agent:';
  const callerAddr = selfDid
    ? (selfDid.startsWith(SELF_DID_PREFIX) ? selfDid.slice(SELF_DID_PREFIX.length) : selfDid)
    : undefined;
  const nameOf = (cgId: string): string | undefined => ctx.contextGraphNames?.get(cgId);
  const agentNameOf = (did: string): string | undefined => ctx.agentNames?.get(did);

  const joinWire: NotifWire[] = [];
  // Dedup join_request to one row per (cg, agentAddress) — keep newest.
  const seenJoinRequest = new Map<string, number>(); // key → index in joinWire
  const activity = new Map<string, ActivityAccumulator>(); // digestKey → acc

  for (const row of rows) {
    if (!PANE_TYPES.has(row.type)) continue;
    const cgId = row.context_graph_id ?? undefined;
    if (!cgId) continue;
    const meta = parseMeta(row.meta);
    const read = (row.read ? 1 : 0) as 0 | 1;

    if (row.type === ASSERTION_ACTIVITY_TYPE) {
      // Activity is scoped to the caller's member CGs.
      if (!ctx.memberCgIds.has(cgId)) continue;
      const kind = meta.kind as AssertionActivityKind | undefined;
      if (kind !== 'created' && kind !== 'promoted' && kind !== 'published') continue;
      const actorDid = asString(meta.actorAgentDid);
      // The reading agent's OWN activity is intentionally NOT suppressed —
      // operators want visibility into what their own agents have done. It is
      // shown with a "You" indicator (bySelf, derived per digest below) and
      // counts toward the badge like any other activity.
      const digestKey = buildActivityDigestKey(cgId, kind, row.ts);
      const windowBucket = Math.floor(row.ts / ACTIVITY_DIGEST_WINDOW_MS);
      let acc = activity.get(digestKey);
      if (!acc) {
        acc = {
          contextGraphId: cgId,
          kind,
          windowBucket,
          maxTs: row.ts,
          read,
          count: 0,
          authors: new Set(),
        };
        activity.set(digestKey, acc);
      }
      acc.count += 1;
      acc.maxTs = Math.max(acc.maxTs, row.ts);
      // A digest is unread if ANY of its rows is unread.
      if (read === 0) acc.read = 0;
      if (actorDid) {
        acc.authors.add(actorDid);
        acc.lastAuthor = actorDid;
      }
      continue;
    }

    // Join family (numeric id, no collapse).
    const agentAddress = asString(meta.agentAddress);
    if (!agentAddress) continue;

    if (row.type === 'join_request') {
      // Curated-only + reconcile against the authoritative pending set (G3).
      if (!ctx.curatedCgIds.has(cgId)) continue;
      const pending = ctx.pendingByGraph.get(cgId);
      if (!pending || !pending.has(lower(agentAddress))) continue;
      const dedupKey = `${cgId}::${lower(agentAddress)}`;
      const wire: NotifWire = {
        type: 'join_request',
        id: row.id,
        ts: row.ts,
        read,
        contextGraphId: cgId,
        meta: {
          ...(nameOf(cgId) ? { contextGraphName: nameOf(cgId) } : {}),
          agentAddress,
          ...(asString(meta.agentName) ? { agentName: asString(meta.agentName) } : {}),
        },
      };
      const existingIdx = seenJoinRequest.get(dedupKey);
      if (existingIdx === undefined) {
        seenJoinRequest.set(dedupKey, joinWire.length);
        joinWire.push(wire);
      } else if (joinWire[existingIdx].ts < row.ts) {
        joinWire[existingIdx] = wire; // keep newest
      }
      continue;
    }

    // join_approved / join_rejected — the caller's OWN outbound-request
    // confirmation. NOT CG-membership-scoped: a rejected requester is, by
    // definition, no longer a member of that CG, so a membership gate would
    // drop every rejection (R3-1). These rows are emitted only on the
    // requester's node; scope by "belongs to the reading agent"
    // (meta.agentAddress === caller) instead, and fail closed if the caller
    // address is unknown.
    if (!callerAddr || lower(agentAddress) !== callerAddr) continue;
    joinWire.push({
      type: row.type,
      id: row.id,
      ts: row.ts,
      read,
      contextGraphId: cgId,
      meta: {
        ...(nameOf(cgId) ? { contextGraphName: nameOf(cgId) } : {}),
        agentAddress,
      },
    } as NotifWire);
  }

  // Materialise activity digests.
  const activityWire: NotifWire[] = [];
  for (const [digestKey, acc] of activity) {
    if (acc.count <= 0) continue;
    const soleAuthor = acc.authors.size === 1;
    // Sole author is the reading agent → flag bySelf so the client renders a
    // "You" indicator instead of a DID/name. Carry actorAgentDid/Name only for
    // a sole OTHER author.
    const bySelf = soleAuthor && !!selfDid && acc.lastAuthor?.toLowerCase() === selfDid;
    const actorDid = soleAuthor && !bySelf ? acc.lastAuthor : undefined;
    activityWire.push({
      type: 'assertion_activity',
      id: digestKey,
      ts: acc.maxTs,
      read: acc.read,
      contextGraphId: acc.contextGraphId,
      meta: {
        ...(nameOf(acc.contextGraphId) ? { contextGraphName: nameOf(acc.contextGraphId) } : {}),
        kind: acc.kind,
        count: acc.count,
        ...(actorDid ? { actorAgentDid: actorDid } : {}),
        ...(actorDid && agentNameOf(actorDid) ? { actorAgentName: agentNameOf(actorDid) } : {}),
        soleAuthor,
        ...(bySelf ? { bySelf: true } : {}),
      },
    });
  }

  const notifications = [...joinWire, ...activityWire].sort((a, b) => b.ts - a.ts);

  // badgeCount = unread join_request + join_approved + activity digests.
  // join_rejected NEVER counts toward the badge (ux §2.4).
  let badgeCount = 0;
  for (const n of notifications) {
    if (n.read === 1) continue;
    if (n.type === 'join_rejected') continue;
    badgeCount += 1;
  }

  return { notifications, badgeCount };
}
