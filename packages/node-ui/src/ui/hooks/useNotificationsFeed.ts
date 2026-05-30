/**
 * useNotificationsFeed — the single data-orchestration hook behind the
 * redesigned notifications pane (implementation-plan.md §3/§5, ui-brief §5.1).
 *
 * The daemon returns a caller-scoped, type-allowlisted, activity-collapsed,
 * join_request-reconciled feed (`GET /api/notifications` →
 * `NotificationsFeedResponse`). This hook is therefore thin: it maps the wire
 * rows into two view-model lists, drives refresh (60s visibility-aware poll +
 * the single generic `notification` SSE event), owns the approve/deny
 * mutations, and implements the read model. The pane component stays purely
 * presentational.
 *
 * Key behaviours locked by the briefs:
 *  - Scoping is server-side; the client NEVER re-filters for correctness.
 *  - `unread` IS the daemon's `badgeCount` (already excludes join_rejected) —
 *    not re-derived client-side.
 *  - Identity unresolved (`scopeUnknown`) surfaces as `status:'identity-pending'`
 *    so the pane renders "Verifying access…", never "all caught up".
 *  - Approve/deny do NOT optimistically remove the row before the call settles
 *    (a dropdown failure must be recoverable in place). The reconciled feed +
 *    SSE + poll drop the row on the next load.
 *  - Opening the bell must NOT auto-mark-all-read: `markSeen` takes explicit
 *    informational ids only; actionable join requests clear only when acted on.
 *  - Last-known-good: a refresh failure keeps the previously loaded rows and
 *    surfaces the error alongside (mirrors useAssertionLifecycleEvents).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  markNotificationsRead,
  approveJoinRequest,
  rejectJoinRequest,
  type NotifWire,
  type NotificationsFeedResponse,
} from '../api.js';
// The scoped feed goes through the api-wrapper so the pane also resolves in
// mock mode (withFallback). approve/reject/markRead are called directly on the
// real api, matching the existing PendingJoinRequestsSection pattern.
import { api } from '../api-wrapper.js';
import { useNodeEvents } from './useNodeEvents.js';
import { useVisibilityPolling } from './useVisibilityPolling.js';

/** The daemon's benign "this request was already approved/denied (here or in
 *  another tab/curator)" signal. The pane treats it as success → "Already
 *  handled" and drops the row (data-contract §5.2). Kept as an exported
 *  constant so the row component and tests share the exact literal; the daemon
 *  owns this string and flags ui-lead before changing it. */
export const ALREADY_HANDLED_ERROR = 'No pending join request found';

export type NotificationsFeedStatus = 'loading' | 'ready' | 'error' | 'identity-pending';

/** Outcome of an approve/deny mutation, so the row can pick its terminal
 *  state without re-throwing. */
export type ActionResult =
  | { ok: true; alreadyHandled?: boolean }
  | { ok: false; error: string; roleError: boolean };

/** Actionable: an incoming join request on a CG the caller curates. */
export interface JoinRequestItem {
  /** Numeric notification row id (used for read-marking if ever needed). */
  id: number;
  cgId: string;
  contextGraphName?: string;
  agentAddress: string;
  agentName?: string;
  ts: number;
  read: boolean;
}

/** Informational rows shown in the chronological "Activity" section. A
 *  discriminated union mirroring the wire kinds the pane renders below the
 *  pinned join-request section. */
export type ActivityItem =
  | {
      kind: 'digest';
      /** Stable `digestKey` — mark-read target and React list key. */
      id: string;
      cgId: string;
      contextGraphName?: string;
      event: 'created' | 'promoted' | 'published';
      count: number;
      /** Present only when a single non-self author dominates the window
       *  (`soleAuthor === true`); render the AgentChip iff this is set. */
      actorAgentDid?: string;
      actorAgentName?: string;
      ts: number;
      read: boolean;
    }
  | {
      kind: 'join_approved';
      id: number;
      cgId: string;
      contextGraphName?: string;
      ts: number;
      read: boolean;
    }
  | {
      kind: 'join_rejected';
      id: number;
      cgId: string;
      contextGraphName?: string;
      ts: number;
      read: boolean;
    };

export interface UseNotificationsFeed {
  /** Pinned-top actionable section (server already scoped to curated CGs). */
  joinRequests: JoinRequestItem[];
  /** Chronological informational stream (digests + approved + rejected). */
  activity: ActivityItem[];
  /** Unread badge = daemon `badgeCount` (rejections already excluded). */
  unread: number;
  /** True when any unread INFORMATIONAL row exists (digests + approved +
   *  rejected). Drives "Mark all read" visibility — NOT `unread`/badgeCount,
   *  which excludes join_rejected, so a rejected-only-unread state would
   *  otherwise have no way to clear (Codex I4). */
  hasInformationalUnread: boolean;
  status: NotificationsFeedStatus;
  /** A background refresh failed while last-known-good data is still shown
   *  (status stays 'ready', the cached list is preserved). Drives the pane's
   *  inline "Couldn't refresh" retry banner (Codex R2-5). */
  refreshError: boolean;
  /** Activity sub-section couldn't load but join list is fine (reserved for
   *  a future partial-error wire signal; false until the daemon distinguishes
   *  it — kept so the pane can wire the partial-error state now). */
  partialActivityError: boolean;
  /** Approve a pending join request. Does not remove the row; the caller
   *  transitions the row based on the returned `ActionResult` and the next
   *  reconciled load drops it. */
  approve: (cgId: string, agentAddress: string) => Promise<ActionResult>;
  deny: (cgId: string, agentAddress: string) => Promise<ActionResult>;
  /** Mark INFORMATIONAL items seen by id (numeric ids and/or string
   *  digestKeys). Never pass actionable join_request ids — those clear only
   *  when acted on (read model, ui-brief §5.4). */
  markSeen: (ids: Array<number | string>) => void;
  /** Convenience for "Mark all read": marks every currently-loaded
   *  informational item (digests + approved + rejected) seen. */
  markAllInformationalSeen: () => void;
  /** Re-run the load (e.g. after an error banner's Retry). */
  retry: () => void;
}

export function mapJoinRequests(rows: NotifWire[]): JoinRequestItem[] {
  const out: JoinRequestItem[] = [];
  for (const n of rows) {
    if (n.type !== 'join_request') continue;
    out.push({
      id: n.id as number,
      cgId: n.contextGraphId,
      contextGraphName: n.meta.contextGraphName,
      agentAddress: n.meta.agentAddress,
      agentName: n.meta.agentName,
      ts: n.ts,
      read: n.read === 1,
    });
  }
  // Newest-first within the pinned actionable block (ui-brief §4.3).
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

export function mapActivity(rows: NotifWire[]): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const n of rows) {
    if (n.type === 'assertion_activity') {
      out.push({
        kind: 'digest',
        id: n.id,
        cgId: n.contextGraphId,
        contextGraphName: n.meta.contextGraphName,
        event: n.meta.kind,
        count: n.meta.count,
        // Carry the author only when the daemon flagged a sole non-self
        // author; otherwise omit so the row renders count-only.
        ...(n.meta.soleAuthor && n.meta.actorAgentDid
          ? { actorAgentDid: n.meta.actorAgentDid, actorAgentName: n.meta.actorAgentName }
          : {}),
        ts: n.ts,
        read: n.read === 1,
      });
    } else if (n.type === 'join_approved' || n.type === 'join_rejected') {
      out.push({
        kind: n.type,
        id: n.id as number,
        cgId: n.contextGraphId,
        contextGraphName: n.meta.contextGraphName,
        ts: n.ts,
        read: n.read === 1,
      });
    }
  }
  // Newest-first chronological stream (ui-brief §4.3).
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

/**
 * The ids that "Mark all read" / bell-open dwell may mark seen: unread
 * INFORMATIONAL rows only (activity digests, join approved, join rejected).
 * Actionable `join_request` rows are NEVER included — they clear only when
 * acted on (the core read-model rule M8, ui-brief §5.4). Exported + pure so
 * the single highest-risk read-model rule is unit-tested directly.
 */
export function selectInformationalUnreadIds(rows: NotifWire[]): Array<number | string> {
  return rows
    .filter((n) => n.type !== 'join_request' && n.read === 0)
    .map((n) => n.id);
}

/** Classify a thrown mutation error. `ALREADY_HANDLED_ERROR` → benign
 *  already-handled; the agent-layer owner-assertion error → role error
 *  (render "You're no longer the curator of {CG}"). Exported for unit tests. */
export function classifyActionError(err: unknown): ActionResult {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes(ALREADY_HANDLED_ERROR)) {
    return { ok: true, alreadyHandled: true };
  }
  // The daemon's owner assertion throws "Only the context graph creator can
  // manage invitations" (and the parallel "…join requests" for reject, G1).
  const roleError = /context graph creator|manage (invitations|join requests)|curator/i.test(msg);
  return { ok: false, error: msg, roleError };
}

export function useNotificationsFeed(): UseNotificationsFeed {
  const [data, setData] = useState<NotificationsFeedResponse | null>(null);
  const [status, setStatus] = useState<NotificationsFeedStatus>('loading');
  // A WARM refresh failure (we already have data) keeps `status: 'ready'` so
  // the cached list stays visible; this separate flag lets the pane render its
  // inline "Couldn't refresh" retry banner (Codex R2-5).
  const [refreshError, setRefreshError] = useState(false);
  // Track whether we've ever loaded successfully, so a refresh failure keeps
  // the last-known-good payload instead of blanking the pane.
  const hasDataRef = useRef(false);

  const load = useCallback(() => {
    api.fetchNotificationsFeed()
      .then((resp) => {
        hasDataRef.current = true;
        setData(resp);
        setRefreshError(false);
        setStatus(resp.scopeUnknown ? 'identity-pending' : 'ready');
      })
      .catch(() => {
        // Last-known-good: keep prior rows if we have them. A WARM failure
        // (already have data) keeps status 'ready' — which is what preserves
        // the cached list — and raises `refreshError` so the pane still shows
        // its inline retry banner (status alone can't, since 'ready' is what
        // keeps the list — Codex R2-5). A COLD failure (nothing loaded yet) is
        // the hard error state.
        if (hasDataRef.current) {
          setRefreshError(true);
        } else {
          setStatus('error');
        }
      });
  }, []);

  // 60s visibility-aware poll (pauses while the tab is hidden), with an
  // immediate load on mount — same cadence the old Header used.
  useVisibilityPolling(load, 60_000);

  // Single generic `notification` SSE event drives live refresh for ALL kinds
  // (data-contract §4.5). The three join events stay registered for other
  // consumers; the pane subscribes only to `notification`.
  useNodeEvents(
    useCallback(
      (event) => {
        if (event.type === 'notification') load();
      },
      [load],
    ),
  );

  const joinRequests = useMemo(() => mapJoinRequests(data?.notifications ?? []), [data]);
  const activity = useMemo(() => mapActivity(data?.notifications ?? []), [data]);
  const unread = data?.badgeCount ?? 0;
  // Drives "Mark all read" visibility. Distinct from `unread` (= badgeCount,
  // which excludes join_rejected) so a rejected-only-unread state can still be
  // cleared (Codex I4).
  const hasInformationalUnread = useMemo(
    () => selectInformationalUnreadIds(data?.notifications ?? []).length > 0,
    [data],
  );

  const markSeen = useCallback((ids: Array<number | string>) => {
    if (ids.length === 0) return;
    // Optimistically flip the targeted rows' `read` flag for immediate ROW
    // styling. The badge is NOT decremented here: `unread` = the server's
    // `badgeCount` (scoped + rejection-excluded), which updates on the
    // reconciling `load()` below — server-authoritative, lags one round-trip,
    // never wrong-direction (ui-pr-note §6 / Codex I6).
    setData((prev) => {
      if (!prev) return prev;
      const seen = new Set(ids.map(String));
      return {
        ...prev,
        notifications: prev.notifications.map((n) =>
          seen.has(String(n.id)) ? { ...n, read: 1 as const } : n,
        ),
      };
    });
    markNotificationsRead(ids).then(load).catch(() => {});
  }, [load]);

  const markAllInformationalSeen = useCallback(() => {
    // Informational-unread only; actionable join requests are excluded so a
    // glance/Mark-all-read never clears them (M8, ui-brief §5.4).
    markSeen(selectInformationalUnreadIds(data?.notifications ?? []));
  }, [data, markSeen]);

  const approve = useCallback(async (cgId: string, agentAddress: string): Promise<ActionResult> => {
    try {
      await approveJoinRequest(cgId, agentAddress);
      // Do NOT remove the row here — let the reconciled feed drop it. Refresh
      // so the pinned row disappears and the badge updates.
      load();
      return { ok: true };
    } catch (err) {
      const result = classifyActionError(err);
      if (result.ok && result.alreadyHandled) load(); // resolved elsewhere — reconcile away
      return result;
    }
  }, [load]);

  const deny = useCallback(async (cgId: string, agentAddress: string): Promise<ActionResult> => {
    try {
      await rejectJoinRequest(cgId, agentAddress);
      load();
      return { ok: true };
    } catch (err) {
      const result = classifyActionError(err);
      if (result.ok && result.alreadyHandled) load();
      return result;
    }
  }, [load]);

  const retry = useCallback(() => {
    setRefreshError(false);
    setStatus(hasDataRef.current ? 'ready' : 'loading');
    load();
  }, [load]);

  return {
    joinRequests,
    activity,
    unread,
    hasInformationalUnread,
    status,
    refreshError,
    // Reserved for a future wire signal; the daemon does not yet distinguish a
    // partial activity-query failure from a full one, so this stays false. The
    // pane wires the state now so adding the signal later is a one-line change.
    partialActivityError: false,
    approve,
    deny,
    markSeen,
    markAllInformationalSeen,
    retry,
  };
}
