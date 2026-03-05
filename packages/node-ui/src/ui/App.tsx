import React, { useEffect, useState } from 'react';
import { Routes, Route, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { DashboardPage } from './pages/Dashboard.js';
import { ExplorerPage } from './pages/Explorer.js';
import { AgentHubPage } from './pages/AgentHub.js';
import { AppsPage } from './pages/Apps.js';
import { SettingsPage } from './pages/Settings.js';
import { MessagesPage } from './pages/Messages.js';
import { AppHostPage, type InstalledApp } from './pages/AppHost.js';
import { ChatPanel } from './components/ChatPanel.js';

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

function AppsNavSection() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const isAppsActive = location.pathname.startsWith('/apps');

  return (
    <>
      <button
        className={`nav-btn${isAppsActive ? ' active' : ''}`}
        onClick={() => setOpen(o => !o)}
      >
        {NAV_ICONS.play}
        <span>Apps</span>
        <span className="nav-badge">NEW</span>
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
          <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: 'var(--green-dim)', color: 'var(--green)', fontWeight: 700, marginLeft: 'auto' }}>
            HELLO WORLD
          </span>
        </button>
      </div>
    </>
  );
}

export function App() {
  const installedApps = useInstalledApps();

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-icon">
            <span className="mono" style={{ fontSize: 14, fontWeight: 900, color: 'var(--green)' }}>◆</span>
          </div>
          <div>
            <div className="logo-text">DKG Node</div>
            <div className="logo-version mono">v9 TESTNET</div>
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
          <NavLink to="/messages" className={({ isActive }) => `nav-btn${isActive ? ' active' : ''}`}>
            {NAV_ICONS.messages}<span>Messages</span>
          </NavLink>
          <AppsNavSection />
          <NavLink to="/settings" className={({ isActive }) => `nav-btn${isActive ? ' active' : ''}`}>
            {NAV_ICONS.settings}<span>Settings</span>
          </NavLink>
        </nav>

        <div className="sidebar-footer">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span className="pulse-dot" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 8px rgba(74,222,128,.4)', display: 'inline-block' }} />
            <span style={{ color: 'var(--green)', fontWeight: 600 }}>Online</span>
            <span className="mono" style={{ color: 'var(--text-dim)', marginLeft: 'auto', fontSize: 10 }}>14 peers</span>
          </div>
          <div className="mono" style={{ color: 'var(--text-dim)', fontSize: 10 }}>Base Sepolia · syncing…</div>
        </div>
      </aside>

      <main className="main-content">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/explorer/*" element={<ExplorerPage />} />
          <Route path="/agent" element={<AgentHubPage />} />
          <Route path="/messages" element={<MessagesPage />} />
          <Route path="/apps/*" element={<AppsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/app/:appId" element={<AppHostPage apps={installedApps} />} />
        </Routes>
      </main>
      <ChatPanel />
    </div>
  );
}
