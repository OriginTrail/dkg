import { useState } from 'react';
import { StoreProvider, useStore } from './store';
import { NetworkGraph } from './components/NetworkGraph';
import { ControlPanel } from './components/ControlPanel';
import { ActivityFeed } from './components/ActivityFeed';
import { StatsDashboard } from './components/StatsDashboard';

type Page = 'simulator' | 'stats';

function AppInner() {
  const { state, dispatch } = useStore();
  const [page, setPage] = useState<Page>('simulator');

  const onlineCount = state.nodes.filter((n) => n.online).length;
  const selected = state.nodes.find((n) => n.id === state.selectedNode);

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1 className="logo">
            <span className="logo-icon">◆</span> DKG Network Simulator
          </h1>
          <nav className="header-nav">
            <button
              className={`nav-tab ${page === 'simulator' ? 'active' : ''}`}
              onClick={() => setPage('simulator')}
            >
              Simulator
            </button>
            <button
              className={`nav-tab ${page === 'stats' ? 'active' : ''}`}
              onClick={() => setPage('stats')}
            >
              Stats
            </button>
          </nav>
          <span className="header-badge">
            {state.networkMode === 'testnet' ? 'TESTNET' : 'DEVNET'}
            {' '}&middot;{' '}
            {onlineCount}/{state.nodes.length} nodes online
          </span>
        </div>
        <div className="header-right">
          {selected && (
            <div className="selected-info">
              <span className={`status-dot ${selected.online ? 'online' : 'offline'}`} />
              <span className="selected-name">{selected.name}</span>
              {selected.status && (
                <span className="selected-detail">
                  {selected.status.peerId?.slice(0, 12) ?? '—'}... | {selected.status.connectedPeers ?? 0} peers
                </span>
              )}
            </div>
          )}
        </div>
      </header>

      <main className="app-main" style={{ display: page === 'simulator' ? undefined : 'none' }}>
        <aside className="sidebar">
          <ControlPanel />
        </aside>
        <section className="graph-area">
          <NetworkGraph
            nodes={state.nodes}
            animations={state.animations}
            selectedNode={state.selectedNode}
            onSelectNode={(id) => dispatch({ type: 'SELECT_NODE', id })}
          />
        </section>
        <aside className="feed-area">
          <ActivityFeed activities={state.activities} />
        </aside>
      </main>
      <main className="app-main stats-page" style={{ display: page === 'stats' ? undefined : 'none' }}>
        <StatsDashboard />
      </main>
    </div>
  );
}

export function App() {
  return (
    <StoreProvider>
      <AppInner />
    </StoreProvider>
  );
}
