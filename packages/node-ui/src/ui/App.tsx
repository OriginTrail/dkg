import React, { useEffect, useState } from 'react';
import { Routes, Route, NavLink } from 'react-router-dom';
import { DashboardPage } from './pages/Dashboard.js';
import { NetworkPage } from './pages/Network.js';
import { OperationsPage } from './pages/Operations.js';
import { ExplorerPage } from './pages/Explorer.js';
import { WalletPage } from './pages/Wallet.js';
import { IntegrationsPage } from './pages/Integrations.js';
import { MessagesPage } from './pages/Messages.js';
import { AppHostPage, type InstalledApp } from './pages/AppHost.js';
import { ChatPanel } from './components/ChatPanel.js';
import { ParticleSphere } from './components/ParticleSphere.js';
import { BackgroundNetwork } from './components/BackgroundNetwork.js';

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

export function App() {
  const installedApps = useInstalledApps();

  return (
    <div className="app-layout">
      <BackgroundNetwork />
      <aside className="sidebar">
        <div className="sidebar-logo">
          <ParticleSphere size={48} />
          <div>DKG Node <span>UI</span></div>
        </div>
        <nav className="sidebar-nav">
          <NavLink to="/" end>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1L1 6v9h5v-4h4v4h5V6L8 1z"/></svg>
            Dashboard
          </NavLink>
          <NavLink to="/network">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="4" cy="4" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="8" cy="12" r="2"/><line x1="4" y1="6" x2="8" y2="10" stroke="currentColor" strokeWidth="1.5"/><line x1="12" y1="6" x2="8" y2="10" stroke="currentColor" strokeWidth="1.5"/></svg>
            Network
          </NavLink>
          <NavLink to="/messages">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2h14v9H5l-4 3V2zm2 2v5.17l1.59-1.59.41-.58H13V4H3z"/></svg>
            Messages
          </NavLink>
          <NavLink to="/explorer">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6 1a5 5 0 014.32 7.5l3.59 3.59-1.42 1.42-3.59-3.59A5 5 0 116 1zm0 2a3 3 0 100 6 3 3 0 000-6z"/></svg>
            Explorer
          </NavLink>
          <NavLink to="/operations">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h12v2H2V2zm0 4h12v2H2V6zm0 4h8v2H2v-2z"/></svg>
            Operations
          </NavLink>
          <NavLink to="/wallet">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 14h14v1H1v-1zM3 8l3-3 2 2 4-5 1.5 1.2L9 9 7 7l-3 3z"/><path d="M2 2h12v1H2V2zm0 3h12v8H2V5zm1 1v6h10V6H3z" opacity=".3"/></svg>
            Economics
          </NavLink>
          <NavLink to="/integrations">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h4v4H2V2zm8 0h4v4h-4V2zM2 10h4v4H2v-4zm8 0h4v4h-4v-4z"/></svg>
            Integrations
          </NavLink>
          {installedApps.length > 0 && (
            <>
              <div className="sidebar-section-label">Apps</div>
              {installedApps.map(app => (
                <NavLink key={app.id} to={`/app/${app.id}`}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3 1h10a2 2 0 012 2v10a2 2 0 01-2 2H3a2 2 0 01-2-2V3a2 2 0 012-2zm0 2v10h10V3H3z"/></svg>
                  {app.label}
                </NavLink>
              ))}
            </>
          )}
        </nav>
      </aside>
      <main className="main-content">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/network" element={<NetworkPage />} />
          <Route path="/messages" element={<MessagesPage />} />
          <Route path="/explorer/*" element={<ExplorerPage />} />
          <Route path="/operations/*" element={<OperationsPage />} />
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="/integrations" element={<IntegrationsPage />} />
          <Route path="/app/:appId" element={<AppHostPage apps={installedApps} />} />
        </Routes>
      </main>
      <ChatPanel />
    </div>
  );
}
