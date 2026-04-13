import React, { useEffect, useState, useRef } from 'react';
import { type Notification } from '../../api.js';
import { api } from '../../api-wrapper.js';
import { useLayoutStore } from '../../stores/layout.js';
import { useAgentsStore } from '../../stores/agents.js';

const DKG_LOGO = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="4" />
    <line x1="12" y1="2" x2="12" y2="8" />
    <line x1="12" y1="16" x2="12" y2="22" />
    <line x1="2" y1="12" x2="8" y2="12" />
    <line x1="16" y1="12" x2="22" y2="12" />
  </svg>
);

const BELL_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

const SUN_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </svg>
);

const MOON_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const SIDEBAR_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
  </svg>
);

const AGENT_PANEL_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
  </svg>
);

export function Header() {
  const { theme, setTheme, leftCollapsed, toggleLeft, rightCollapsed, toggleRight } = useLayoutStore();
  const nodeStatus = useAgentsStore((s) => s.nodeStatus);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [showNotifs, setShowNotifs] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;
    const load = () => {
      api.fetchNotifications().then(({ notifications: n, unreadCount }: any) => {
        if (!mounted) return;
        setNotifications(n);
        setUnread(unreadCount);
      }).catch(() => {});
    };
    load();
    const iv = setInterval(load, 30_000);
    return () => { mounted = false; clearInterval(iv); };
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setShowNotifs(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const connectedPeers = nodeStatus?.connectedPeers ?? nodeStatus?.peerCount ?? 0;
  const statusLoaded = nodeStatus != null;
  const synced = statusLoaded && nodeStatus?.synced !== false;

  return (
    <header className="v10-header">
      <div className="v10-header-logo">
        {DKG_LOGO}
        <span className="v10-header-logo-text">DKG <span className="v10-header-logo-version">v10</span></span>
      </div>

      <button
        className={`v10-header-icon-btn ${!leftCollapsed ? 'active-toggle' : ''}`}
        onClick={toggleLeft}
        title="Toggle sidebar"
      >
        {SIDEBAR_ICON}
      </button>

      <div className="v10-header-sep" />

      <div className="v10-header-agent-switcher">
        <span className="v10-header-agent-dot" />
        <span className="v10-header-agent-name">{nodeStatus?.name || 'Node Agent'}</span>
      </div>

      <div className="v10-header-spacer" />

      <div className="v10-header-meta">
        <span className={`v10-header-status-dot ${synced ? 'online' : 'offline'}`} />
        <span>{synced ? 'synced' : 'syncing'}</span>
        <span className="v10-header-meta-sep">·</span>
        <span>{connectedPeers} peer{connectedPeers !== 1 ? 's' : ''}</span>
      </div>

      <div className="v10-header-actions">
        <div className="v10-header-notif-wrap" ref={notifRef}>
          <button
            className="v10-header-icon-btn"
            onClick={() => {
              setShowNotifs((v) => !v);
              if (unread > 0) api.markNotificationsRead().then(() => setUnread(0)).catch(() => {});
            }}
          >
            {BELL_ICON}
            {unread > 0 && <span className="v10-header-notif-badge">{unread}</span>}
          </button>
          {showNotifs && (
            <div className="v10-header-notif-dropdown">
              <div className="v10-header-notif-title">Notifications</div>
              {notifications.length === 0 ? (
                <div className="v10-header-notif-empty">No notifications</div>
              ) : notifications.slice(0, 8).map((n, i) => (
                <div key={i} className="v10-header-notif-item">
                  <div className="v10-header-notif-item-text">{n.message ?? n.title ?? 'Notification'}</div>
                  {n.ts && <div className="v10-header-notif-item-time">{new Date(n.ts).toLocaleTimeString()}</div>}
                </div>
              ))}
            </div>
          )}
        </div>

        <button
          className="v10-header-icon-btn"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? SUN_ICON : MOON_ICON}
        </button>

        <button
          className={`v10-header-icon-btn ${!rightCollapsed ? 'active-toggle' : ''}`}
          onClick={toggleRight}
          title="Toggle agent panel"
        >
          {AGENT_PANEL_ICON}
        </button>
      </div>
    </header>
  );
}
