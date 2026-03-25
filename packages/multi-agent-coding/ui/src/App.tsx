import React from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { RepoProvider } from './context/RepoContext.js';
import { AppShell } from './components/AppShell.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { PrIssuePage } from './pages/PrIssuePage.js';
import { GraphExplorerPage } from './pages/GraphExplorerPage.js';
import { AgentsPage } from './pages/CollaborationPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import './styles.css';

export function App() {
  return (
    <HashRouter>
      <RepoProvider>
        <AppShell>
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/prs" element={<PrIssuePage />} />
            <Route path="/graph" element={<GraphExplorerPage />} />
            <Route path="/collaboration" element={<AgentsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AppShell>
      </RepoProvider>
    </HashRouter>
  );
}
