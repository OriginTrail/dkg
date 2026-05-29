// daemon/routes/notifications.ts
//
// Scoped notifications-pane routes (A4, ADR-003). These live daemon-side
// — NOT in node-ui's `handleNodeUIRequest` — because scoping needs the
// caller identity + `agent.listContextGraphs` / `agent.listPendingJoinRequests`,
// none of which node-ui's handler has. The heavy filtering/digest/badge logic
// is the pure, unit-tested `scopeNotifications` from node-ui; this handler is
// the thin agent-aware adapter that resolves membership + pending state and
// calls it.
//
//   GET  /api/notifications        → scoped { notifications, badgeCount, scopeUnknown? }
//   POST /api/notifications/read   → mark ids + digestKeys read

import { scopeNotifications, type NotificationScopeContext } from '@origintrail-official/dkg-node-ui';
import { jsonResponse, readBody, SMALL_BODY_BYTES } from '../http-utils.js';
import type { RequestContext } from './context.js';

const AGENT_DID_PREFIX = 'did:dkg:agent:';
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Lowercased EVM address from a `did:dkg:agent:0x…` DID or a bare address. */
function addressFromAgentDid(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  let t = value.trim();
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
  if (t.startsWith(AGENT_DID_PREFIX)) t = t.slice(AGENT_DID_PREFIX.length);
  return EVM_ADDRESS_RE.test(t) ? t.toLowerCase() : undefined;
}

/**
 * How many raw rows to pull before scoping. The scoped/collapsed result is
 * capped client-side; we read a generous window so the digest collapse counts
 * are correct across the page (the unscoped table also still contains legacy
 * noise rows that the scope filter drops, so we read more than the visible
 * cap). prune() bounds the table, so this stays bounded in practice.
 */
const RAW_READ_LIMIT = 500;

export async function handleNotificationRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, dashDb, requestAgentAddress, path } = ctx;

  // GET /api/notifications — scoped to the caller's member CGs.
  if (req.method === 'GET' && path === '/api/notifications') {
    const callerAddress = addressFromAgentDid(requestAgentAddress)
      ?? (EVM_ADDRESS_RE.test(requestAgentAddress) ? requestAgentAddress.toLowerCase() : undefined);

    // Fail closed: no usable wallet identity → the pure fn returns
    // scopeUnknown:true (client renders "Verifying access…", not "all
    // caught up"). We still short-circuit here to avoid the membership
    // queries when there's nothing to scope against.
    if (!callerAddress) {
      return jsonResponse(res, 200, { notifications: [], badgeCount: 0, scopeUnknown: true });
    }

    try {
      const cgs = await agent.listContextGraphs({ callerAgentAddress: callerAddress });
      const memberCgIds = new Set<string>();
      const curatedCgIds = new Set<string>();
      const contextGraphNames = new Map<string, string>();
      for (const cg of cgs) {
        if (typeof cg.id !== 'string' || cg.id.length === 0) continue;
        if (cg.callerInvolved !== true) continue;
        memberCgIds.add(cg.id);
        if (typeof cg.name === 'string' && cg.name.length > 0) contextGraphNames.set(cg.id, cg.name);
        // Curated = the caller is the CG's curator (gates incoming join requests).
        if (addressFromAgentDid(cg.curator) === callerAddress) curatedCgIds.add(cg.id);
      }

      // Authoritative pending-join set per curated CG (G3 reconcile). Only
      // queried for curated CGs — that's the only place join_request rows
      // are actionable.
      const pendingByGraph = new Map<string, Set<string>>();
      await Promise.all(
        [...curatedCgIds].map(async (cgId) => {
          try {
            const pending = await agent.listPendingJoinRequests(cgId);
            pendingByGraph.set(
              cgId,
              new Set(pending.map((r) => r.agentAddress.toLowerCase())),
            );
          } catch {
            // A per-CG pending lookup failure must not blank the whole feed;
            // treat as "no pending" so stale join_request rows are dropped
            // (fail closed on the actionable set, not the whole pane).
            pendingByGraph.set(cgId, new Set());
          }
        }),
      );

      const { notifications } = dashDb.getNotifications({ limit: RAW_READ_LIMIT });
      const scopeCtx: NotificationScopeContext = {
        callerResolved: true,
        memberCgIds,
        curatedCgIds,
        pendingByGraph,
        selfAgentDid: `${AGENT_DID_PREFIX}${callerAddress}`,
        contextGraphNames,
      };
      return jsonResponse(res, 200, scopeNotifications(notifications, scopeCtx));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 500, { error: `Failed to load notifications: ${message}` });
    }
  }

  // POST /api/notifications/read — mark numeric ids AND/OR activity digestKeys
  // read. A digestKey resolves (via the A1 helper) to its underlying atomic
  // assertion_activity row ids. Empty body / no ids → mark all read (legacy
  // "Mark all read" behaviour preserved).
  if (req.method === 'POST' && path === '/api/notifications/read') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    let rawIds: unknown;
    try {
      rawIds = body ? (JSON.parse(body) as { ids?: unknown }).ids : undefined;
    } catch {
      rawIds = undefined;
    }

    if (rawIds === undefined) {
      // No ids supplied → mark everything read.
      const count = dashDb.markNotificationsRead();
      return jsonResponse(res, 200, { marked: count });
    }
    if (!Array.isArray(rawIds)) {
      return jsonResponse(res, 400, { error: '"ids" must be an array of numeric ids and/or digest keys' });
    }

    // Partition into numeric row ids and string digestKeys. digestKeys expand
    // to their underlying atomic row ids; numeric ids pass through.
    const numericIds = new Set<number>();
    for (const entry of rawIds) {
      if (typeof entry === 'number' && Number.isInteger(entry)) {
        numericIds.add(entry);
      } else if (typeof entry === 'string') {
        const n = Number(entry);
        if (Number.isInteger(n) && /^\d+$/.test(entry)) {
          numericIds.add(n); // numeric id sent as a string
        } else {
          for (const rowId of dashDb.resolveActivityDigestRowIds(entry)) numericIds.add(rowId);
        }
      }
    }

    if (numericIds.size === 0) {
      return jsonResponse(res, 200, { marked: 0 });
    }
    const count = dashDb.markNotificationsRead([...numericIds]);
    return jsonResponse(res, 200, { marked: count });
  }
}
