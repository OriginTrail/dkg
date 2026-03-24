import React, { type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useRepo, repoKey } from '../context/RepoContext.js';

const TABS = [
  { to: '/', label: 'Overview' },
  { to: '/prs', label: 'PRs & Issues' },
  { to: '/graph', label: 'Graph Explorer' },
  { to: '/agents', label: 'Agents' },
  { to: '/settings', label: 'Settings' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { repos, selectedRepo, selectRepo, loading } = useRepo();
  const navigate = useNavigate();

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
        <div className="repo-selector">
          {loading ? (
            <span className="repo-selector-loading">Loading repos...</span>
          ) : repos.length === 0 ? (
            <button className="btn btn-small btn-secondary" onClick={() => navigate('/settings')}>
              Add Repository
            </button>
          ) : (
            <select
              className="repo-select"
              value={selectedRepo ? repoKey(selectedRepo) : ''}
              onChange={e => selectRepo(e.target.value)}
            >
              {repos.map(r => {
                const key = repoKey(r);
                const privacy = r.paranetId ? 'shared' : 'local';
                return (
                  <option key={key} value={key}>
                    {key} {privacy === 'shared' ? '(shared)' : '(local)'}
                  </option>
                );
              })}
            </select>
          )}
          {selectedRepo && (
            <span className={`repo-privacy-badge repo-privacy-${selectedRepo.paranetId ? 'shared' : 'local'}`}>
              {selectedRepo.paranetId ? 'Shared' : 'Local'}
            </span>
          )}
          {selectedRepo && (
            <span className={`repo-sync-dot ${selectedRepo.syncEnabled ? 'sync-active' : 'sync-inactive'}`}
              title={selectedRepo.syncEnabled ? 'Sync enabled' : 'Sync disabled'}
            />
          )}
        </div>
      </header>
      <main className="app-main">
        {children}
      </main>
    </div>
  );
}
