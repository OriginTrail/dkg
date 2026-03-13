import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Routes, Route, Navigate, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { DashboardPage } from './pages/Dashboard.js';
import { ExplorerPage } from './pages/Explorer.js';
import { AgentHubPage } from './pages/AgentHub.js';
import { AppsPage } from './pages/Apps.js';
import { SettingsPage, isDevModeEnabled } from './pages/Settings.js';
import { AppHostPage, type InstalledApp } from './pages/AppHost.js';
import { fetchNotifications, markNotificationsRead, type Notification } from './api.js';

const chevronIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="6 9 12 15 18 9"/>
  </svg>
);

const NAV_ICONS: Record<string, React.ReactNode> = {
  home: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
  graph: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/><line x1="8.5" y1="7.5" x2="15.5" y2="16.5"/><line x1="15.5" y1="7.5" x2="8.5" y2="16.5"/></svg>,
  terminal: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>,
  play: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
  messages: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
  activity: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  settings: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
};

function useInstalledApps(): InstalledApp[] {
  const [apps, setApps] = useState<InstalledApp[]>([]);
  useEffect(() => {
    const token = (window as any).__DKG_TOKEN__;
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    fetch('/api/apps', { headers })
      .then(r => r.ok ? r.json() : [])
      .then(setApps)
      .catch(() => {});
  }, []);
  return apps;
}

function AppsNavSection({ installedApps }: { installedApps: InstalledApp[] }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const isAppsActive = location.pathname.startsWith('/apps') || location.pathname.startsWith('/app/');

  return (
    <>
      <button
        className={`nav-btn${isAppsActive ? ' active' : ''}`}
        onClick={() => setOpen(o => !o)}
      >
        {NAV_ICONS.play}
        <span>Apps</span>
        {installedApps.length > 0 && <span className="nav-badge">{installedApps.length}</span>}
        <span style={{ marginLeft: 'auto', transition: 'transform .2s', transform: open ? 'rotate(180deg)' : 'none', display: 'flex' }}>
          {chevronIcon}
        </span>
      </button>
      <div className={`apps-dropdown${open ? ' open' : ''}`}>
        <button
          className={`apps-sub-btn${location.pathname === '/apps' ? ' active-sub' : ''}`}
          onClick={() => { navigate('/apps'); }}
        >
          🎮 OriginTrail Game
        </button>
        {installedApps.filter(a => a.id !== 'origin-trail-game').map(a => (
          <button
            key={a.id}
            className={`apps-sub-btn${location.pathname === `/app/${a.id}` ? ' active-sub' : ''}`}
            onClick={() => { navigate(`/app/${a.id}`); }}
          >
            {a.label}
          </button>
        ))}
      </div>
    </>
  );
}

function SettingsNavSection() {
  const navigate = useNavigate();
  const location = useLocation();
  const [devMode, setDevMode] = useState(isDevModeEnabled);

  useEffect(() => {
    const sync = () => setDevMode(isDevModeEnabled());
    window.addEventListener('devmode-change', sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener('devmode-change', sync); window.removeEventListener('storage', sync); };
  }, []);

  const isSettingsActive = location.pathname === '/settings' && location.search !== '?tab=observability';
  const isObsActive = location.pathname === '/settings' && location.search === '?tab=observability';

  return (
    <>
      <NavLink
        to="/settings"
        className={() => `nav-btn${isSettingsActive || isObsActive ? ' active' : ''}`}
        onClick={(e) => { e.preventDefault(); navigate('/settings'); }}
      >
        {NAV_ICONS.settings}<span>Settings</span>
      </NavLink>
      {devMode && (
        <button
          className={`apps-sub-btn${isObsActive ? ' active-sub' : ''}`}
          onClick={() => navigate('/settings?tab=observability')}
          style={{ paddingLeft: 36 }}
        >
          {NAV_ICONS.activity}
          <span style={{ marginLeft: 6 }}>Observability</span>
        </button>
      )}
    </>
  );
}

function useLiveStatus() {
  const [status, setStatus] = useState<any>(null);
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      const token = (window as any).__DKG_TOKEN__;
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      fetch('/api/status', { headers })
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (!cancelled) setStatus(d); })
        .catch(() => { if (!cancelled) setStatus(null); });
    };
    poll();
    const t = setInterval(poll, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);
  return status;
}


const NOTIF_ICONS: Record<string, string> = {
  chat_message: '\u{1F4AC}',
  peer_connected: '\u{1F7E2}',
  peer_disconnected: '\u{1F534}',
  kc_published: '\u{1F4E6}',
};

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchNotifications({ limit: 100 });
      setNotifications(data.notifications);
      setUnreadCount(data.unreadCount);
    } catch { /* swallow */ }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleOpen = async () => {
    const next = !open;
    setOpen(next);
    if (next && unreadCount > 0) {
      await markNotificationsRead();
      refresh();
    }
  };

  return (
    <div ref={bellRef} style={{ position: 'relative' }}>
      <button
        onClick={handleOpen}
        aria-label="Notifications"
        style={{
          background: 'none', border: 'none', cursor: 'pointer', position: 'relative',
          padding: '6px 8px', borderRadius: 6, color: 'var(--text)',
          display: 'flex', alignItems: 'center',
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
        {unreadCount > 0 && (
          <span style={{
            position: 'absolute', top: 2, right: 2,
            background: 'var(--green)', color: '#000', fontSize: 9, fontWeight: 700,
            borderRadius: '50%', minWidth: 16, height: 16, display: 'flex',
            alignItems: 'center', justifyContent: 'center', padding: '0 4px',
          }}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, width: 340,
          background: 'var(--bg-card, var(--bg))', border: '1px solid var(--border)',
          borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,.4)',
          zIndex: 9999, maxHeight: 420, display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '12px 16px', borderBottom: '1px solid var(--border)',
            fontWeight: 600, fontSize: 13, color: 'var(--text)',
          }}>
            Notifications
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {notifications.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-dim)', fontSize: 13 }}>
                No notifications yet
              </div>
            ) : notifications.slice(0, 50).map(n => (
              <div key={n.id} style={{
                padding: '10px 16px', borderBottom: '1px solid var(--border)',
                display: 'flex', gap: 10, alignItems: 'flex-start',
                background: n.read ? 'transparent' : 'rgba(74,222,128,.06)',
              }}>
                <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>
                  {NOTIF_ICONS[n.type] ?? '\u{1F514}'}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text)', marginBottom: 2 }}>
                    {n.title}
                  </div>
                  <div style={{
                    fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.4,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {n.message}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>
                    {formatTimeAgo(n.ts)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function App() {
  const installedApps = useInstalledApps();
  const liveStatus = useLiveStatus();
  const currentVersion = liveStatus?.version;
  const commitShort = liveStatus?.commit;
  const updateAvailable = liveStatus?.updateAvailable === true;
  const latestCommit = liveStatus?.latestCommit;

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <style>{`@keyframes pulse-fade{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
          <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: 'var(--green)', letterSpacing: '-0.02em' }}>{liveStatus?.name ?? '…'}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 6 }}>
            <span style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: '0.02em' }}>powered by</span>
            <svg width="60" height="13" viewBox="0 0 180 40" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ opacity: 0.55 }}>
              <path d="M55.0428 28.0111C59.7903 28.0111 62.6388 24.531 62.6388 20.3908C62.6388 16.2806 59.7903 12.8005 55.0428 12.8005C50.325 12.8005 47.4766 16.2806 47.4766 20.3908C47.4766 24.531 50.325 28.0111 55.0428 28.0111ZM55.0428 24.621C52.6988 24.621 51.3932 22.6709 51.3932 20.3908C51.3932 18.1407 52.6988 16.1906 55.0428 16.1906C57.3869 16.1906 58.7221 18.1407 58.7221 20.3908C58.7221 22.6709 57.3869 24.621 55.0428 24.621Z" fill="white"/>
              <path d="M65.4344 27.6511H69.2027V18.0807C69.8258 17.1507 71.4874 16.4606 72.7336 16.4606C73.149 16.4606 73.5051 16.4906 73.7721 16.5507V12.8305C71.9918 12.8305 70.2115 13.8505 69.2027 15.1406V13.1605H65.4344V27.6511Z" fill="white"/>
              <path d="M77.9959 11.0304C79.2421 11.0304 80.251 10.0104 80.251 8.75031C80.251 7.49026 79.2421 6.47021 77.9959 6.47021C76.7794 6.47021 75.7409 7.49026 75.7409 8.75031C75.7409 10.0104 76.7794 11.0304 77.9959 11.0304ZM76.1266 27.6511H79.8949V13.1605H76.1266V27.6511Z" fill="white"/>
              <path d="M83.3347 31.3713C85.115 32.9614 87.0437 33.5314 89.5064 33.5314C93.0373 33.5314 97.2507 32.1813 97.2507 26.6611V13.1605H93.4527V15.0206C92.2955 13.5505 90.7526 12.8005 89.0317 12.8005C85.4117 12.8005 82.7116 15.4406 82.7116 20.1808C82.7116 25.011 85.4414 27.5611 89.0317 27.5611C90.7823 27.5611 92.3252 26.7211 93.4527 25.281V26.7511C93.4527 29.6012 91.3164 30.4113 89.5064 30.4113C87.6964 30.4113 86.1832 29.9012 85.026 28.6112L83.3347 31.3713ZM93.4527 22.5209C92.8296 23.4509 91.4647 24.171 90.2185 24.171C88.0822 24.171 86.5986 22.6709 86.5986 20.1808C86.5986 17.6907 88.0822 16.1906 90.2185 16.1906C91.4647 16.1906 92.8296 16.8807 93.4527 17.8407V22.5209Z" fill="white"/>
              <path d="M102.857 11.0304C104.104 11.0304 105.113 10.0104 105.113 8.75031C105.113 7.49026 104.104 6.47021 102.857 6.47021C101.641 6.47021 100.602 7.49026 100.602 8.75031C100.602 10.0104 101.641 11.0304 102.857 11.0304ZM100.988 27.6511H104.756V13.1605H100.988V27.6511Z" fill="white"/>
              <path d="M118.166 27.6511H121.934V17.4207C121.934 14.6006 120.421 12.8005 117.276 12.8005C114.932 12.8005 113.181 13.9405 112.261 15.0506V13.1605H108.493V27.6511H112.261V17.9007C112.884 17.0307 114.042 16.1906 115.525 16.1906C117.127 16.1906 118.166 16.8807 118.166 18.8908V27.6511Z" fill="white"/>
              <path d="M130.483 28.0111C132.055 28.0111 133.064 27.5911 133.628 27.0811L132.827 24.201C132.619 24.411 132.085 24.621 131.521 24.621C130.69 24.621 130.216 23.931 130.216 23.0309V16.4906H133.123V13.1605H130.216V9.20033H126.418V13.1605H124.044V16.4906H126.418V24.051C126.418 26.6311 127.842 28.0111 130.483 28.0111Z" fill="white"/>
              <path d="M135.702 27.6511H139.47V18.0807C140.093 17.1507 141.755 16.4606 143.001 16.4606C143.416 16.4606 143.772 16.4906 144.039 16.5507V12.8305C142.259 12.8305 140.479 13.8505 139.47 15.1406V13.1605H135.702V27.6511Z" fill="white"/>
              <path d="M156.245 27.6511H160.043V13.1605H156.245V15.0206C155.117 13.5505 153.515 12.8005 151.824 12.8005C148.174 12.8005 145.474 15.6806 145.474 20.4208C145.474 25.251 148.204 28.0111 151.824 28.0111C153.545 28.0111 155.117 27.2311 156.245 25.8211V27.6511ZM156.245 22.9709C155.592 23.931 154.257 24.621 152.981 24.621C150.845 24.621 149.361 22.9109 149.361 20.4208C149.361 17.9007 150.845 16.2206 152.981 16.2206C154.257 16.2206 155.592 16.9107 156.245 17.8707V22.9709Z" fill="white"/>
              <path d="M165.649 11.0304C166.895 11.0304 167.904 10.0104 167.904 8.75031C167.904 7.49026 166.895 6.47021 165.649 6.47021C164.432 6.47021 163.394 7.49026 163.394 8.75031C163.394 10.0104 164.432 11.0304 165.649 11.0304ZM163.78 27.6511H167.548V13.1605H163.78V27.6511Z" fill="white"/>
              <path d="M175.32 28.0111C176.863 28.0111 177.871 27.5911 178.435 27.0811L177.634 24.201C177.456 24.411 176.922 24.621 176.358 24.621C175.527 24.621 175.053 23.931 175.053 23.0309V7.64026H171.284V24.051C171.284 26.6311 172.679 28.0111 175.32 28.0111Z" fill="white"/>
              <path fillRule="evenodd" clipRule="evenodd" d="M19.781 9.94781C14.2903 9.94781 9.8385 14.4484 9.8385 20.0008C9.8385 25.5525 14.2903 30.0531 19.781 30.0531C22.833 30.0531 25.5632 28.6622 27.3869 26.4736L34.9141 32.8796C31.2855 37.2341 25.8532 40.0016 19.781 40.0016C8.85592 40.0016 0 31.0467 0 20.0008C0 8.95432 8.85592 0 19.781 0V9.94781ZM36.8737 30.0724L28.3719 25.0628C28.662 24.5606 28.9105 24.0308 29.112 23.4781L38.3464 26.9194C37.9453 28.0192 37.4508 29.0732 36.8737 30.0724ZM29.7216 20.0007H39.5609C39.5609 18.8159 39.4583 17.6554 39.2628 16.5272L29.5719 18.2549C29.6701 18.822 29.7216 19.4053 29.7216 20.0007ZM34.988 7.20831L27.425 13.5712C27.0546 13.1215 26.646 12.7054 26.2045 12.3272L32.5596 4.73338C33.4381 5.4858 34.251 6.31374 34.988 7.20831Z" fill="white"/>
            </svg>
          </div>
        </div>

        <nav className="sidebar-nav">
          <NavLink to="/" end className={({ isActive }) => `nav-btn${isActive ? ' active' : ''}`}>
            {NAV_ICONS.home}<span>Dashboard</span>
          </NavLink>
          <NavLink to="/explorer" className={({ isActive }) => `nav-btn${isActive ? ' active' : ''}`}>
            {NAV_ICONS.graph}<span>Memory Explorer</span>
          </NavLink>
          <NavLink to="/agent" className={({ isActive }) => `nav-btn${isActive ? ' active' : ''}`}>
            {NAV_ICONS.terminal}<span>Agent Hub</span>
          </NavLink>
          <AppsNavSection installedApps={installedApps} />
          <SettingsNavSection />
        </nav>

        <div className="sidebar-footer">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span className="pulse-dot" style={{ width: 7, height: 7, borderRadius: '50%', background: liveStatus ? 'var(--green)' : 'var(--text-dim)', boxShadow: liveStatus ? '0 0 8px rgba(74,222,128,.4)' : 'none', display: 'inline-block' }} />
            <span style={{ color: liveStatus ? 'var(--green)' : 'var(--text-muted)', fontWeight: 600 }}>{liveStatus ? 'Online' : 'Connecting…'}</span>
            <span className="mono" style={{ color: 'var(--text-dim)', marginLeft: 'auto', fontSize: 10 }}>
              {liveStatus?.connectedPeers != null ? `${liveStatus.connectedPeers} peers` : liveStatus?.peerCount != null ? `${liveStatus.peerCount} peers` : '…'}
            </span>
          </div>
          <div className="mono" style={{ color: 'var(--text-dim)', fontSize: 10, marginBottom: 6 }}>
            {liveStatus?.networkName ?? liveStatus?.networkId ?? 'unknown network'}{liveStatus?.syncing ? ' · syncing…' : ''}
          </div>
          {currentVersion && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                <span className="mono" style={{ fontSize: 10, color: updateAvailable ? '#fbbf24' : liveStatus?.updateAvailable === false ? 'var(--green)' : 'var(--text-dim)' }}>
                  v{currentVersion}{commitShort ? ` (${commitShort})` : ''}
                </span>
                {liveStatus?.updateAvailable === false && (
                  <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--green)' }}>· latest</span>
                )}
                {updateAvailable && (
                  <span title={`Latest: ${latestCommit || 'unknown'}${liveStatus?.autoUpdate ? ' — auto-update will apply it' : ' — update manually'}`} style={{
                    fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
                    background: 'rgba(251,191,36,.12)', color: '#fbbf24', cursor: 'default',
                    animation: 'pulse-fade 2.5s ease-in-out infinite',
                  }}>{liveStatus?.autoUpdate ? 'updating' : 'update available'}{latestCommit ? ` → ${latestCommit}` : ''}</span>
                )}
              </div>
              <div style={{ fontSize: 10, color: liveStatus?.autoUpdate ? 'var(--green)' : 'var(--text-dim)', opacity: 0.7 }}>
                Auto-updater: {liveStatus?.autoUpdate ? 'enabled' : 'disabled'}
              </div>
            </div>
          )}
        </div>
      </aside>

      <main className="main-content">
        <div style={{
          display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
          padding: '4px 16px', borderBottom: '1px solid var(--border)',
          flexShrink: 0, minHeight: 36,
        }}>
          <NotificationBell />
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/explorer/*" element={<ExplorerPage />} />
          <Route path="/agent" element={<AgentHubPage />} />
          <Route path="/messages" element={<Navigate to="/agent" replace />} />
          <Route path="/apps/*" element={<AppsPage apps={installedApps} />} />
          <Route path="/operations/*" element={<Navigate to="/settings?tab=observability" replace />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/app/:appId" element={<AppHostPage apps={installedApps} />} />
          {/* Backward-compatible redirects for legacy routes */}
          <Route path="/network" element={<Navigate to="/" replace />} />
          <Route path="/wallet" element={<Navigate to="/settings" replace />} />
          <Route path="/integrations" element={<Navigate to="/settings" replace />} />
        </Routes>
        </div>
      </main>
    </div>
  );
}
