import React, { useState } from 'react';
import { useFetch } from '../hooks.js';
import { api } from '../api-wrapper.js';
import { useTabsStore } from '../stores/tabs.js';
import { useProjectsStore } from '../stores/projects.js';
import { CreateProjectModal } from '../components/Modals/CreateProjectModal.js';
import { ImportFilesModal } from '../components/Modals/ImportFilesModal.js';

function StatCard({ label, value, sub, accentColor }: { label: string; value: string | number; sub?: string; accentColor?: string }) {
  return (
    <div className="stat-card">
      {accentColor && <div className="accent" style={{ background: accentColor }} />}
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function QuickAction({ icon, label, onClick }: { icon: string; label: string; onClick?: () => void }) {
  return (
    <button className="v10-quick-action" onClick={onClick}>
      <span className="v10-quick-action-icon">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function RecentOp({ op }: { op: any }) {
  const type = op.name || op.type || '—';
  const status = op.status || 'unknown';
  const statusColor = status === 'completed' ? 'var(--accent-green)' : status === 'failed' ? 'var(--accent-red)' : 'var(--accent-amber)';
  const time = op.startedAt ? new Date(op.startedAt).toLocaleTimeString() : '—';

  return (
    <div className="v10-recent-op">
      <span className="v10-recent-op-type">{type}</span>
      <span className="v10-recent-op-status" style={{ color: statusColor }}>{status}</span>
      <span className="v10-recent-op-time">{time}</span>
    </div>
  );
}

export function DashboardView() {
  const { data: status } = useFetch(api.fetchStatus, [], 10_000);
  const { data: metrics } = useFetch(api.fetchMetrics, [], 10_000);
  const { data: cgData } = useFetch(api.fetchContextGraphs, [], 30_000);
  const { data: agentData } = useFetch(api.fetchAgents, [], 15_000);
  const { data: opsData } = useFetch(() => api.fetchOperationsWithPhases({ limit: '6' }), [], 10_000);
  const { data: econ } = useFetch(api.fetchEconomics, [], 60_000);
  const { openTab } = useTabsStore();
  const { setActiveProject } = useProjectsStore();
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [showImportFiles, setShowImportFiles] = useState(false);

  const totalKCs = metrics?.total_kcs ?? metrics?.totalKnowledgeCollections ?? 0;
  const peers = status?.connectedPeers ?? status?.peerCount ?? 0;
  const agents = agentData?.agents?.length ?? 0;
  const contextGraphCount = cgData?.contextGraphs?.length ?? 0;
  const ops = opsData?.operations ?? [];

  const latestPeriod = econ?.periods?.[0];
  const spending = latestPeriod
    ? `${latestPeriod.publishCount} publishes · ${latestPeriod.totalTrac.toFixed(2)} TRAC`
    : '—';

  return (
    <div className="v10-dashboard">
      <div className="v10-dash-header">
        <h1 className="v10-dash-title">Dashboard</h1>
        <p className="v10-dash-subtitle">
          {status?.name || 'DKG Node'} · {status?.networkName || 'network'}
        </p>
      </div>

      <div className="v10-dash-stats">
        <StatCard label="Knowledge Assets" value={totalKCs} accentColor="var(--accent-green)" />
        <StatCard label="Context Graphs" value={contextGraphCount} accentColor="var(--accent-blue)" />
        <StatCard label="Connected Peers" value={peers} accentColor="var(--accent-amber)" />
        <StatCard label="Agents" value={agents} accentColor="var(--purple)" />
      </div>

      <div className="v10-dash-grid">
        <div className="v10-dash-section">
          <div className="v10-dash-section-header">
            <h3>Quick Actions</h3>
          </div>
          <div className="v10-quick-actions">
            <QuickAction icon="+" label="Create Project" onClick={() => setShowCreateProject(true)} />
            <QuickAction icon="↑" label="Import Memories" onClick={() => {
              const cgs = cgData?.contextGraphs ?? [];
              if (cgs.length > 0) {
                setShowImportFiles(true);
              } else {
                setShowCreateProject(true);
              }
            }} />
            <QuickAction icon="⟐" label="Run SPARQL" onClick={() => openTab({ id: 'sparql', label: 'SPARQL', closable: true })} />
            <QuickAction icon="⬡" label="Browse Graph" onClick={() => openTab({ id: 'explorer', label: 'Explorer', closable: true })} />
          </div>
        </div>

        <div className="v10-dash-section">
          <div className="v10-dash-section-header">
            <h3>Recent Operations</h3>
            <button
              className="v10-dash-section-link"
              onClick={() => openTab({ id: 'operations', label: 'Operations', closable: true })}
            >
              View all →
            </button>
          </div>
          <div className="v10-recent-ops">
            {ops.length === 0 ? (
              <p style={{ color: 'var(--text-tertiary)', fontSize: 12, padding: '12px 0' }}>No recent operations</p>
            ) : (
              ops.slice(0, 6).map((op: any, i: number) => <RecentOp key={op.id ?? i} op={op} />)
            )}
          </div>
        </div>

        <div className="v10-dash-section">
          <div className="v10-dash-section-header">
            <h3>Projects</h3>
            <span className="v10-dash-section-badge">{contextGraphCount}</span>
          </div>
          <div className="v10-dash-projects">
            {(cgData?.contextGraphs ?? []).slice(0, 5).map((cg: any) => (
              <button
                key={cg.id}
                className="v10-dash-project-card"
                onClick={() => {
                  setActiveProject(cg.id);
                  openTab({ id: `project:${cg.id}`, label: cg.name || cg.id.slice(0, 12), closable: true });
                }}
              >
                <span className="v10-dash-project-name">{cg.name || cg.id.slice(0, 12)}</span>
                <span className="v10-dash-project-count">{cg.assetCount ?? cg.assets ?? 0} assets</span>
              </button>
            ))}
          </div>
        </div>

        <div className="v10-dash-section">
          <div className="v10-dash-section-header">
            <h3>Spending</h3>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '8px 0' }}>{spending}</p>
        </div>
      </div>

      <CreateProjectModal open={showCreateProject} onClose={() => setShowCreateProject(false)} />
      <ImportFilesModal
        open={showImportFiles}
        onClose={() => setShowImportFiles(false)}
        contextGraphId={(cgData?.contextGraphs ?? [])[0]?.id ?? ''}
        contextGraphName={(cgData?.contextGraphs ?? [])[0]?.name}
      />
    </div>
  );
}
