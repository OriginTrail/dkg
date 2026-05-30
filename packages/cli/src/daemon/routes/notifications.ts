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
//   POST /api/notifications/read   → mark ids + digestKeys read (caller-scoped)

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
 * Cap on rows pulled from the SCOPED read. Because the member-CG filter is
 * pushed into SQL (`getNotificationsForContextGraphs`), this only ever reads
 * the caller's own rows — a foreign-CG flood can no longer evict the
 * caller's actionable join requests from the window (Codex round-1 B3).
 */
const SCOPED_READ_LIMIT = 500;

/**
 * Resolve the caller's wallet address from the request token ONLY — no
 * fallback to the node default agent (Codex round-1 B1). `resolveAgentAddress`
 * deliberately falls back to defaultAgentAddress/peerId so unauthenticated
 * loopback callers still "act as" the owner for normal node ops; for
 * notification SCOPING that fallback would hand an anonymous caller the
 * default agent's feed and prevent `scopeUnknown` from ever firing. We bind
 * scope strictly to a token-verified agent and fail closed otherwise. This
 * holds even when `httpAuthGuard` is disabled (loopback owner mode), which is
 * the only path where an anonymous caller reaches dispatch.
 */
function resolveScopedCaller(ctx: RequestContext): string | undefined {
  const fromToken = ctx.requestToken ? ctx.agent.resolveAgentByToken(ctx.requestToken) : undefined;
  return addressFromAgentDid(fromToken)
    ?? (fromToken && EVM_ADDRESS_RE.test(fromToken) ? fromToken.toLowerCase() : undefined);
}

interface CallerScope {
  callerAddress: string;
  memberCgIds: Set<string>;
  curatedCgIds: Set<string>;
  contextGraphNames: Map<string, string>;
}

/** Resolve the caller's member + curated CG sets (+ display names). */
async function resolveCallerScope(ctx: RequestContext, callerAddress: string): Promise<CallerScope> {
  const cgs = await ctx.agent.listContextGraphs({ callerAgentAddress: callerAddress });
  const memberCgIds = new Set<string>();
  const curatedCgIds = new Set<string>();
  const contextGraphNames = new Map<string, string>();
  for (const cg of cgs) {
    if (typeof cg.id !== 'string' || cg.id.length === 0) continue;
    if (cg.callerInvolved !== true) continue;
    memberCgIds.add(cg.id);
    if (typeof cg.name === 'string' && cg.name.length > 0) contextGraphNames.set(cg.id, cg.name);
    if (addressFromAgentDid(cg.curator) === callerAddress) curatedCgIds.add(cg.id);
  }
  return { callerAddress, memberCgIds, curatedCgIds, contextGraphNames };
}

export async function handleNotificationRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, dashDb, path } = ctx;

  // GET /api/notifications — scoped to the caller's member CGs.
  if (req.method === 'GET' && path === '/api/notifications') {
    const callerAddress = resolveScopedCaller(ctx);

    // B1: fail closed when the caller isn't a token-verified wallet agent —
    // the pure fn returns scopeUnknown:true (client renders "Verifying
    // access…", never "all caught up").
    if (!callerAddress) {
      return jsonResponse(res, 200, { notifications: [], badgeCount: 0, scopeUnknown: true });
    }

    try {
      const scope = await resolveCallerScope(ctx, callerAddress);

      // B3: read ONLY the caller's scoped rows (member-CG filter in SQL), so
      // foreign-CG volume can't push actionable rows out of the window.
      const notifications = dashDb.getNotificationsForContextGraphs(
        [...scope.memberCgIds],
        SCOPED_READ_LIMIT,
      );

      // Authoritative pending-join set per curated CG (G3 reconcile).
      const pendingByGraph = new Map<string, Set<string>>();
      await Promise.all(
        [...scope.curatedCgIds].map(async (cgId) => {
          try {
            const pending = await agent.listPendingJoinRequests(cgId);
            pendingByGraph.set(cgId, new Set(pending.map((r) => r.agentAddress.toLowerCase())));
          } catch {
            pendingByGraph.set(cgId, new Set());
          }
        }),
      );

      const scopeCtx: NotificationScopeContext = {
        callerResolved: true,
        memberCgIds: scope.memberCgIds,
        curatedCgIds: scope.curatedCgIds,
        pendingByGraph,
        selfAgentDid: `${AGENT_DID_PREFIX}${callerAddress}`,
        contextGraphNames: scope.contextGraphNames,
      };
      return jsonResponse(res, 200, scopeNotifications(notifications, scopeCtx));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 500, { error: `Failed to load notifications: ${message}` });
    }
  }

  // POST /api/notifications/read — mark numeric ids AND/OR activity digestKeys
  // read, SCOPED TO THE CALLER (Codex round-1 B2): a caller may only mark rows
  // in their own member CGs — never foreign rows by guessing ids — and an
  // empty body marks only the caller's scoped rows, not the entire table.
  if (req.method === 'POST' && path === '/api/notifications/read') {
    const callerAddress = resolveScopedCaller(ctx);
    // B1/B2: no token-verified caller → no scope → mark nothing (fail closed).
    if (!callerAddress) {
      return jsonResponse(res, 200, { marked: 0, scopeUnknown: true });
    }

    let scopedIds: Set<number>;
    try {
      const scope = await resolveCallerScope(ctx, callerAddress);
      scopedIds = dashDb.getScopedNotificationRowIds([...scope.memberCgIds]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse(res, 500, { error: `Failed to resolve notification scope: ${message}` });
    }

    if (scopedIds.size === 0) {
      return jsonResponse(res, 200, { marked: 0 });
    }

    const body = await readBody(req, SMALL_BODY_BYTES);

    // R2-2: distinguish a genuinely EMPTY body (mark-all, scoped) from a
    // MALFORMED body (parse failure → 400). Conflating both as "undefined"
    // meant a truncated/garbled request silently cleared the caller's whole
    // scoped feed. Empty/whitespace body = the legacy "Mark all read" intent.
    if (body.trim() === '') {
      const count = dashDb.markNotificationsRead([...scopedIds]);
      return jsonResponse(res, 200, { marked: count });
    }
    let parsed: { ids?: unknown };
    try {
      parsed = JSON.parse(body) as { ids?: unknown };
    } catch {
      return jsonResponse(res, 400, { error: 'Invalid JSON body' });
    }
    const rawIds = parsed.ids;

    // A parsed body that omits `ids` (e.g. `{}`) is still an explicit
    // mark-all (scoped) — preserves the existing client behaviour of POSTing
    // `{}` for "Mark all read".
    if (rawIds === undefined) {
      const count = dashDb.markNotificationsRead([...scopedIds]);
      return jsonResponse(res, 200, { marked: count });
    }
    if (!Array.isArray(rawIds)) {
      return jsonResponse(res, 400, { error: '"ids" must be an array of numeric ids and/or digest keys' });
    }

    // Expand digestKeys to underlying row ids; collect numeric ids. Then
    // INTERSECT against the caller's scoped set so foreign ids are ignored.
    const requested = new Set<number>();
    for (const entry of rawIds) {
      if (typeof entry === 'number' && Number.isInteger(entry)) {
        requested.add(entry);
      } else if (typeof entry === 'string') {
        if (/^\d+$/.test(entry)) {
          requested.add(Number(entry)); // numeric id sent as a string
        } else {
          for (const rowId of dashDb.resolveActivityDigestRowIds(entry)) requested.add(rowId);
        }
      }
    }

    const inScope = [...requested].filter((id) => scopedIds.has(id));
    if (inScope.length === 0) {
      return jsonResponse(res, 200, { marked: 0 });
    }
    const count = dashDb.markNotificationsRead(inScope);
    return jsonResponse(res, 200, { marked: count });
  }
}
