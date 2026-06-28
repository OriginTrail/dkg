/**
 * NotificationsPane — the bell dropdown surface (ui-brief §4).
 *
 * Two sections rendered into one scroll container:
 *   1. "Needs your action" (pinned top) — actionable join requests.
 *   2. "Activity" (newest-first) — activity digests + join confirmations.
 *
 * Owns the presentational states (loading / identity-pending / error /
 * partial-activity-error / empty) and the title bar with "Mark all read".
 * Data + mutations come from `useNotificationsFeed` via props so the pane
 * stays testable without the network. B3 deepens a11y (focus order, richer
 * aria-live) and the read-on-interaction wiring.
 */
import React from 'react';
import type { UseNotificationsFeed } from '../../hooks/useNotificationsFeed.js';
import type { PcaAlert } from '../../hooks/usePcaAlerts.js';
import { JoinRequestRow, ActivityDigestRow, ConfirmationRow } from './rows.js';

export interface NotificationsPaneProps {
  feed: UseNotificationsFeed;
  /** Open a context graph (set active + open its tab) and close the pane. */
  onOpenContextGraph: (cgId: string) => void;
  /** E2 — client-derived predictive PCA alerts (default none = no section). */
  pcaAlerts?: PcaAlert[];
  /** Open a PCA's Manage detail tab from an alert. */
  onOpenPca?: (accountId: string) => void;
  /** Dropdown id — wired to the bell's `aria-controls`. */
  id?: string;
  /** Ref to the pane root so the bell can move focus into it on open
   *  (falls back to the container when no focusable row exists). */
  paneRef?: React.Ref<HTMLDivElement>;
}

export function NotificationsPane({ feed, onOpenContextGraph, pcaAlerts = [], onOpenPca, id, paneRef }: NotificationsPaneProps) {
  const {
    joinRequests,
    activity,
    status,
    refreshError,
    partialActivityError,
    hasInformationalUnread,
    approve,
    deny,
    markSeen,
    markAllInformationalSeen,
  } = feed;

  // Per-item read-on-interaction (read model, ui-brief §5.4): opening an
  // informational row (activity digest / approved confirmation) marks THAT
  // item seen, then navigates. Actionable join requests are NOT marked here —
  // they clear only when acted on (approve/deny).
  const openAndMarkSeen = (cgId: string, id: number | string) => {
    markSeen([id]);
    onOpenContextGraph(cgId);
  };

  const hasJoin = joinRequests.length > 0;
  const hasActivity = activity.length > 0;
  const hasPca = pcaAlerts.length > 0;
  const isEmpty = !hasJoin && !hasActivity && !hasPca;

  return (
    <div className="v10-notif-pane" role="region" aria-label="Notifications" id={id} ref={paneRef} tabIndex={-1}>
      <div className="v10-notif-pane-titlebar">
        <div className="v10-notif-pane-title">Notifications</div>
        {hasInformationalUnread && (
          <button
            type="button"
            className="v10-notif-pane-markread"
            onClick={markAllInformationalSeen}
            title="Mark informational notifications as read"
          >
            Mark all read
          </button>
        )}
      </div>

      <div className="v10-notif-pane-body">
        {/* E2 — predictive PCA alerts (client-derived; shown regardless of the
            server feed's state). Additive: omitted entirely when there are none. */}
        {hasPca && (
          <section className="v10-notif-section v10-notif-section-pca" aria-label="Publishing conviction">
            <div className="v10-notif-section-head">
              <span className="v10-notif-section-label">Publishing conviction</span>
              <span className="v10-notif-section-count">{pcaAlerts.length}</span>
            </div>
            <div className="v10-notif-section-rows">
              {pcaAlerts.map((al) => (
                <div
                  key={al.id}
                  className="v10-pca-alert-row"
                  data-severity={al.severity}
                  data-testid="pca-bell-alert"
                  role={al.severity === 'danger' ? 'alert' : 'status'}
                >
                  <div className="v10-pca-alert-title">{al.title}</div>
                  <div className="v10-pca-alert-msg">{al.message}</div>
                  {onOpenPca && (
                    <button type="button" className="v10-pca-alert-action" onClick={() => onOpenPca(al.accountId)}>
                      Manage PCA #{al.accountId}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* identity-pending — fail closed, never "all caught up" (UX §7). */}
        {status === 'identity-pending' ? (
          <div className="v10-notif-pane-state" role="status">Verifying access…</div>
        ) : status === 'loading' && isEmpty ? (
          <div className="v10-notif-pane-state" role="status">Loading notifications…</div>
        ) : status === 'error' && isEmpty ? (
          <div className="v10-notif-pane-error" role="status" aria-live="polite">
            Couldn’t load notifications.{' '}
            <button type="button" className="v10-notif-retry" onClick={feed.retry}>Retry</button>
          </div>
        ) : isEmpty ? (
          <div className="v10-notif-pane-empty" role="status">
            <div className="v10-notif-pane-empty-lead">You’re all caught up.</div>
            <div className="v10-notif-pane-empty-sub">
              Join requests, approvals, and new activity in your context graphs will show up here.
            </div>
          </div>
        ) : (
          <>
            {/* A refresh error while we still have cached rows: thin banner
                above, list preserved (last-known-good, ui-brief §4.5). */}
            {refreshError && (
              <div className="v10-notif-pane-error v10-notif-pane-error-inline" role="status" aria-live="polite">
                Couldn’t refresh notifications.{' '}
                <button type="button" className="v10-notif-retry" onClick={feed.retry}>Retry</button>
              </div>
            )}

            {hasJoin && (
              <section className="v10-notif-section v10-notif-section-action" aria-label="Needs your action">
                <div className="v10-notif-section-head">
                  <span className="v10-notif-section-label">Needs your action</span>
                  <span className="v10-notif-section-count">{joinRequests.length}</span>
                </div>
                <div className="v10-notif-section-rows">
                  {joinRequests.map((req) => (
                    <JoinRequestRow
                      key={req.id}
                      item={req}
                      onApprove={approve}
                      onDeny={deny}
                      onOpen={onOpenContextGraph}
                    />
                  ))}
                </div>
              </section>
            )}

            <section className="v10-notif-section v10-notif-section-activity" aria-label="Activity">
              <div className="v10-notif-section-head">
                <span className="v10-notif-section-label">Activity</span>
              </div>
              {partialActivityError && (
                <div className="v10-notif-pane-error v10-notif-pane-error-inline" role="status" aria-live="polite">
                  Recent activity couldn’t load.
                </div>
              )}
              {hasActivity ? (
                <div className="v10-notif-section-rows">
                  {activity.map((item) =>
                    item.kind === 'digest' ? (
                      <ActivityDigestRow
                        key={item.id}
                        item={item}
                        onOpen={(cgId) => openAndMarkSeen(cgId, item.id)}
                      />
                    ) : (
                      <ConfirmationRow
                        key={item.id}
                        item={item}
                        onOpen={(cgId) => openAndMarkSeen(cgId, item.id)}
                      />
                    ),
                  )}
                </div>
              ) : (
                !partialActivityError && (
                  <div className="v10-notif-section-empty">No recent activity.</div>
                )
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
