/**
 * NotificationsBell — the header bell button + unread badge + the dropdown
 * disclosure (ui-brief §3/§4.6). Extracted out of Header.tsx so the pane is
 * testable and Header stays a thin shell.
 *
 * Disclosure behaviour:
 *  - Toggles the pane open/closed; closes on outside mousedown.
 *  - Escape closes and restores focus to the bell (was mouse-only before).
 *  - `aria-haspopup` / `aria-expanded` / `aria-controls` mark it as a
 *    dialog-like disclosure.
 *
 * Opening the bell does NOT auto-mark-all-read (the core read-model change,
 * ui-brief §5.4): the unread badge reflects the daemon's `badgeCount` and
 * clears only when items are acted on / explicitly marked seen. B3 layers in
 * the dwell-based "seen" marking + focus-into-panel.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useProjectsStore } from '../../stores/projects.js';
import { useTabsStore } from '../../stores/tabs.js';
import { useNotificationsFeed } from '../../hooks/useNotificationsFeed.js';
import { NotificationsPane } from '../Notifications/NotificationsPane.js';

const BELL_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

const PANE_ID = 'v10-notifications-pane';

export function NotificationsBell() {
  const feed = useNotificationsFeed();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const setActiveProject = useProjectsStore((s) => s.setActiveProject);
  const { openTab } = useTabsStore();

  const paneRef = useRef<HTMLDivElement>(null);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) bellRef.current?.focus();
  }, []);

  // Close on outside mousedown (existing behaviour).
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, close]);

  // Focus management: on open, move focus into the panel — prefer the FIRST
  // ACTIONABLE row's primary Approve button, else the first focusable element,
  // else the panel container (ux-brief §9). Landing on "Mark all read" would be
  // a spec regression. Target `.v10-notif-btn-approve` specifically: a plain
  // `.v10-notif-section-action button` matched the row's "Open {CG}" link
  // (`.v10-notif-cg-link`, which precedes the actions in DOM order), not
  // Approve (Codex I5). On close we restore focus to the bell (see `close(true)`).
  useEffect(() => {
    if (!open) return;
    const pane = paneRef.current;
    if (!pane) return;
    const firstApprove = pane.querySelector<HTMLElement>(
      '.v10-notif-section-action .v10-notif-btn-approve',
    );
    // No join requests → focus the first ACTIVITY row's control, never the
    // title-bar "Mark all read" (Codex R2-4): the generic fallback below
    // explicitly excludes `.v10-notif-pane-markread` so it can't become the
    // initial focus and skip the first notification row.
    const firstRowControl = pane.querySelector<HTMLElement>(
      '.v10-notif-section-rows button, .v10-notif-section-rows a[href]',
    );
    const firstFocusable = pane.querySelector<HTMLElement>(
      'button:not(.v10-notif-pane-markread), [href], [tabindex]:not([tabindex="-1"])',
    );
    (firstApprove ?? firstRowControl ?? firstFocusable ?? pane).focus();
  }, [open]);

  const onOpenContextGraph = useCallback((cgId: string) => {
    setActiveProject(cgId);
    openTab({ id: `project:${cgId}`, label: cgId.slice(0, 16), closable: true });
    close();
  }, [setActiveProject, openTab, close]);

  const unread = feed.unread;

  return (
    <div
      className="v10-header-notif-wrap"
      ref={wrapRef}
      // Escape closes the pane + restores focus to the bell. Handled here as a
      // React bubble handler (not a document listener) so the inline
      // Deny-confirm's own Escape handler can `stopPropagation()` to cancel
      // just the confirm without also closing the whole dropdown.
      onKeyDown={open ? (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close(true);
        }
      } : undefined}
    >
      <button
        ref={bellRef}
        className="v10-header-icon-btn"
        onClick={() => setOpen((v) => !v)}
        title={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? PANE_ID : undefined}
      >
        {BELL_ICON}
        {unread > 0 && <span className="v10-header-notif-badge">{unread}</span>}
      </button>
      {open && (
        <NotificationsPane
          id={PANE_ID}
          paneRef={paneRef}
          feed={feed}
          onOpenContextGraph={onOpenContextGraph}
        />
      )}
    </div>
  );
}
