import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { Lock, Globe, Share2, TrendingUp, UsersRound, Wallet } from 'lucide-react';
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

// Single user-facing description shown inside the My Context Graphs
// card (one line, no separate footnote — round-2 feedback: the split
// copy + divider read as misplaced).
const CG_DEFINITION =
  'Context graphs you created or joined — scoped knowledge domains with ' +
  'configurable access (private, curated and peer-shared, or public) where ' +
  'agents build and collaborate on shared context with verifiable provenance.';

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
  // entities.total is the cg.assetCount summary substitute (live entity
  // probe failed), NOT a real WM/SWM/VM entity count — different unit.
  sizeFallback: boolean;
  agentsLoading: boolean;
  agentsError: boolean;
  // Agents genuinely not measurable from /participants (public graph:
  // open membership) — distinct from agentsError (probe failed).
  agentsUnknown: boolean;
  // Full-fidelity change key: per-layer counts + sorted agent ids +
  // every flag. The parent dedups on this so a WM→SWM/VM promotion
  // (totals unchanged) or an agent swap (count unchanged) still
  // refreshes the cards instead of going stale (Codex).
  sig: string;
}

// chainId → display name + native gas-token symbol. Only the chains
// DKG runs on; unknown ids fall back to "Chain <id>" / "ETH". The TRAC
// token symbol still comes from the wallets endpoint — this is only
// chain + gas naming (no backend change).
const CHAIN_INFO: Record<string, { name: string; gas: string }> = {
  '1': { name: 'Ethereum', gas: 'ETH' },
  '8453': { name: 'Base', gas: 'ETH' },
  '84532': { name: 'Base Sepolia', gas: 'ETH' },
  '100': { name: 'Gnosis', gas: 'xDAI' },
  '10200': { name: 'Chiado', gas: 'xDAI' },
  '2043': { name: 'NeuroWeb', gas: 'NEURO' },
  '20430': { name: 'NeuroWeb Testnet', gas: 'NEURO' },
};
function chainInfo(id: unknown): { name: string; gas: string } {
  if (id == null) return { name: 'Unknown chain', gas: 'ETH' };
  const k = String(id);
  // The daemon may return a compound id like "base:84532" (slug:chainId).
  // Try the raw string first, then the numeric suffix; fall back to a
  // human-readable "Chain <id>" rather than echoing "base:84532".
  if (CHAIN_INFO[k]) return CHAIN_INFO[k];
  const numeric = k.match(/(\d+)\s*$/)?.[1];
  if (numeric && CHAIN_INFO[numeric]) return CHAIN_INFO[numeric];
  return { name: numeric ? `Chain ${numeric}` : `Chain ${k}`, gas: 'ETH' };
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
  const summary = LAYERS.map((l) => `${l.short} ${counts[l.key]}`).join(' · ');
  // No parent `title` — each segment already carries a descriptive
  // tooltip and a parent title bleeds through the 1px gap/track edge
  // (round-3 feedback). `aria-label` keeps the bar accessible as a
  // single utterance for screen readers.
  return (
    <div className="v10-layerbar" aria-label={summary}>
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

// Single proportion bar + legend for the curator/joined split of the
// user's context graphs — mirrors the LayerBar treatment in the Size
// card so the two top cards read as one system (round-2 feedback).
function RoleBar({ curator, joined, refreshing }: { curator: number; joined: number; refreshing?: boolean }) {
  const sum = curator + joined;
  const summary = `Curator ${curator} · Joined ${joined}`;
  const CUR = 'var(--accent-green)';
  const JOIN = 'var(--text-secondary)';
  return (
    <div
      className={`v10-cg-rolesplit${refreshing ? ' is-refreshing' : ''}`}
      title={refreshing ? 'Refreshing — agent identity is being re-checked' : undefined}
      aria-busy={refreshing || undefined}
    >
      {/* No parent `title` on the bar — each segment already has its
          own descriptive tooltip and a parent title would bleed
          through the 1px gap/track edge (round-3 feedback). */}
      <div className="v10-layerbar" aria-label={summary}>
        {sum === 0 ? (
          <span className="v10-layerbar-empty" />
        ) : (
          <>
            {curator > 0 && (
              <span
                className="v10-layerbar-seg"
                title={`Curator (${curator}) — context graphs you created and curate`}
                style={{ width: `${(curator / sum) * 100}%`, background: CUR }}
              />
            )}
            {joined > 0 && (
              <span
                className="v10-layerbar-seg"
                title={`Joined (${joined}) — context graphs you joined as a member`}
                style={{ width: `${(joined / sum) * 100}%`, background: JOIN }}
              />
            )}
          </>
        )}
      </div>
      <div className="v10-layer-legend">
        <span
          className="v10-layer-legend-item"
          title="Curator — context graphs you created and curate"
        >
          <span className="v10-layer-legend-dot" style={{ background: CUR }} />Curator {curator}
        </span>
        <span
          className="v10-layer-legend-item"
          title="Joined — context graphs you joined as a member"
        >
          <span className="v10-layer-legend-dot" style={{ background: JOIN }} />Joined {joined}
        </span>
      </div>
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
  // Sequence guard: mount load, 30s poll and node-event refreshes all
  // hit the same promise chain; without this a slow older response
  // could arrive AFTER a newer one and overwrite the fresh allow-list,
  // making the agent count jump backwards after a join/remove (Codex).
  const partSeqRef = useRef(0);
  const loadParticipants = useCallback(() => {
    const seq = ++partSeqRef.current;
    api.listParticipants(cg.id)
      .then((r) => {
        if (agentsMounted.current && seq === partSeqRef.current) {
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
        if (agentsMounted.current && seq === partSeqRef.current) {
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
    mem.loading ? 1 : 0, mem.error ? 1 : 0, mem.partial ? 1 : 0, agentsLoading ? 1 : 0, agentsError ? 1 : 0, isPublicCg ? 1 : 0,
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
      sizeFallback: Boolean(mem.error),
      agentsLoading,
      agentsError,
      agentsUnknown: isPublicCg,
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
          ? <span className="v10-stat-loading">loading…</span>
          : mem.error
            ? (
              // Live size unavailable: show the coarse summary count
              // (same value the aggregate card uses) rather than a
              // bare — so the row isn't empty while the card is
              // populated; triples have no summary fallback (Codex).
              <span title="Live entity count unavailable — showing the published Knowledge-Asset summary, not the full WM/SWM/VM entity total">
                {abbrev(entities.total)} <span className="v10-cg-dim">KA (summary)</span> · <span className="v10-cg-dim">— triples</span>
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
        {effectiveAgents === null
          ? <span className="v10-cg-dim">—</span>
          : agentsError
            // Curator-only degraded fallback (/participants failed):
            // a lower bound, not authoritative — mark approximate so
            // the row matches the aggregate card's "~N" (Codex).
            ? <span title="Participant list unavailable — curator-only lower bound">~{effectiveAgents.length}</span>
            : effectiveAgents.length}
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
  const { myCgs, identity, identityLoading, cgsLoading } = useMyContextGraphs();
  // Older daemons with no `callerInvolved` resolve membership only once
  // the agent identity (curator-DID fallback) arrives. Until then an
  // empty list is "not known yet", not a real zero — show a loading
  // state rather than a false "0 / No context graphs yet" flash (Codex).
  // Suppress the "no context graphs" empty state until BOTH the
  // identity AND the first CG-list fetch have settled — on a cold load
  // one can settle before the other, briefly flashing a false empty
  // state (Codex).
  const cgsResolving = (identityLoading || cgsLoading) && myCgs.length === 0;

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
    let sizeFallbackAny = false;
    for (const cg of myCgs) {
      const r = reports[cg.id];
      if (!r) { sizeLoading = true; agentsLoading = true; continue; }
      if (r.sizeLoading) sizeLoading = true;
      if (r.agentsLoading) agentsLoading = true;
      if (r.sizeError) sizePartial = true;
      if (r.sizeFallback) sizeFallbackAny = true;
      // A public graph contributes no measurable agents — that's
      // "unknown", so the aggregate must read partial, not a confident
      // exact count that silently excludes it (Codex).
      if (r.agentsError || r.agentsUnknown) agentsPartial = true;
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
      // Any row using the assetCount summary substitute makes the
      // headline a mix of summary + live units → not a clean entity
      // total. Surfaced approximately, not as an exact figure (Codex).
      sizeApprox: hasCgs && sizeFallbackAny,
      hasCgs,
    };
  }, [myCgs, reports]);

  // Curator vs joined split for the My Context Graphs card bar — same
  // isCurator rule CgRow uses for the Role badge (round-2 feedback).
  const roleSplit = useMemo(() => {
    const myDid = identity?.agentDid?.trim() ? canonicalAgentDid(identity.agentDid) : null;
    let curator = 0, joined = 0;
    for (const cg of myCgs) {
      const isCur = Boolean(myDid && cg.curator?.trim() && canonicalAgentDid(cg.curator) === myDid);
      if (isCur) curator++; else joined++;
    }
    return { curator, joined };
  }, [myCgs, identity]);

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
          {wb?.chainId != null ? ` · ${chainInfo(wb.chainId).name}` : ''}
        </p>
      </div>

      <div className="v10-dash-stats v10-dash-stats-3">
        <StatCard
          label="My Context Graphs"
          className="v10-stat-tight"
          icon={<Share2 size={13} aria-hidden />}
          value={cgsResolving ? <span className="v10-stat-loading">loading…</span> : myCgs.length}
          accentColor="var(--accent-blue)"
          sub={CG_DEFINITION}
        >
          {agg.hasCgs && !cgsResolving ? (
            <RoleBar
              curator={roleSplit.curator}
              joined={roleSplit.joined}
              refreshing={identityLoading}
            />
          ) : null}
        </StatCard>
        <StatCard
          label="Context Graph Size"
          icon={<TrendingUp size={13} aria-hidden />}
          className="v10-stat-tight"
          accentColor="var(--accent-green)"
        >
          {!agg.hasCgs ? (
            <div className="v10-stat-empty">—</div>
          ) : agg.sizeLoading ? (
            <div className="v10-stat-loading">loading…</div>
          ) : (
            <div className="v10-cg-size-detail">
              <div className="v10-cg-size-metric">
                <div className="v10-cg-size-num">
                  <span className="v10-cg-size-big">
                    {/* Mixed (some rows on the summary fallback, some
                        live) → "~" approximate prefix; pure all-fallback
                        keeps the bare number under the explicit
                        "summary" label below (Codex). */}
                    {agg.sizeApprox && !agg.triplesUnknown ? '~' : ''}
                    {agg.entities.total.toLocaleString()}
                  </span>
                  {agg.triplesUnknown ? (
                    // Pure fallback: number is the published
                    // Knowledge-Asset summary, NOT the all-layer entity
                    // count — different unit, labelled explicitly.
                    <span
                      className="v10-cg-dim"
                      title="Live entity count unavailable — showing the published Knowledge-Asset summary (not the full WM/SWM/VM entity total)"
                    >
                      Knowledge Assets (summary)
                    </span>
                  ) : agg.sizeApprox ? (
                    <span
                      className="v10-cg-dim"
                      title="Some context graphs reported only their Knowledge-Asset summary — this total mixes summary and live counts and is approximate"
                    >
                      entities / KA · approx.
                    </span>
                  ) : (
                    <span className="v10-cg-dim">entities / Knowledge Assets</span>
                  )}
                </div>
                {/* Hide the proportion bar whenever any row fell back —
                    the WM/SWM/VM breakdown is unreliable then. */}
                {agg.triplesUnknown || agg.sizeApprox ? null : <LayerBar counts={agg.entities} />}
              </div>
              <div className="v10-cg-size-metric">
                <div className="v10-cg-size-num">
                  <span className="v10-cg-size-big">
                    {agg.triplesUnknown
                      ? '—'
                      : `${agg.sizeApprox ? '~' : ''}${agg.triples.total.toLocaleString()}`}
                  </span>
                  <span className="v10-cg-dim">triples</span>
                </div>
                {agg.triplesUnknown || agg.sizeApprox ? null : <LayerBar counts={agg.triples} />}
              </div>
              <LayerLegend />
            </div>
          )}
          <div className="stat-sub">
            {agg.hasCgs
              ? (agg.sizePartial
                  ? 'Some context graphs could not report size; total is partial.'
                  : 'Totals across all your context graphs, summed over Working, Shared Working & Verified Memory. Knowledge Assets are entities that have been published to Verified Memory.')
              : 'No context graphs yet.'}
          </div>
        </StatCard>
        <StatCard
          label="Collaborating Agents"
          icon={<UsersRound size={13} aria-hidden />}
          value={!agg.hasCgs
            ? <span className="v10-stat-empty">—</span>
            : agg.agentsLoading
              ? <span className="v10-stat-loading">loading…</span>
              // Partial (a probe failed or a public graph's membership
              // is unmeasurable) → "~" so the count doesn't read as an
              // exact figure that silently excludes those graphs (Codex).
              : agg.agentsPartial ? `~${agg.agentCount}` : agg.agentCount}
          sub={!agg.hasCgs
            ? 'No context graphs yet.'
            : agg.agentsPartial
              ? 'Some context graphs could not report agents; count is partial.'
              : "Unique agents — your own and others' — allow-listed and collaborating across your context graphs."}
          accentColor="var(--purple)"
        />
      </div>

      <div className="v10-dash-grid v10-dash-grid-2">
        <div className="v10-dash-section v10-dash-section-wide v10-anim-mount">
          <div className="v10-dash-section-header">
            <div className="v10-dash-section-title">
              <Share2 size={13} aria-hidden />
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

          {wb?.chainId != null ? (
            <div className="v10-ws-chain-row">
              <span className="v10-ws-chain-label">Chain</span>
              <span className="v10-ws-chain-value">{chainInfo(wb.chainId).name}</span>
            </div>
          ) : null}

          <div className="v10-ws-subhead">Node wallets</div>
          {wbLoading && !wb ? (
            <p className="v10-cg-empty">Loading wallets…</p>
          ) : walletRows.length > 0 ? (
            <div className="v10-ws-wtable">
              <div className="v10-ws-wrow v10-ws-whead">
                <span>Wallet</span>
                {/* Always display TRAC literally — the on-chain symbol
                    from the contract (e.g. "v9TRAC" on testnet) is
                    noise in this header (round-3 feedback). */}
                <span>TRAC</span>
                <span>Gas ({chainInfo(wb?.chainId).gas})</span>
              </div>
              {walletRows.map((b) => (
                <div key={b.address} className="v10-ws-wrow">
                  <span className="v10-ws-addr" title={b.address}>{shortAddr(b.address)}</span>
                  <span className="v10-ws-bal">{fmtTrac(b.trac)}</span>
                  <span className="v10-ws-bal-sec">{b.eth}</span>
                </div>
              ))}
            </div>
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
              <span title="Publishes to Verified Memory that spent TRAC on-chain. Free SWM/local/testnet publishes are not counted (they don't burn TRAC).">Publishes to VM</span>
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
