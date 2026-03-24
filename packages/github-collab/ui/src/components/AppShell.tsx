import React, { type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

const TABS = [
  { to: '/', label: 'Overview' },
  { to: '/prs', label: 'PRs & Issues' },
  { to: '/graph', label: 'Graph Explorer' },
  { to: '/agents', label: 'Agents' },
  { to: '/settings', label: 'Settings' },
];

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">GitHub Collaboration</h1>
        <nav className="tab-nav">
          {TABS.map(tab => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.to === '/'}
              className={({ isActive }) => `tab-item ${isActive ? 'active' : ''}`}
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="app-main">
        {children}
      </main>
    </div>
  );
}
