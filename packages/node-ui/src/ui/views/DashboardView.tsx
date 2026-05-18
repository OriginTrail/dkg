import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { Lock, Globe, HelpCircle } from 'lucide-react';
import { useFetch } from '../hooks.js';
import { api } from '../api-wrapper.js';
import { listParticipants } from '../api.js';
import { useTabsStore } from '../stores/tabs.js';
import { useProjectsStore, type ContextGraph } from '../stores/projects.js';
import { useMyContextGraphs } from '../hooks/useMyContextGraphs.js';
import { useMemoryEntities } from '../hooks/useMemoryEntities.js';
import {
  canonicalAgentDid,
  normalizeAccessPolicy,
  type AgentSidebarIdentity,
} from '../lib/contextGraphSidebar.js';

const CG_DEFINITION =
  'A Context Graph is a scoped knowledge domain with configurable access and ' +
  'governance — keep it private, open it to specific peers, or require on-chain ' +
  'group consensus before anything is finalized.';

// Memory-layer palette + labels. Colours are the shared CSS-var tokens
// (NOT raw hex) so they remap correctly in light theme — keep in sync
// with MemoryStackView so the dashboard reads as the same system.
const LAYERS = [
  { key: 'wm', label: 'Working Memory', short: 'WM', color: 'var(--layer-working)' },
  { key: 'swm', label: 'Shared Working Memory', short: 'SWM', color: 'var(--layer-shared)' },
  { key: 'vm', label: 'Verified Memory', short: 'VM', color: 'var(--layer-verified)' },
] as const;

interface LayerCounts { wm: number; swm: number; vm: number; total: number }
interface CgReport {
  entities: LayerCounts;
  triples: LayerCounts;
  agents: string[]; // canonical agent DIDs collaborating on this CG
  sizeLoading: boolean;
  sizeError: boolean;
  agentsLoading: boolean;
  agentsError: boolean;
  // Full-fidelity change key: per-layer counts + sorted agent ids +
  // every flag. The parent dedups on this so a WM→SWM/VM promotion
  // (totals unchanged) or an agent swap (count unchanged) still
  // refreshes the cards instead of going stale (Codex).
  sig: string;
}

// Compact number: 1234 → "1.2k", 4500000 → "4.5M". Keeps list/stat
// columns narrow and scannable (ux-lead).
function abbrev(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`.replace('.0', '');
  return `${(n / 1_000_000).toFixed(1)}M`.replace('.0', '');
}

function StatCard({
  label, value, sub, accentColor, children,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  accentColor?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="stat-card">
      {accentColor && <div className="accent" style={{ background: accentColor }} />}
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {children}
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

// 3-segment proportion bar (WM/SWM/VM). A 1px inter-segment + track
// outline keeps the light-theme WM segment legible (its remapped token
// fails 3:1 non-text on its own — ui-lead). Exact counts on hover.
function LayerBar({ counts }: { counts: LayerCounts }) {
  const sum = counts.wm + counts.swm + counts.vm;
  const title = LAYERS.map((l) => `${l.short} ${counts[l.key]}`).join(' · ');
  return (
    <div className="v10-layerbar" title={title} aria-label={title}>
      {sum === 0 ? (
        <span className="v10-layerbar-empty" />
      ) : (
        LAYERS.map((l) => {
          const pct = (counts[l.key] / sum) * 100;
          if (pct <= 0) return null;
          return (
            <span
              key={l.key}
              className="v10-layerbar-seg"
              style={{ width: `${pct}%`, background: l.color }}
            />
          );
        })
      )}
    </div>
  );
}

function LayerLegend() {
  return (
    <div className="v10-layer-legend">
      {LAYERS.map((l) => (
        <span key={l.key} className="v10-layer-legend-item" title={l.label}>
          <span className="v10-layer-legend-dot" style={{ background: l.color }} />
          {l.short}
        </span>
      ))}
    </div>
  );
}

// One row of the My Context Graphs list. Also the single data probe for
// this CG: it owns exactly one useMemoryEntities + one listParticipants
// and reports its numbers up so the top cards aggregate without a second
// fetch (mirrors MemoryStackView's per-row fan-out).
function CgRow({
  cg, identity, onReport, onOpen,
}: {
  cg: ContextGraph;
  identity: AgentSidebarIdentity | null;
  onReport: (id: string, r: CgReport) => void;
  onOpen: (cg: ContextGraph) => void;
}) {
  const mem = useMemoryEntities(cg.id);
  const [agents, setAgents] = useState<string[] | null>(null);
  const [agentsError, setAgentsError] = useState(false);
  const agentsLoading = agents === null && !agentsError;

  useEffect(() => {
    let mounted = true;
    setAgents(null);
    setAgentsError(false);
    listParticipants(cg.id)
      .then((r) => { if (mounted) setAgents((r.allowedAgents ?? []).map(canonicalAgentDid)); })
      // Distinguish "failed" from "zero collaborators": keep agents
      // null and flag the error so the parent excludes this CG from
      // the unique-agent union rather than silently counting it as 0
      // (Codex).
      .catch(() => { if (mounted) setAgentsError(true); });
    return () => { mounted = false; };
  }, [cg.id]);

  const entities: LayerCounts = {
    wm: mem.counts.wm, swm: mem.counts.swm, vm: mem.counts.vm, total: mem.counts.total,
  };
  const triples: LayerCounts = useMemo(() => {
    let wm = 0, swm = 0, vm = 0;
    for (const t of mem.allTriples) {
      if (t.layer === 'working') wm++;
      else if (t.layer === 'shared') swm++;
      else if (t.layer === 'verified') vm++;
    }
    return { wm, swm, vm, total: mem.allTriples.length };
  }, [mem.allTriples]);

  const sig = [
    mem.loading ? 1 : 0, mem.error ? 1 : 0, agentsLoading ? 1 : 0, agentsError ? 1 : 0,
    entities.wm, entities.swm, entities.vm, entities.total,
    triples.wm, triples.swm, triples.vm, triples.total,
    agents ? agents.slice().sort().join(',') : '∅',
  ].join('|');

  useEffect(() => {
    onReport(cg.id, {
      entities,
      triples,
      agents: agents ?? [],
      sizeLoading: mem.loading,
      sizeError: Boolean(mem.error),
      agentsLoading,
      agentsError,
      sig,
    });
    // Depend on the full `sig` (not coarse totals) so a per-layer
    // promotion or an agent-id swap still re-reports (Codex).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cg.id, sig]);

  const policy = normalizeAccessPolicy(cg.accessPolicy);
  const typeLabel = policy === 'private' ? 'Curated' : policy === 'public' ? 'Public' : 'Unknown';
  const isCurator = Boolean(
    cg.curator?.trim() && identity?.agentDid?.trim() &&
    canonicalAgentDid(cg.curator) === canonicalAgentDid(identity.agentDid),
  );

  return (
    <button className="v10-cg-row" onClick={() => onOpen(cg)}>
      <span className="v10-cg-cell v10-cg-name">{cg.name || cg.id.slice(0, 16)}</span>
      <span
        className="v10-cg-cell v10-cg-type"
        title={`${typeLabel} context graph`}
        aria-label={`${typeLabel} context graph`}
      >
        {policy === 'private'
          ? <Lock size={13} aria-hidden="true" />
          : policy === 'public'
            ? <Globe size={13} aria-hidden="true" />
            : <span className="v10-cg-dim">—</span>}
      </span>
      <span className="v10-cg-cell v10-cg-size">
        {mem.loading && agents === null
          ? <span className="v10-cg-dim">loading…</span>
          : mem.error
            ? <span className="v10-cg-dim" title={mem.error}>—</span>
            : <>{abbrev(entities.total)} <span className="v10-cg-dim">entities</span> · {abbrev(triples.total)} <span className="v10-cg-dim">triples</span></>}
      </span>
      <span className="v10-cg-cell v10-cg-agents">
        {agents === null ? <span className="v10-cg-dim">—</span> : agents.length}
      </span>
      <span className="v10-cg-cell v10-cg-role">
        <span className={`v10-cg-badge v10-cg-badge-${isCurator ? 'curator' : 'joined'}`}>
          {isCurator ? 'CURATOR' : 'JOINED'}
        </span>
      </span>
    </button>
  );
}

const ZERO: LayerCounts = { wm: 0, swm: 0, vm: 0, total: 0 };

export function DashboardView() {
  const { data: status } = useFetch(api.fetchStatus, [], 10_000);
  const { data: econ } = useFetch(api.fetchEconomics, [], 60_000);
  const { openTab } = useTabsStore();
  const { setActiveProject } = useProjectsStore();
  const { myCgs, identity } = useMyContextGraphs();

  const [reports, setReports] = useState<Record<string, CgReport>>({});
  const onReport = useCallback((id: string, r: CgReport) => {
    setReports((prev) => {
      if (prev[id]?.sig === r.sig) return prev;
      return { ...prev, [id]: r };
    });
  }, []);

  // Drop reports for CGs no longer in the membership set so `reports`
  // doesn't accumulate orphaned entries across hide/unhide cycles
  // (qa-lead). The aggregate already iterates `myCgs` so this is
  // memory hygiene, not a correctness fix — guarded to avoid a loop.
  useEffect(() => {
    const ids = new Set(myCgs.map((c) => c.id));
    setReports((prev) => {
      const keys = Object.keys(prev);
      if (keys.every((k) => ids.has(k))) return prev;
      const next: Record<string, CgReport> = {};
      for (const k of keys) if (ids.has(k)) next[k] = prev[k];
      return next;
    });
  }, [myCgs]);

  const agg = useMemo(() => {
    const entities = { ...ZERO };
    const triples = { ...ZERO };
    const agentSet = new Set<string>();
    // Size and agents track their own loading/partial state so a
    // participant refetch doesn't make the unrelated Size card flash
    // "loading…" and vice-versa (qa-lead). A missing report counts as
    // both still loading.
    let sizeLoading = false;
    let agentsLoading = false;
    let sizePartial = false;
    let agentsPartial = false;
    for (const cg of myCgs) {
      const r = reports[cg.id];
      if (!r) { sizeLoading = true; agentsLoading = true; continue; }
      if (r.sizeLoading) sizeLoading = true;
      if (r.agentsLoading) agentsLoading = true;
      if (r.sizeError) sizePartial = true;
      if (r.agentsError) agentsPartial = true;
      for (const k of ['wm', 'swm', 'vm', 'total'] as const) {
        entities[k] += r.entities[k];
        triples[k] += r.triples[k];
      }
      // Exclude CGs whose participant probe failed from the unique
      // count — they're "unknown", not "zero" (Codex); agentsPartial
      // surfaces that the total may be undercounting.
      if (!r.agentsError) for (const a of r.agents) agentSet.add(a);
    }
    const hasCgs = myCgs.length > 0;
    return {
      entities, triples,
      agentCount: agentSet.size,
      sizeLoading: hasCgs && sizeLoading,
      agentsLoading: hasCgs && agentsLoading,
      sizePartial,
      agentsPartial,
      hasCgs,
    };
  }, [myCgs, reports]);

  const latestPeriod = econ?.periods?.[0];
  const spending = latestPeriod
    ? `${latestPeriod.publishCount} publishes · ${latestPeriod.totalTrac.toFixed(2)} TRAC`
    : '—';

  const sizeValue = !agg.hasCgs
    ? '—'
    : agg.sizeLoading
      ? <span className="v10-cg-dim">loading…</span>
      : `${abbrev(agg.entities.total)} · ${abbrev(agg.triples.total)}`;

  return (
    <div className="v10-dashboard">
      <div className="v10-dash-header">
        <h1 className="v10-dash-title">Dashboard</h1>
        <p className="v10-dash-subtitle">
          {status?.name || 'DKG Node'} · {status?.networkName || 'network'}
          {/* One canonical "what is a Context Graph?" entry point for the
              whole dashboard — not a per-card tooltip (ux-lead). */}
          <span className="v10-dash-info" title={CG_DEFINITION} aria-label={CG_DEFINITION}>
            <HelpCircle size={13} aria-hidden="true" />
            <span>What is a Context Graph?</span>
          </span>
        </p>
      </div>

      <div className="v10-dash-stats v10-dash-stats-3">
        <StatCard
          label="My Context Graphs"
          value={myCgs.length}
          sub="Context graphs you created or joined."
          accentColor="var(--accent-blue)"
        />
        <StatCard
          label="Context Graph Size"
          value={sizeValue}
          accentColor="var(--accent-green)"
        >
          {agg.hasCgs && !agg.sizeLoading && (
            <div className="v10-cg-size-detail">
              <div className="v10-cg-size-metric">
                <div className="v10-cg-size-num">
                  {agg.entities.total.toLocaleString()} <span className="v10-cg-dim">entities / Knowledge Assets</span>
                </div>
                <LayerBar counts={agg.entities} />
              </div>
              <div className="v10-cg-size-metric">
                <div className="v10-cg-size-num">
                  {agg.triples.total.toLocaleString()} <span className="v10-cg-dim">triples</span>
                </div>
                <LayerBar counts={agg.triples} />
              </div>
              <LayerLegend />
            </div>
          )}
          <div className="stat-sub">
            {agg.hasCgs
              ? (agg.sizePartial
                  ? 'Some context graphs could not report size; total is partial.'
                  : 'Across Working, Shared Working & Verified Memory. Entities become Knowledge Assets once published to Verified Memory.')
              : 'No context graphs yet.'}
          </div>
        </StatCard>
        <StatCard
          label="Connected Agents"
          value={!agg.hasCgs ? '—' : agg.agentsLoading ? <span className="v10-cg-dim">loading…</span> : agg.agentCount}
          sub={agg.hasCgs && agg.agentsPartial
            ? 'Some context graphs could not report agents; count is partial.'
            : 'Unique agents collaborating with you.'}
          accentColor="var(--purple)"
        />
      </div>

      <div className="v10-dash-grid v10-dash-grid-2">
        <div className="v10-dash-section v10-dash-section-wide">
          <div className="v10-dash-section-header">
            <h3>My Context Graphs</h3>
            <span className="v10-dash-section-badge">{myCgs.length}</span>
          </div>
          {myCgs.length === 0 ? (
            <p className="v10-cg-empty">
              No context graphs yet — create or join one from the sidebar.
            </p>
          ) : (
            <>
              <div className="v10-cg-colhead">
                <span className="v10-cg-cell v10-cg-name">Name</span>
                <span className="v10-cg-cell v10-cg-type">Type</span>
                <span className="v10-cg-cell v10-cg-size">Size</span>
                <span className="v10-cg-cell v10-cg-agents">Agents</span>
                <span className="v10-cg-cell v10-cg-role">Role</span>
              </div>
              <div className="v10-cg-list">
                {myCgs.map((cg) => (
                  <CgRow
                    key={cg.id}
                    cg={cg}
                    identity={identity}
                    onReport={onReport}
                    onOpen={(c) => {
                      setActiveProject(c.id);
                      openTab({ id: `project:${c.id}`, label: c.name || c.id.slice(0, 12), closable: true });
                    }}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        <div className="v10-dash-section">
          <div className="v10-dash-section-header">
            <h3>Spending</h3>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '8px 0' }}>{spending}</p>
        </div>
      </div>
    </div>
  );
}
