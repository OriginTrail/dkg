import React, { useState, useCallback, useEffect, useRef } from 'react';

import { listJoinRequests, approveJoinRequest, rejectJoinRequest, type AgentIdentity, type PendingJoinRequest } from '../../../api.js';
import { useMemoryEntities } from '../../../hooks/useMemoryEntities.js';
import { useProjectProfile } from '../../../hooks/useProjectProfile.js';

import { canonicalAgentDid, normalizeAccessPolicy } from '../../../lib/contextGraphSidebar.js';
import { layerNoun, useCanonicalTriples, type LayerView } from '../helpers.js';
import { StatStrip } from '../../../components/ContextGraphPrimitives.js';
import { useNodeEvents } from '../../../hooks/useNodeEvents.js';

export function LayerSwitcher({ active, counts, onSwitch, onShare, onImport, onRefresh }: {
  active: LayerView;
  counts: { wm: number; swm: number; vm: number; total: number };
  onSwitch: (v: LayerView) => void;
  onShare: () => void;
  onImport: () => void;
  onRefresh: () => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const switchTo = (layer: LayerView) => {
    setMoreOpen(false);
    onSwitch(layer);
  };

  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && moreRef.current?.contains(target)) return;
      setMoreOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [moreOpen]);

  return (
    <div className="v10-layer-switcher">
      <button
        className={`v10-layer-switch-btn ${active === 'overview' ? 'active' : ''}`}
        data-layer="overview"
        aria-label="Overview"
        title="Overview"
        onClick={() => switchTo('overview')}
      >
        <span className="v10-layer-switch-icon">◎</span>
        <span className="v10-layer-switch-label">Overview</span>
      </button>
      <span className="v10-layer-switch-separator" aria-hidden="true" />
      <button
        className={`v10-layer-switch-btn ${active === 'wm' ? 'active' : ''}`}
        data-layer="wm"
        aria-label="Working Memory"
        title="Working Memory"
        onClick={() => switchTo('wm')}
      >
        <span className="v10-layer-switch-icon" style={{ color: '#64748b' }}>◇</span>
        <span className="v10-layer-switch-label v10-layer-switch-label-full">Working Memory</span>
        <span className="v10-layer-switch-label v10-layer-switch-label-compact">WM</span>
        {counts.wm > 0 && <span className="v10-layer-switch-count">{counts.wm}</span>}
      </button>
      <button
        className={`v10-layer-switch-btn ${active === 'swm' ? 'active' : ''}`}
        data-layer="swm"
        aria-label="Shared Working Memory"
        title="Shared Working Memory"
        onClick={() => switchTo('swm')}
      >
        <span className="v10-layer-switch-icon" style={{ color: '#f59e0b' }}>◈</span>
        <span className="v10-layer-switch-label v10-layer-switch-label-full">Shared Working Memory</span>
        <span className="v10-layer-switch-label v10-layer-switch-label-compact">SWM</span>
        {counts.swm > 0 && <span className="v10-layer-switch-count">{counts.swm}</span>}
      </button>
      <button
        className={`v10-layer-switch-btn ${active === 'vm' ? 'active' : ''}`}
        data-layer="vm"
        aria-label="Verifiable Memory"
        title="Verifiable Memory"
        onClick={() => switchTo('vm')}
      >
        <span className="v10-layer-switch-icon" style={{ color: '#22c55e' }}>◉</span>
        <span className="v10-layer-switch-label v10-layer-switch-label-full">Verifiable Memory</span>
        <span className="v10-layer-switch-label v10-layer-switch-label-compact">VM</span>
        {counts.vm > 0 && <span className="v10-layer-switch-count">{counts.vm}</span>}
      </button>
      <span className="v10-layer-switch-separator" aria-hidden="true" />
      <button
        className={`v10-layer-switch-btn ${active === 'graph-overview' ? 'active' : ''}`}
        data-layer="graph-overview"
        aria-label="Subgraphs"
        title="Subgraphs"
        onClick={() => switchTo('graph-overview')}
      >
        <span className="v10-layer-switch-icon">⌬</span>
        <span className="v10-layer-switch-label">Subgraphs</span>
      </button>
      <div
        ref={moreRef}
        className="v10-layer-more"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setMoreOpen(false);
          }
        }}
      >
        <button
          type="button"
          className={`v10-layer-switch-btn v10-layer-more-btn ${active === 'query' ? 'active' : ''}`}
          data-layer="query"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          aria-label="More Context Graph views"
          title="More Context Graph views"
          onClick={() => setMoreOpen(open => !open)}
        >
          <span className="v10-layer-switch-icon">⋯</span>
          <span className="v10-layer-switch-label">More</span>
        </button>
        {moreOpen && (
          <div className="v10-layer-more-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className={`v10-layer-more-item ${active === 'query' ? 'active' : ''}`}
              onClick={() => switchTo('query')}
            >
              <span className="v10-layer-switch-icon">⟐</span>
              Query Catalogue
            </button>
          </div>
        )}
      </div>
      <div className="v10-layer-switcher-spacer" />
      <div className="v10-layer-switcher-actions">
        <button className="v10-layer-action-btn" onClick={onShare} aria-label="Share Context Graph">
          <span className="v10-layer-action-icon">⤴</span>
          <span className="v10-layer-action-label">Share</span>
        </button>
        <button className="v10-layer-action-btn" onClick={onImport} aria-label="Import into Context Graph">
          <span className="v10-layer-action-icon">↑</span>
          <span className="v10-layer-action-label">Import</span>
        </button>
        <button className="v10-layer-action-btn" onClick={onRefresh} aria-label="Refresh Context Graph data">
          <span className="v10-layer-action-icon">↻</span>
        </button>
      </div>
    </div>
  );
}

// ─── Project Header Strip ────────────────────────────────────
// Persistent project chrome that stays visible across every route
// (overview / layer / sub-graph). Fixes the "I lost the project header
// when I drilled into decisions" problem by surfacing project identity +
// the current sub-graph breadcrumb from a single place. Compact enough
// that it doesn't compete with the big ProjectOverviewCard on the
// overview route itself.
export function ProjectHeaderStrip({
  cg,
  profile,
  activeSubGraph,
  onClearSubGraph,
}: {
  cg: { id: string; name?: string; description?: string };
  profile: ReturnType<typeof useProjectProfile>;
  activeSubGraph: ReturnType<typeof useProjectProfile>['forSubGraph'] extends (s: string) => infer R ? R | null : null;
  onClearSubGraph: () => void;
}) {
  const name = cg.name || profile.displayName || cg.id;
  return (
    <div
      className="v10-project-strip"
      style={{
        '--sg-color': activeSubGraph?.color ?? profile.primaryColor,
      } as React.CSSProperties}
    >
      <span
        className="v10-project-strip-dot"
        style={{ background: profile.primaryColor }}
      />
      <button
        type="button"
        className="v10-project-strip-name"
        onClick={activeSubGraph ? onClearSubGraph : undefined}
        disabled={!activeSubGraph}
        title={activeSubGraph ? 'Back to context graph overview' : cg.id}
      >
        {name}
      </button>
      {activeSubGraph ? (
        <>
          <span className="v10-project-strip-sep">›</span>
          <span className="v10-project-strip-sg">
            <span
              className="v10-project-strip-sg-icon"
              style={{ color: activeSubGraph.color }}
            >
              {activeSubGraph.icon ?? '•'}
            </span>
            {activeSubGraph.displayName ?? activeSubGraph.slug}
          </span>
          {activeSubGraph.description && (
            <span className="v10-project-strip-desc" title={activeSubGraph.description}>
              {activeSubGraph.description}
            </span>
          )}
        </>
      ) : (
        cg.description && (
          <span className="v10-project-strip-desc" title={cg.description}>
            {cg.description}
          </span>
        )
      )}
    </div>
  );
}

// ─── Project Overview Card ───────────────────────────────────

type OverviewRoleState = {
  label: string;
  title: string;
  tone: 'curator' | 'participant' | 'viewer' | 'unknown';
};
type OverviewAgentStatus = 'loading' | 'ok' | 'error';
type OverviewParticipantsStatus = 'loading' | 'ok' | 'error';
type OverviewAgentIdentity = Pick<AgentIdentity, 'agentDid'> & Partial<Pick<AgentIdentity, 'agentAddress'>>;

function overviewRoleState(
  cg: any,
  currentAgent: OverviewAgentIdentity | null,
  currentAgentStatus: OverviewAgentStatus,
  participants: string[],
  participantsStatus: OverviewParticipantsStatus,
): OverviewRoleState {
  const curator = typeof cg?.curator === 'string' ? cg.curator.trim() : '';
  // Codex review issue P — match the address-or-did predicate
  // `curatorStatusForOverview` uses (bug G), so the role pill and
  // the join-requests gate can't disagree on older daemons that
  // only surface `agentAddress`. `canonicalAgentDid` already
  // normalises bare EVM addresses to the prefixed DID form, so
  // any-of-the-two-matches resolves correctly.
  const agentIds = new Set(
    [currentAgent?.agentDid, currentAgent?.agentAddress]
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map(canonicalAgentDid),
  );
  const hasIdentity = agentIds.size > 0;
  if (curator && hasIdentity && agentIds.has(canonicalAgentDid(curator))) {
    return {
      label: 'Curator',
      title: 'This agent is the curator for this Context Graph.',
      tone: 'curator',
    };
  }
  if (cg?.callerInvolved === true) {
    if (curator && !hasIdentity && currentAgentStatus === 'loading') {
      return {
        label: 'Role checking',
        title: 'This agent is involved in this Context Graph; curator status is still loading.',
        tone: 'unknown',
      };
    }
    if (curator && !hasIdentity && currentAgentStatus === 'error') {
      return {
        label: 'Role unknown',
        title: 'This agent is involved in this Context Graph, but curator status could not be confirmed.',
        tone: 'unknown',
      };
    }
    return {
      label: 'Joined',
      title: 'This agent is involved in this Context Graph; curator status is shown only when identity metadata confirms it.',
      tone: 'participant',
    };
  }
  if (cg?.callerInvolved === false) {
    return {
      label: 'Not joined',
      title: 'This agent is not listed as curator or participant for this Context Graph.',
      tone: 'viewer',
    };
  }
  const isListedParticipant = participantsStatus === 'ok' && participants
    .map(participant => participant.trim())
    .filter(Boolean)
    .some(participant => agentIds.has(canonicalAgentDid(participant)));
  if (isListedParticipant) {
    return {
      label: 'Joined',
      title: 'This agent is listed as a participant for this Context Graph.',
      tone: 'participant',
    };
  }
  return {
    label: 'Role unknown',
    title: 'The node did not provide enough role metadata for this Context Graph.',
    tone: 'unknown',
  };
}

function overviewAccessAgentStat(
  cg: any,
  participants: string[],
  participantsStatus: OverviewParticipantsStatus,
) {
  const policy = normalizeAccessPolicy(cg?.accessPolicy);
  if (policy === 'public') {
    return {
      id: 'participants',
      value: 'Open',
      label: 'Public access',
      tooltip: 'Public Context Graphs do not have an authoritative allowlist count.',
    };
  }
  if (participantsStatus === 'loading') {
    return {
      id: 'participants',
      value: '...',
      label: 'Agents with access',
      tooltip: 'Participant list is loading.',
    };
  }
  if (participantsStatus === 'error') {
    return {
      id: 'participants',
      value: 'Unavailable',
      label: 'Agents with access',
      tooltip: 'Participant list unavailable; access count is unknown.',
    };
  }

  const agents = new Set(
    participants
      .map(agent => agent.trim())
      .filter(Boolean)
      .map(canonicalAgentDid),
  );
  const curator = typeof cg?.curator === 'string' ? cg.curator.trim() : '';
  if (curator) agents.add(canonicalAgentDid(curator));

  return {
    id: 'participants',
    value: agents.size.toLocaleString(),
    label: 'Agents with access',
    tooltip: 'Includes the curator plus allowlisted participants reported by the node.',
  };
}

function overviewAccessState(raw?: string): { label: string; title: string; tone: 'public' | 'curated' | 'unknown' } {
  const policy = normalizeAccessPolicy(raw);
  if (policy === 'public') {
    return {
      label: 'Public',
      title: 'Public Context Graph.',
      tone: 'public',
    };
  }
  if (policy === 'private') {
    return {
      label: 'Curated',
      title: 'Curated Context Graph with access controlled by the curator.',
      tone: 'curated',
    };
  }
  return {
    label: 'Access unknown',
    title: 'The node did not provide an access policy for this Context Graph.',
    tone: 'unknown',
  };
}

// S2 finalize (§4.2.1) — true if the current agent owns the curator
// role on this CG. Lifted out of overviewRoleState so the Pending
// Join Requests section can gate on the same predicate without
// re-deriving it.
// Codex review bug C — tri-state replaces the prior boolean
// predicate so a curator's join-requests section isn't hidden
// while `/api/agent/identity` is still resolving or after a
// transient error. Consumers decide how to render the `'unknown'`
// state (we show a 'Verifying access…' loading panel).
export type CuratorStatus = 'curator' | 'not-curator' | 'unknown';

export function curatorStatusForOverview({
  cg,
  currentAgent,
  currentAgentStatus = 'ok',
}: {
  cg: any;
  currentAgent: OverviewAgentIdentity | null;
  currentAgentStatus?: OverviewAgentStatus;
}): CuratorStatus {
  const curator = typeof cg?.curator === 'string' ? cg.curator.trim() : '';
  if (!curator) {
    // Codex review bug I — older / partial CG payloads may omit
    // `curator` entirely. Returning `'not-curator'` here hard-hides
    // PendingJoinRequestsSection from real curators whose daemon
    // simply didn't surface the field (pre-PR boolean predicate
    // still let /join-requests gate authorisation). `'unknown'`
    // routes through the "Verifying access…" panel, which is the
    // right state when we genuinely can't decide.
    return 'unknown';
  }
  // Codex review bug G — older daemons / transient identity errors
  // may surface `agentAddress` without `agentDid`. `canonicalAgentDid`
  // already accepts both forms (it normalises bare EVM addresses to
  // the prefixed DID), so prefer ANY identity material we have over
  // falling closed. `'unknown'` is reserved for the case where we
  // truly have nothing to compare against.
  const did = currentAgent?.agentDid?.trim() ?? '';
  const addr = currentAgent?.agentAddress?.trim() ?? '';
  const identity = did || addr;
  if (!identity) {
    if (currentAgentStatus === 'loading' || currentAgentStatus === 'error') {
      return 'unknown';
    }
    // Status reports OK but neither agentDid nor agentAddress
    // materialised — treat as unknown rather than fail-closed.
    return 'unknown';
  }
  return canonicalAgentDid(curator) === canonicalAgentDid(identity)
    ? 'curator'
    : 'not-curator';
}

function overviewIdentitySet(currentAgent: OverviewAgentIdentity | null): Set<string> {
  return new Set(
    [currentAgent?.agentDid, currentAgent?.agentAddress]
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map(canonicalAgentDid),
  );
}

export function ProjectOverviewCard({
  cg,
  memory,
  subGraphCount,
  subGraphFetchFailed = false,
  participants,
  participantsStatus = 'ok',
  currentAgent,
  currentAgentStatus = 'ok',
  onSwitchLayer,
  onOpenPrimer,
}: {
  cg: any;
  memory: ReturnType<typeof useMemoryEntities>;
  /** Count of user-facing sub-graphs (excludes the reserved `meta`
   *  slug). `null` while loading or on fetch error. */
  subGraphCount?: number | null;
  /** True if the last `/sub-graph/list` fetch errored. Lets the
   *  stat strip distinguish "still loading" from "permanently
   *  unavailable" (Codex review bug D). */
  subGraphFetchFailed?: boolean;
  participants: string[];
  participantsStatus?: OverviewParticipantsStatus;
  currentAgent?: OverviewAgentIdentity | null;
  currentAgentStatus?: OverviewAgentStatus;
  onSwitchLayer?: (layer: LayerView) => void;
  onOpenPrimer?: () => void;
}) {
  const { wm: working, swm: shared, vm: verified } = memory.counts;
  const layerSum = working + shared + verified;
  const role = overviewRoleState(cg, currentAgent ?? null, currentAgentStatus, participants, participantsStatus);
  const access = overviewAccessState(cg?.accessPolicy);
  const accessAgentStat = overviewAccessAgentStat(cg, participants, participantsStatus);
  const curator = typeof cg?.curator === 'string' ? cg.curator.trim() : '';
  const curatorCanonical = curator ? canonicalAgentDid(curator) : '';
  const isPublicAccess = normalizeAccessPolicy(cg?.accessPolicy) === 'public';
  const selfIds = overviewIdentitySet(currentAgent ?? null);
  const layerStatuses = Object.values(memory.layerStatus ?? {});
  const unavailableLayerCount = layerStatuses.filter(status => status === 'error').length;
  const allLayerCountsUnavailable =
    !memory.loading && layerStatuses.length === 3 && unavailableLayerCount === 3;
  const hasUnavailableLayer = !memory.loading && unavailableLayerCount > 0;
  const statusHint = memory.loading
    ? 'Loading memory layers...'
    : allLayerCountsUnavailable || memory.error
        ? 'Live memory counts are unavailable.'
        : memory.partial || hasUnavailableLayer
          ? 'One or more layer counts are currently a lower bound.'
          : 'Canonical current-layer entity counts.';
  const totalEntitiesValue = allLayerCountsUnavailable ? 'Unavailable' : layerSum.toLocaleString();
  // Triples: canonical project-wide total via `useCanonicalTriples`
  // (GH #819 helper — single source of truth for all aggregate
  // triple-count surfaces).
  //
  // §4.2.1 trap reminder: do NOT sum per-entity tripleCount, do
  // NOT borrow SubGraphBar's `totalTriples` which excludes the
  // root bucket, do NOT read `allTriples.length` directly (it
  // skips neither SWM cross-graph SPO duplication nor WM residue
  // from promoted entities). PR #818 sweep 4's interim shape
  // (sum-across-`useLayerTriples`) was closer but still dropped
  // mixed-layer edges where one endpoint hadn't promoted past
  // `t.layer`. The canonical helper's "drop only when BOTH
  // endpoints moved past" rule keeps those edges as legitimate
  // facts.
  //
  // Codex review bug B (still applies — partial-result preserving
  // behaviour is unchanged): when a layer query fails the slice
  // is empty; `total` stays a lower bound and the '+' suffix
  // renders via `triplesIsPartial`.
  const { total: triplesCount } = useCanonicalTriples(memory);
  const triplesIsPartial = !memory.loading && (memory.partial || hasUnavailableLayer);
  const triplesValue = allLayerCountsUnavailable
    ? 'Unavailable'
    : memory.loading && triplesCount === 0
      ? '...'
      : triplesIsPartial
        ? `${triplesCount.toLocaleString()}+`
        : triplesCount.toLocaleString();
  const triplesTooltip = allLayerCountsUnavailable
    ? 'Live triple counts are unavailable.'
    : triplesIsPartial
      ? 'One or more layer triple counts are currently a lower bound.'
      : 'Canonical triple total across all layers.';
  // Codex review bug D — distinguish "still fetching" from
  // "fetch failed" for the Subgraphs cell so we don't show a
  // perpetual ellipsis after a failed `/sub-graph/list` call. A
  // failure renders the same `Unavailable` affordance the Entities
  // outage cell uses (so the four cells share one failure idiom).
  const subGraphsValue = subGraphCount == null
    ? subGraphFetchFailed ? 'Unavailable' : '...'
    : subGraphCount.toLocaleString();
  const subGraphsTooltip = subGraphCount == null
    ? subGraphFetchFailed
      ? 'Sub-graph list is currently unavailable.'
      : 'Sub-graph count is loading.'
    : 'Topical partitions inside this Context Graph.';
  const pipeline = [
    {
      key: 'wm' as const,
      label: 'Working Memory',
      desc: 'Private staging area',
      count: working,
      status: memory.layerStatus?.wm ?? 'ok',
      color: '#64748b',
    },
    {
      key: 'swm' as const,
      label: 'Shared Working Memory',
      desc: 'Collaborative review',
      count: shared,
      status: memory.layerStatus?.swm ?? 'ok',
      color: '#f59e0b',
    },
    {
      key: 'vm' as const,
      label: 'Verifiable Memory',
      desc: 'Published on-chain',
      count: verified,
      status: memory.layerStatus?.vm ?? 'ok',
      color: '#22c55e',
    },
  ];
  const pipelineHasUnavailableLayer = pipeline.some(item => item.status === 'error');

  return (
    <div className="v10-po">
      {/* Identity row (§4.2.1 — locked spec) — label-pill pairs on
          the left, inline primer link on the right. Name + description
          live in the persistent `ProjectHeaderStrip`; the role glyph
          (◆) is applied in CSS via `data-role`/`data-tone`, never in
          the data string itself. */}
      <div className="v10-po-identity" data-section="identity">
        <div className="v10-po-identity-pairs">
          <div className="v10-po-identity-pair">
            <span className="v10-po-identity-label">Your role:</span>
            <span
              className="v10-po-badge"
              data-role={role.tone}
              title={role.title}
            >
              {role.label}
            </span>
          </div>
          <div className="v10-po-identity-pair">
            <span className="v10-po-identity-label">Context Graph:</span>
            <span
              className="v10-po-badge"
              data-cg-type={access.tone}
              title={access.title}
            >
              {access.label}
            </span>
          </div>
        </div>
        {onOpenPrimer && (
          <button
            type="button"
            className="v10-po-identity-primer"
            onClick={onOpenPrimer}
            title="Open the Context Graph primer"
          >
            What is a Context Graph?
          </button>
        )}
      </div>
      {/* §4.2.1 Delta 2 (locked) — M6 layer-availability status copy
          renders as a `title` tooltip on the Entities cell, not as
          an inline `hint:`, to keep the 4-card grid clean. */}
      <div data-section="at-a-glance" className="v10-po-stat-block">
        <div className="v10-po-section-title">At a glance</div>
        <StatStrip
          className="v10-po-stat-strip"
          items={[
            { id: 'entities', value: totalEntitiesValue, label: 'Entities', tooltip: statusHint },
            { id: 'triples', value: triplesValue, label: 'Triples', tooltip: triplesTooltip },
            { id: 'subgraphs', value: subGraphsValue, label: 'Subgraphs', tooltip: subGraphsTooltip },
            accessAgentStat,
          ]}
        />
      </div>
      <div className="v10-po-pipeline" data-section="pipeline" aria-label="Knowledge Pipeline">
        <div className="v10-po-pipeline-head">
          <div>
            <div className="v10-po-section-title">Knowledge Pipeline</div>
            <div className="v10-po-section-desc">Entities move from private staging to shared review; published assertion bundles become Knowledge Assets with on-chain provenance.</div>
          </div>
        </div>
        <div className="v10-po-pipeline-track" aria-hidden="true">
          {!pipelineHasUnavailableLayer && layerSum > 0
            ? pipeline.map(item => {
              const width = item.count > 0 ? (item.count / layerSum) * 100 : 0;
              return (
                <span
                  key={item.key}
                  className={`v10-po-pipeline-seg ${item.key}`}
                  style={{ width: `${width}%`, background: item.color }}
                />
              );
            })
            : <span className="v10-po-pipeline-empty" />}
        </div>
        <div className="v10-po-pipeline-steps">
          {pipeline.map((item, index) => (
            <button
              key={item.key}
              type="button"
              className={`v10-po-pipeline-step ${item.key}`}
              onClick={() => onSwitchLayer?.(item.key)}
              style={{ '--po-layer-color': item.color } as React.CSSProperties}
            >
              <span className="v10-po-pipeline-step-index">{index + 1}</span>
              <span className="v10-po-pipeline-step-copy">
                <span className="v10-po-pipeline-step-label">{item.label}</span>
                <span className="v10-po-pipeline-step-desc">{item.desc}</span>
              </span>
              <span className="v10-po-pipeline-step-count">
                {item.status === 'error'
                  ? 'Unavailable'
                  : `${item.count.toLocaleString()} ${layerNoun(item.key, item.count)}`}
              </span>
            </button>
          ))}
        </div>
      </div>
      {/* Participant agents (§4.2.1) — uniform "Participant agents"
          heading regardless of access policy. The current user's
          row carries the `· you` suffix; the curator (whether the
          current user or someone else) gets `· curator`. Glyphs are
          applied in CSS via `.is-self` / `.is-curator` — never in the
          data string. */}
      <div className="v10-po-people" data-section="participants">
        <div className="v10-po-section-title">Participant agents</div>
        {(() => {
          // Codex review bug A — `/participants` returns `allowedAgents`
          // and does NOT include the curator on a private CG. Render
          // the de-duplicated UNION so the curator's own row is always
          // present (and so the ` · curator` / ` · you · curator`
          // markers actually have a row to attach to). On a public CG
          // where the curator may already be in `allowedAgents`, the
          // dedup makes this a no-op.
          // Codex review bug H — `cg.curator` arrives as a
          // `did:dkg:agent:0x…` URI; the rest of the roster comes
          // from `/participants` as bare EVM addresses. The row
          // renderer truncates with `slice(0, 6) + … + slice(-4)`,
          // which would print `did:dk…1234` for the curator row.
          // Strip the prefix so every row reads in the same
          // address shape; preserve the full string in the row's
          // hover `title` so the DID origin is recoverable.
          const DID_PREFIX = 'did:dkg:agent:';
          const displayOf = (raw: string): string =>
            raw.toLowerCase().startsWith(DID_PREFIX)
              ? raw.slice(DID_PREFIX.length)
              : raw;
          // Codex review issue J — only seed the curator row when
          // the participants list is authoritative. While
          // `/participants` is loading or has errored, showing
          // "[◆ curator (you)]" alone would imply a complete roster
          // on a CG that may actually have other allowlisted members
          // we can't yet see. Loading / error branches fall through
          // to the empty-state path which renders the appropriate
          // status copy.
          const seen = new Set<string>();
          const rows: { display: string; full: string; canonical: string }[] = [];
          if (curator && participantsStatus === 'ok') {
            const c = canonicalAgentDid(curator);
            seen.add(c);
            rows.push({ display: displayOf(curator), full: curator, canonical: c });
          }
          if (participantsStatus === 'ok') {
            for (const addr of participants) {
              const c = canonicalAgentDid(addr);
              if (seen.has(c)) continue;
              seen.add(c);
              rows.push({ display: displayOf(addr), full: addr, canonical: c });
            }
          }
          if (rows.length === 0) {
            // Codex review bug E + issue S — access policy is
            // local-only state from `cg.accessPolicy` and is known
            // regardless of whether `/participants` succeeded.
            // Issue S — re-ordered so `isPublicAccess` takes
            // precedence over the loading/error branches: a public
            // CG whose `/participants` errored should still tell
            // the user access is open, not parrot the unavailable
            // copy. Only curated CGs fall through to the loading /
            // error / "no participants" sequence.
            const emptyCopy = isPublicAccess
              ? 'This Context Graph is public — anyone can subscribe.'
              : participantsStatus === 'loading'
                ? 'Loading participant agents...'
                : participantsStatus === 'error'
                  ? 'Participant list unavailable.'
                  : 'No participant agents recorded yet.';
            return <div className="v10-po-people-empty">{emptyCopy}</div>;
          }
          return (
            <div className="v10-po-participants-list">
              {rows.map(({ display, full, canonical }) => {
                const isSelf = selfIds.has(canonical);
                const isCurator = !!curatorCanonical && canonical === curatorCanonical;
                // ui-lead item 2 — suffixes render as separate
                // `.v10-po-participant-tag` spans so the spacing
                // (the `·` separator) lives in CSS `::before`
                // pseudo-content instead of the data string.
                // `aria-label` preserves a screen-reader-friendly
                // form, since the visible separators aren't in the
                // accessible name.
                const shortAddress = `${display.slice(0, 6)}…${display.slice(-4)}`;
                const ariaLabelParts = [shortAddress];
                if (isSelf) ariaLabelParts.push('you');
                if (isCurator) ariaLabelParts.push('curator');
                return (
                  <span
                    key={canonical}
                    className={`v10-po-participant${isSelf ? ' is-self' : ''}${isCurator ? ' is-curator' : ''}`}
                    title={full}
                    aria-label={ariaLabelParts.join(' ')}
                  >
                    <span className="v10-po-participant-name">{shortAddress}</span>
                    {isSelf && <span className="v10-po-participant-tag">you</span>}
                    {isCurator && <span className="v10-po-participant-tag">curator</span>}
                  </span>
                );
              })}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// ─── Pending Join Requests ───────────────────────────────────

// S2 finalize (§4.2.1) — Pending Join Requests is a peer section
// under Participant agents. Visible to curators ALWAYS (with a
// graceful empty state); hidden from definitive non-curators;
// shown with a 'Verifying access…' state when curator status is
// still unknown (Codex review bug C — don't fail closed during
// identity loading / error).
export function PendingJoinRequestsSection({
  contextGraphId,
  curatorStatus,
  onParticipantsChanged,
}: {
  contextGraphId: string;
  curatorStatus: CuratorStatus;
  onParticipantsChanged?: () => void;
}) {
  const [requests, setRequests] = useState<PendingJoinRequest[]>([]);
  const [processing, setProcessing] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('loading');
  // Mirror `cancelled` across the effect via a ref so the
  // event-driven refetch path can share it with the mount-effect
  // path without re-creating the closure on every render.
  const fetchRequestIdRef = useRef(0);

  // Codex review bug N (reverts the optimistic-fetch logic from
  // bug L). The daemon's `/join-requests` route does NOT gate
  // on curator identity — see `packages/cli/src/daemon/routes/
  // context-graph.ts:898-909` which calls
  // `agent.listPendingJoinRequests`, whose body is a raw SPARQL
  // read of the meta graph (`packages/agent/src/dkg-agent.ts:
  // 13126-13152`) with no caller authentication. Until that
  // gating lands server-side, firing the request in `'unknown'`
  // status would leak pending-moderation metadata to any caller
  // whose `/api/agent/identity` lookup is mid-resolution / errored.
  // Fail closed at the UI: only fetch when we have positive
  // local proof of curator status. The "Verifying access…"
  // panel below stays as the safe gate for `'unknown'`.
  const refresh = useCallback(() => {
    if (curatorStatus !== 'curator') {
      setRequests([]);
      setStatus('idle');
      return;
    }
    const requestId = ++fetchRequestIdRef.current;
    setStatus('loading');
    listJoinRequests(contextGraphId)
      .then(data => {
        if (fetchRequestIdRef.current !== requestId) return;
        setRequests(data.requests.filter(r => r.status === 'pending'));
        setStatus('idle');
      })
      .catch(() => {
        if (fetchRequestIdRef.current !== requestId) return;
        setRequests([]);
        setStatus('error');
      });
  }, [contextGraphId, curatorStatus]);

  useEffect(() => {
    refresh();
    return () => { fetchRequestIdRef.current++; };
  }, [refresh]);

  // Auto-refresh on SSE events scoped to this CG. The daemon
  // emits `join_request` when a new request arrives
  // (cli/src/daemon/lifecycle.ts:1899-1921), and
  // `join_approved` / `join_rejected` when a moderation action
  // resolves — refetching on all three keeps the list live
  // across browser tabs, multi-curator nodes, and concurrent
  // sessions without polling.
  useNodeEvents(useCallback((event) => {
    if (
      event.type !== 'join_request'
      && event.type !== 'join_approved'
      && event.type !== 'join_rejected'
    ) return;
    if (event.data?.contextGraphId !== contextGraphId) return;
    refresh();
  }, [contextGraphId, refresh]));

  // Definitive non-curator — section is dead UI and stays hidden.
  if (curatorStatus === 'not-curator') return null;

  // Unknown — render a quiet "verifying access" panel so the user
  // sees something is in progress (no actionable controls; the
  // request fetch is gated until we know they're the curator).
  // See effect comment above for why we fail closed here.
  if (curatorStatus === 'unknown') {
    return (
      <section className="v10-po-join" data-section="join-requests">
        <header className="v10-po-join-head">
          <span className="v10-po-section-title">Pending join requests</span>
        </header>
        <div className="v10-po-join-empty">Verifying access…</div>
      </section>
    );
  }

  const handleApprove = async (addr: string) => {
    setProcessing(addr);
    try {
      await approveJoinRequest(contextGraphId, addr);
      setRequests(prev => prev.filter(r => r.agentAddress !== addr));
      onParticipantsChanged?.();
    } catch { /* noop */ } finally { setProcessing(null); }
  };

  const handleReject = async (addr: string) => {
    setProcessing(addr);
    try {
      await rejectJoinRequest(contextGraphId, addr);
      setRequests(prev => prev.filter(r => r.agentAddress !== addr));
      onParticipantsChanged?.();
    } catch { /* noop */ } finally { setProcessing(null); }
  };

  return (
    <section className="v10-po-join" data-section="join-requests">
      <header className="v10-po-join-head">
        <span className="v10-po-section-title">Pending join requests</span>
        <span className="v10-po-join-count" data-empty={requests.length === 0 ? 'true' : 'false'}>
          {requests.length}
        </span>
      </header>
      {status === 'loading'
        ? <div className="v10-po-join-empty">Loading join requests...</div>
        : status === 'error'
          ? <div className="v10-po-join-empty">Join requests are currently unavailable.</div>
          : requests.length === 0
            ? <div className="v10-po-join-empty">No pending join requests.</div>
            : <div className="v10-po-join-list">
                {requests.map(req => (
                  <div key={req.agentAddress} className="v10-po-join-item">
                    <div className="v10-po-join-info">
                      <span className="v10-po-join-name">{req.name || `${req.agentAddress.slice(0, 6)}…${req.agentAddress.slice(-4)}`}</span>
                      <span className="v10-po-join-addr" title={req.agentAddress}>{req.agentAddress.slice(0, 10)}…</span>
                    </div>
                    <div className="v10-po-join-actions">
                      <button
                        className="v10-po-join-btn approve"
                        onClick={() => handleApprove(req.agentAddress)}
                        disabled={processing === req.agentAddress}
                      >
                        {processing === req.agentAddress ? '…' : '✓ Approve'}
                      </button>
                      <button
                        className="v10-po-join-btn reject"
                        onClick={() => handleReject(req.agentAddress)}
                        disabled={processing === req.agentAddress}
                        aria-label="Reject join request"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>}
    </section>
  );
}

// ─── Overview primer footer (§4.2.1 — last row before the bottom of
//     the Overview, deliberately quieter than the identity-row primer
//     link so first-time users still have a visible escape hatch
//     even if they scrolled past the identity row).
//
// "New here?  →  What is a Context Graph?" plus a one-line sub-copy.
// Re-uses the same `onOpenPrimer` handler the identity-row link
// fires, so wiring is one call site in ProjectView. ────────────

export function OverviewPrimerEntry({ onOpenPrimer }: { onOpenPrimer: () => void }) {
  return (
    <div className="v10-po-primer-footer" data-section="primer">
      <span className="v10-po-primer-footer-lede">New here?</span>
      <span className="v10-po-primer-footer-arrow" aria-hidden="true">→</span>
      <button
        type="button"
        className="v10-po-primer-footer-link"
        onClick={onOpenPrimer}
      >
        What is a Context Graph?
      </button>
      <div className="v10-po-primer-footer-sub">
        A short primer on context graphs, the WM → SWM → VM pipeline, and how participant agents collaborate.
      </div>
    </div>
  );
}

