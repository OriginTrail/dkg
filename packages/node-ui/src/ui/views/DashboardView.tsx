import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { Lock, Globe, Boxes, Database, Network, Wallet } from 'lucide-react';
import { useFetch } from '../hooks.js';
import { api } from '../api-wrapper.js';
import { useTabsStore } from '../stores/tabs.js';
import { useProjectsStore, type ContextGraph } from '../stores/projects.js';
import { useMyContextGraphs } from '../hooks/useMyContextGraphs.js';
import { useMemoryEntities } from '../hooks/useMemoryEntities.js';
import { useNodeEvents } from '../hooks/useNodeEvents.js';
import {
  canonicalAgentDid,
  normalizeAccessPolicy,
  type AgentSidebarIdentity,
} from '../lib/contextGraphSidebar.js';

// Concise, user-facing definition shown inside the My Context Graphs
// card (the old header "What is a Context Graph?" affordance was
// removed — ux-lead: meaning belongs with the metric, not a stray
// header link). Trimmed from the README definition.
const CG_DEFINITION =
  'A scoped knowledge domain with configurable access — keep it private, ' +
  'share with specific peers, or require on-chain group consensus.';

// Memory-layer palette + labels + concise tooltip descriptions
// (README "three memory layers" + MemoryStackView desc). Colours are
// the shared CSS-var tokens (NOT raw hex) so they remap in light theme;
// kept in sync with MemoryStackView so the dashboard reads as one system.
const LAYERS = [
  { key: 'wm', label: 'Working Memory', short: 'WM', color: 'var(--layer-working)',
    desc: 'Private agent drafts — free, self-attested, persists locally.' },
  { key: 'swm', label: 'Shared Working Memory', short: 'SWM', color: 'var(--layer-shared)',
    desc: 'Team proposals — free, gossip-replicated across context-graph peers.' },
  { key: 'vm', label: 'Verified Memory', short: 'VM', color: 'var(--layer-verified)',
    desc: 'On-chain knowledge — permanent, verified, requires TRAC to publish.' },
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
  label, value, sub, accentColor, children, icon, className,
}: {
  label: string;
  value?: React.ReactNode;
  sub?: React.ReactNode;
  accentColor?: string;
  children?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`stat-card v10-anim-mount${className ? ` ${className}` : ''}`}>
      {accentColor && <div className="accent" style={{ background: accentColor }} />}
      <div className="stat-label">{icon}{label}</div>
      {value != null && value !== '' && <div className="stat-value">{value}</div>}
      {children}
      {sub != null && sub !== '' && <div className="stat-sub">{sub}</div>}
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
              title={`${l.label} (${counts[l.key]}) — ${l.desc}`}
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
        <span key={l.key} className="v10-layer-legend-item" title={`${l.label} — ${l.desc}`}>
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
  // Dashboard alone opts into failed-vs-empty signalling; other
  // useMemoryEntities consumers keep the original empty-on-failure
  // behavior (Codex).
  const mem = useMemoryEntities(cg.id, { signalErrors: true });
  const [agents, setAgents] = useState<string[] | null>(null);
  const [agentsError, setAgentsError] = useState(false);
  const agentsLoading = agents === null && !agentsError;

  const agentsMounted = useRef(true);
  const loadParticipants = useCallback(() => {
    api.listParticipants(cg.id)
      .then((r) => {
        if (agentsMounted.current) {
          setAgents((r.allowedAgents ?? []).map(canonicalAgentDid));
          setAgentsError(false);
        }
      })
      // On failure clear `agents` back to null in addition to flagging
      // the error. Keeping the last-good array would show a STALE
      // member list/count after a failed refresh — hiding a real
      // membership removal behind the "partial" caveat. null routes
      // through effectiveAgents' error branch (curator-only fallback +
      // parent marks the total partial) instead of trusting stale data
      // (Codex).
      .catch(() => {
        if (agentsMounted.current) {
          setAgents(null);
          setAgentsError(true);
        }
      });
  }, [cg.id]);

  useEffect(() => {
    agentsMounted.current = true;
    setAgents(null);
    setAgentsError(false);
    loadParticipants();
    // 30s poll is the backstop; the node-event subscription below makes
    // join approvals/removals reflect immediately so the count isn't
    // stale for up to 30s after a membership change (Codex).
    const timer = setInterval(loadParticipants, 30_000);
    return () => { agentsMounted.current = false; clearInterval(timer); };
  }, [loadParticipants]);

  // Membership-changing events → re-probe this CG's allow-list at once.
  // Filter to the relevant event types (and this CG when the event
  // carries an id) so we don't re-fetch every row on memory/heartbeat
  // traffic.
  useNodeEvents(useCallback((event) => {
    if (event.type !== 'join_approved' && event.type !== 'join_rejected' && event.type !== 'project_synced') return;
    const evCg = (event.data as any)?.contextGraphId ?? (event.data as any)?.projectId;
    if (evCg && evCg !== cg.id) return;
    loadParticipants();
  }, [cg.id, loadParticipants]));

  // The /participants allow-list can omit the curator (and is empty on
  // fully-public graphs), so fold the CG's curator into the agent set —
  // they inherently have access and must count toward the user's
  // "unique agents with access" metric (Codex). null (loading/error)
  // stays null so the parent's unknown-vs-zero handling is preserved.
  const isPublicCg = normalizeAccessPolicy(cg.accessPolicy) === 'public';
  const effectiveAgents = useMemo(() => {
    // Public graphs have open-ended membership — the /participants
    // allow-list is not the authoritative collaborator set, and the
    // curator alone is not a meaningful count. Report "unknown" (null
    // → parent excludes it, row shows —) rather than a confidently
    // wrong concrete number, unless/until the backend can return an
    // authoritative participant count (Codex).
    if (isPublicCg) return null;
    const cur = cg.curator?.trim();
    const curDid = cur ? canonicalAgentDid(cur) : null;
    if (agents === null) {
      // Participants list unknown. On a hard /participants failure the
      // curator is still locally known and inherently has access — count
      // them so an endpoint outage doesn't undercount/zero a CG we know
      // has an agent (Codex). Pure loading (no error yet) stays null so
      // the parent keeps its loading state instead of flashing a count.
      return agentsError && curDid ? [curDid] : null;
    }
    const s = new Set(agents);
    if (curDid) s.add(curDid);
    return [...s];
  }, [agents, agentsError, cg.curator, isPublicCg]);

  // Per-CG summary asset count, with the same `assetCount ?? assets`
  // legacy-field compatibility the rest of the UI uses (PanelLeft) —
  // older daemons only return `assets` (Codex). Drives both the size
  // fallback and the per-row coarse display when the live probe fails.
  const summaryAssets = Number.isFinite((cg.assetCount ?? cg.assets) as number)
    ? ((cg.assetCount ?? cg.assets) as number)
    : 0;
  const entities: LayerCounts = useMemo(() => {
    if (mem.error) {
      // Live size probe (/api/query) unavailable — e.g. mock/offline
      // mode, where the dashboard is intentionally served through
      // api-wrapper. Fall back to the per-CG summary the (mock-aware)
      // contextGraphs endpoint already returns so the card still
      // populates instead of regressing to an unavailable/0 state; no
      // layer breakdown exists in the summary (Codex). sizeError stays
      // set, so the "partial" caveat still tells the user it's coarse.
      return { wm: 0, swm: 0, vm: 0, total: summaryAssets };
    }
    // "Knowledge Assets" = distinct triple subjects. `mem.counts.total`
    // is the entity-map size, which also counts object-only link
    // targets and over-reports link-heavy graphs (Codex). Per-layer
    // wm/swm/vm stay subject-distinct and drive the proportion bar.
    const subjects = new Set(mem.allTriples.map((t) => t.subject)).size;
    return { wm: mem.counts.wm, swm: mem.counts.swm, vm: mem.counts.vm, total: subjects };
  }, [mem.error, mem.allTriples, mem.counts.wm, mem.counts.swm, mem.counts.vm, summaryAssets]);
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
    mem.loading ? 1 : 0, mem.error ? 1 : 0, mem.partial ? 1 : 0, agentsLoading ? 1 : 0, agentsError ? 1 : 0,
    entities.wm, entities.swm, entities.vm, entities.total,
    triples.wm, triples.swm, triples.vm, triples.total,
    effectiveAgents ? effectiveAgents.slice().sort().join(',') : '∅',
  ].join('|');

  useEffect(() => {
    onReport(cg.id, {
      entities,
      triples,
      agents: effectiveAgents ?? [],
      sizeLoading: mem.loading,
      // Both a total failure (mem.error → entities fell back to the
      // summary count) and a partial failure (mem.partial → some
      // layers missing) make the size total inexact, so both must
      // light the aggregate's "partial" caveat (Codex).
      sizeError: Boolean(mem.error) || mem.partial,
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
        {mem.loading
          ? <span className="v10-cg-dim">loading…</span>
          : mem.error
            ? (
              // Live size unavailable: show the coarse summary count
              // (same value the aggregate card uses) rather than a
              // bare — so the row isn't empty while the card is
              // populated; triples have no summary fallback (Codex).
              <span title="Live size unavailable — showing the context-graph summary count">
                {abbrev(entities.total)} <span className="v10-cg-dim">entities</span> · <span className="v10-cg-dim">— triples</span>
              </span>
            )
            : mem.partial
              ? (
                // Some (not all) memory layers failed — the counts are
                // a lower bound, not exact. Mark with a "~" + tooltip so
                // the row doesn't silently undercount (Codex).
                <span title="Partial — one or more memory layers were unavailable; counts are a lower bound">
                  ~{abbrev(entities.total)} <span className="v10-cg-dim">entities</span> · ~{abbrev(triples.total)} <span className="v10-cg-dim">triples</span>
                </span>
              )
              : <>{abbrev(entities.total)} <span className="v10-cg-dim">entities</span> · {abbrev(triples.total)} <span className="v10-cg-dim">triples</span></>}
      </span>
      <span className="v10-cg-cell v10-cg-agents">
        {effectiveAgents === null ? <span className="v10-cg-dim">—</span> : effectiveAgents.length}
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
  const { data: wb, loading: wbLoading, error: wbError } = useFetch(api.fetchWalletsBalances, [], 30_000);
  const { openTab } = useTabsStore();
  const { setActiveProject } = useProjectsStore();
  const { myCgs, identity, identityLoading } = useMyContextGraphs();
  // Older daemons with no `callerInvolved` resolve membership only once
  // the agent identity (curator-DID fallback) arrives. Until then an
  // empty list is "not known yet", not a real zero — show a loading
  // state rather than a false "0 / No context graphs yet" flash (Codex).
  const cgsResolving = identityLoading && myCgs.length === 0;

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
      // Always union whatever agents the row knows. `r.agents` already
      // carries only known DIDs: the full set on success, just the
      // curator fallback on a participant-probe failure, [] while
      // loading. Skipping the row on error would cancel that fallback
      // and drop the curator to 0; `agentsPartial` still surfaces that
      // the total may be undercounting (Codex).
      for (const a of r.agents) agentSet.add(a);
    }
    const hasCgs = myCgs.length > 0;
    return {
      entities, triples,
      agentCount: agentSet.size,
      sizeLoading: hasCgs && sizeLoading,
      agentsLoading: hasCgs && agentsLoading,
      sizePartial,
      agentsPartial,
      // Entities can fall back to the `cg.assetCount` summary when the
      // live query fails, but there is no triple count in that summary.
      // If every size-bearing row failed, `triples.total` is a hollow 0
      // sitting next to a real entity total — show it as unknown rather
      // than a misleading exact 0 (Codex).
      triplesUnknown: hasCgs && sizePartial && triples.total === 0,
      hasCgs,
    };
  }, [myCgs, reports]);

  // Spending overview rows from the existing /api/economics periods
  // (real labels: 24h/7d/30d/all). No backend change; "Last hr" was
  // deferred per product decision.
  const SPEND_ROWS = [
    { label: '24h', display: 'Last 24h' },
    { label: '7d', display: 'Last 7d' },
    { label: '30d', display: 'Last 30d' },
  ] as const;
  // Grouped thousands, no decimals at scale (TRAC balances/spend run
  // large); ≤2 decimals under 1000 so small balances stay legible (ui-lead).
  const fmtTrac = (v: string | number) => {
    // Empty/whitespace/nullish input is missing data, not a real zero
    // balance — show an em-dash, not a misleading "0" (qa-lead).
    if (v == null || (typeof v === 'string' && v.trim() === '')) return '—';
    const n = Number(v);
    if (!isFinite(n)) return String(v);
    return n.toLocaleString(undefined, { maximumFractionDigits: n >= 1000 ? 0 : 2 });
  };
  const spendingRows = SPEND_ROWS.map((r) => {
    const p = econ?.periods?.find((x) => x.label === r.label);
    return {
      display: r.display,
      publishes: p ? String(p.publishCount) : '—',
      trac: p ? fmtTrac(p.totalTrac) : '—',
    };
  });

  const walletSym = wb?.symbol || 'TRAC';
  const walletRows = wb?.balances ?? [];
  const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);


  return (
    <div className="v10-dashboard">
      <div className="v10-dash-header">
        <h1 className="v10-dash-title">Dashboard</h1>
        <p className="v10-dash-subtitle">
          {status?.name || 'DKG Node'} · {status?.networkName || 'network'}
        </p>
      </div>

      <div className="v10-dash-stats v10-dash-stats-3">
        <StatCard
          label="My Context Graphs"
          icon={<Boxes size={13} aria-hidden />}
          value={cgsResolving ? <span className="v10-cg-dim">loading…</span> : myCgs.length}
          accentColor="var(--accent-blue)"
          sub={
            <>
              Context graphs you created or joined.
              <span className="v10-cg-defn">{CG_DEFINITION}</span>
            </>
          }
        />
        <StatCard
          label="Context Graph Size"
          icon={<Database size={13} aria-hidden />}
          className="v10-size-card"
          accentColor="var(--accent-green)"
        >
          {!agg.hasCgs ? (
            <div className="v10-cg-size-empty v10-cg-dim">—</div>
          ) : agg.sizeLoading ? (
            <div className="v10-cg-size-empty v10-cg-dim">loading…</div>
          ) : (
            <div className="v10-cg-size-detail">
              <div className="v10-cg-size-metric">
                <div className="v10-cg-size-num">
                  <span className="v10-cg-size-big">{agg.entities.total.toLocaleString()}</span>
                  {agg.triplesUnknown ? (
                    // Pure fallback: the live entity probe was
                    // unavailable so this number is the published
                    // Knowledge-Asset summary, NOT the all-layer
                    // entity count — different unit, label it
                    // explicitly rather than silently (Codex).
                    <span
                      className="v10-cg-dim"
                      title="Live entity count unavailable — showing the published Knowledge-Asset summary (not the full WM/SWM/VM entity total)"
                    >
                      Knowledge Assets (summary)
                    </span>
                  ) : (
                    <span className="v10-cg-dim">entities / Knowledge Assets</span>
                  )}
                </div>
                {agg.triplesUnknown ? null : <LayerBar counts={agg.entities} />}
              </div>
              <div className="v10-cg-size-metric">
                <div className="v10-cg-size-num">
                  <span className="v10-cg-size-big">
                    {agg.triplesUnknown ? '—' : agg.triples.total.toLocaleString()}
                  </span>
                  <span className="v10-cg-dim">triples</span>
                </div>
                {agg.triplesUnknown ? null : <LayerBar counts={agg.triples} />}
              </div>
              <LayerLegend />
            </div>
          )}
          <div className="stat-sub">
            {agg.hasCgs
              ? (agg.sizePartial
                  ? 'Some context graphs could not report size; total is partial.'
                  : 'Totals across all your context graphs, summed over Working, Shared Working & Verified Memory. Entities become Knowledge Assets once published to Verified Memory.')
              : 'No context graphs yet.'}
          </div>
        </StatCard>
        <StatCard
          label="Collaborating Agents"
          icon={<Network size={13} aria-hidden />}
          value={!agg.hasCgs ? '—' : agg.agentsLoading ? <span className="v10-cg-dim">loading…</span> : agg.agentCount}
          sub={!agg.hasCgs
            ? 'No context graphs yet.'
            : agg.agentsPartial
              ? 'Some context graphs could not report agents; count is partial.'
              : 'Unique agents allow-listed and collaborating across your context graphs.'}
          accentColor="var(--purple)"
        />
      </div>

      <div className="v10-dash-grid v10-dash-grid-2">
        <div className="v10-dash-section v10-dash-section-wide v10-anim-mount">
          <div className="v10-dash-section-header">
            <div className="v10-dash-section-title">
              <Boxes size={13} aria-hidden />
              <h3>My Context Graphs</h3>
            </div>
            <span className="v10-dash-section-badge">{myCgs.length}</span>
          </div>
          {cgsResolving ? (
            <p className="v10-cg-empty">Loading context graphs…</p>
          ) : myCgs.length === 0 ? (
            <p className="v10-cg-empty">
              No context graphs yet — create or join one from the sidebar.
            </p>
          ) : (
            <>
              <div className="v10-cg-colhead">
                <span className="v10-cg-cell v10-cg-name">Name</span>
                <span className="v10-cg-cell v10-cg-type">Type</span>
                <span className="v10-cg-cell v10-cg-size">Size</span>
                <span
                  className="v10-cg-cell v10-cg-agents"
                  title="Agents allow-listed with access to this context graph"
                >
                  Agents
                </span>
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

        <div className="v10-dash-section v10-anim-mount">
          <div className="v10-dash-section-header">
            <div className="v10-dash-section-title">
              <Wallet size={13} aria-hidden />
              <h3>Wallets and Spending</h3>
            </div>
          </div>

          <div className="v10-ws-subhead">Node wallets</div>
          {wbLoading && !wb ? (
            <p className="v10-cg-empty">Loading wallets…</p>
          ) : walletRows.length > 0 ? (
            <ul className="v10-ws-wallets">
              {walletRows.map((b) => (
                <li key={b.address} className="v10-ws-wallet">
                  <span className="v10-ws-addr" title={b.address}>{shortAddr(b.address)}</span>
                  <span className="v10-ws-balcol">
                    <span className="v10-ws-bal">
                      {fmtTrac(b.trac)} <span className="v10-cg-dim">{walletSym}</span>
                    </span>
                    <span className="v10-ws-bal-sec">{b.eth} ETH</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (wb?.wallets?.length ?? 0) > 0 ? (
            <ul className="v10-ws-wallets">
              {(wb?.wallets ?? []).map((a) => (
                <li key={a} className="v10-ws-wallet">
                  <span className="v10-ws-addr" title={a}>{shortAddr(a)}</span>
                  <span className="v10-cg-dim">—</span>
                </li>
              ))}
            </ul>
          ) : wb?.error || wbError ? (
            // `wb.error` = API-level error field; `wbError` = the fetch
            // itself rejected (network/auth/RPC) so `wb` is null. Both
            // mean "unavailable", not "no wallets" (Codex).
            <p className="v10-cg-empty">Wallet balances unavailable.</p>
          ) : (
            <p className="v10-cg-empty">No node wallets found.</p>
          )}
          {/* Surface a chain/RPC error even when (possibly stale) balances
              or addresses are still shown — mirrors the agentsPartial
              caveat pattern; without this the error is swallowed (qa-lead). */}
          {(wb?.error || wbError) && (walletRows.length > 0 || (wb?.wallets?.length ?? 0) > 0) ? (
            <p className="v10-ws-note">Balances may be stale — the chain/RPC reported an error.</p>
          ) : null}

          <div className="v10-ws-subhead">Spending</div>
          <div className="v10-ws-spend">
            <div className="v10-ws-spend-head">
              <span>Period</span>
              <span>Publishes</span>
              {/* economics totalTrac is always TRAC-denominated, independent
                  of the node wallet token symbol — label it literally. */}
              <span>TRAC</span>
            </div>
            {spendingRows.map((r) => (
              <div key={r.display} className="v10-ws-spend-row">
                <span className="v10-cg-dim">{r.display}</span>
                <span className="v10-ws-spend-val">{r.publishes}</span>
                <span className="v10-ws-spend-val">{r.trac}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
