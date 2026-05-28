import React, { useMemo, useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { useFetch } from '../../hooks.js';
import { api } from '../../api-wrapper.js';
import { encodeDocTabId, resolveDocRef } from '../../lib/doc-tab-id.js';
import { truncateMiddle } from '../../lib/truncate.js';
import {
  listJoinRequests, approveJoinRequest, rejectJoinRequest,
  listAssertions, promoteAssertion,
  publishSharedMemory, executeQuery,
  writeProfileQueryCatalog,
  fetchSubGraphs,
  type AgentIdentity, type AssertionInfo, type PendingJoinRequest, type PublishResult, type SubGraphInfo,
} from '../../api.js';
import { ImportFilesModal } from '../../components/Modals/ImportFilesModal.js';
import { ShareProjectModal } from '../../components/Modals/ShareProjectModal.js';
import {
  useMemoryEntities,
  canonicalEntityUri,
  isFirstClassEntity,
  type TrustLevel, type MemoryEntity, type Triple,
} from '../../hooks/useMemoryEntities.js';
import { decodeRdfStringLiteral } from '../../../rdf-literal.js';
import {
  useProjectProfile, ProjectProfileContext, useProjectProfileContext,
  type QueryCatalog,
} from '../../hooks/useProjectProfile.js';
import {
  useAgents, AgentsContext, useAgentsContext,
  type AgentSummary,
} from '../../hooks/useAgents.js';
import { AgentChip } from '../../components/AgentChip.js';
import { ActivityFeed } from '../../components/ActivityFeed.js';
import { VerifiedIdentityBanner } from '../../components/VerifiedIdentityBanner.js';
import { SubGraphBar } from '../../components/SubGraphBar.js';
import { GenUIEntityPanel } from '../../genui/index.js';
import { MEMORY_LABEL_PREDICATES, memoryGraphLabels } from '../../lib/memoryLabels.js';
import { canonicalAgentDid, normalizeAccessPolicy } from '../../lib/contextGraphSidebar.js';
import { useLayoutStore } from '../../stores/layout.js';
import { useTabsStore } from '../../stores/tabs.js';
import {
  useVerifiedMemoryAnchors,
  VIZ_ANCHOR_TYPE, VIZ_AGENT_TYPE,
  VIZ_PRED_ANCHORED_IN, VIZ_PRED_SIGNED_BY, VIZ_PRED_CONSENSUS,
  type PublishAnchor,
} from '../../hooks/useVerifiedMemoryAnchors.js';
import {
  useSwmAttributions,
  type AgentPaletteEntry,
  type SwmAttributionsResult,
} from '../../hooks/useSwmAttributions.js';
import {
  TRUST_COLORS, TYPE_LABELS,
  PROV_WAS_ATTRIBUTED_TO,
  AGENT_NS, AGENT_CREATED_BY, AGENT_PROMOTED_BY, AGENT_PUBLISHED_BY,
  AGENT_CREATED_AT, AGENT_PROMOTED_AT, AGENT_PUBLISHED_AT,
  LAYER_CONFIG, CODE, CODE_CLASS_COLORS, CODE_PREDICATE_COLORS,
  SOURCE_CONTENT_TYPE, MARKDOWN_FORM, SOURCE_FILE, DKG_SIZE,
  entityAuthorUri, transitionAgentUri, transitionAtISO,
  shortType, shortPred, entityMeta,
  buildLayerGraphOptions, getDescription, neighborhoodTriples, neutraliseBuiltinNamespaces,
  matchesSearch, humanizeLabel, layerNoun, useLayerTriples,
  filterTriplesToEntities,
  entityTimestamp, formatRelativeTime, formatTimelineBucket, formatTrailTimestamp,
  type LayerView, type LayerContentTab, type KAPane,
  type SubGraphTab, type SubGraphEntitySort,
} from './helpers.js';
import { EmptyState, StatStrip, toneForLayer } from '../../components/ContextGraphPrimitives.js';
import { isUserFacingSubGraph, ROOT_SLUG_SENTINEL } from '../../lib/subGraphs.js';
import { useNodeEvents } from '../../hooks/useNodeEvents.js';

export const RdfGraph = lazy(() =>
  import('@origintrail-official/dkg-graph-viz/react').then(m => ({ default: m.RdfGraph }))
);

const RDF_TYPE_URI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const LABEL_PREDICATE_PRIORITY = new Map<string, number>(
  MEMORY_LABEL_PREDICATES.map((p, i) => [p, i]),
);

interface SingletonShelfItem {
  uri: string;
  label: string;
}

function isResourceNode(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('"')) return false;
  if (trimmed.startsWith('_:')) return true;
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return true;
  if (/\s/.test(trimmed)) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed);
}

function graphNodeKey(value: string): string {
  // Match the trim+unwrap shape used by graph-model.cleanUri and
  // useMemoryEntities.canonicalEntityUri so the shelf groups nodes the
  // same way the renderer does (avoids `' <urn:x> '` and `'<urn:x>'`
  // being treated as different keys).
  const trimmed = value.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
}

function splitGraphTriplesForShelf(triples: Triple[]): { canvasTriples: Triple[]; singletonItems: SingletonShelfItem[] } {
  const subjects = new Set<string>();
  const degree = new Map<string, number>();
  const labels = new Map<string, string>();
  // Track which label predicate (by MEMORY_LABEL_PREDICATES index) supplied
  // each label so a later, higher-priority predicate can win regardless of
  // query order — matches the precedence used elsewhere in the UI.
  const labelPriority = new Map<string, number>();

  for (const triple of triples) {
    const subjectKey = graphNodeKey(triple.subject);
    subjects.add(subjectKey);
    const priority = LABEL_PREDICATE_PRIORITY.get(triple.predicate);
    if (priority !== undefined) {
      const label = decodeRdfStringLiteral(triple.object).trim();
      if (label) {
        const existing = labelPriority.get(subjectKey);
        if (existing === undefined || priority < existing) {
          labels.set(subjectKey, label);
          labelPriority.set(subjectKey, priority);
        }
      }
    }
    // Normalise the predicate the same way subjects/objects are normalised
    // — otherwise a wrapped (`<rdf:type>`) or whitespace-padded predicate
    // slips past this guard, gets counted as a regular resource edge, and
    // pulls its class IRI into the connected graph as a phantom node
    // while inflating the subject's degree.
    if (graphNodeKey(triple.predicate) === RDF_TYPE_URI || !isResourceNode(triple.object)) continue;
    const objectKey = graphNodeKey(triple.object);
    degree.set(subjectKey, (degree.get(subjectKey) ?? 0) + 1);
    degree.set(objectKey, (degree.get(objectKey) ?? 0) + 1);
  }

  const singletonItems = [...subjects]
    .filter(key => (degree.get(key) ?? 0) === 0)
    .map(key => ({
      uri: key,
      label: labels.get(key) ?? humanizeLabel(undefined, key),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (singletonItems.length === 0) return { canvasTriples: triples, singletonItems };

  const singletonSet = new Set(singletonItems.map(item => item.uri));
  return {
    // Drop triples whose *subject* OR *object* is on the shelf. Filtering
    // only by subject leaves a triple like `<urn:onCanvas> mentions <urn:shelved>`
    // in the canvas, rendering `urn:shelved` as a connected node while a
    // chip with the same URI also sits in the shelf — the user sees the
    // same entity in two places, possibly with two different labels.
    canvasTriples: triples.filter(triple =>
      !singletonSet.has(graphNodeKey(triple.subject))
      && !singletonSet.has(graphNodeKey(triple.object))
    ),
    singletonItems,
  };
}

function defaultGraphScopeLabel(layer: 'wm' | 'swm' | 'vm'): string {
  if (layer === 'wm') return 'Working Memory graph: local entities connected by entity-to-entity triples from loaded layer data.';
  if (layer === 'swm') return 'Shared Working Memory graph: promoted shared entities connected by entity-to-entity triples from loaded layer data.';
  return 'Verifiable Memory graph: published knowledge assets, provenance anchors, and connected entity-to-entity triples from loaded layer data.';
}

function GraphSingletonShelf({
  items,
  onSelect,
}: {
  items: SingletonShelfItem[];
  onSelect?: (uri: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="v10-graph-singleton-shelf" aria-label="Standalone entities without visible links">
      <div
        className="v10-graph-singleton-head"
        title="Entities with no visible links are grouped here to keep the graph readable."
      >
        <span>Standalone entities</span>
        <span>{items.length}</span>
      </div>
      <div className="v10-graph-singleton-list">
        {items.map(({ uri, label }) => {
          return (
            <button
              key={uri}
              type="button"
              className="v10-graph-singleton-item"
              title={uri}
              onClick={() => onSelect?.(uri)}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GraphSurface({
  title,
  scopeLabel,
  tone,
  className,
  rail,
  overlay,
  showScopeLabel = true,
  singletonItems = [],
  onSingletonClick,
  renderGraph,
}: {
  title: string;
  scopeLabel: string;
  tone: 'wm' | 'swm' | 'vm';
  className?: string;
  rail?: ReactNode;
  overlay?: ReactNode;
  showScopeLabel?: boolean;
  singletonItems?: SingletonShelfItem[];
  onSingletonClick?: (uri: string) => void;
  renderGraph: (expanded: boolean) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [expanded]);

  const expandButton = (
    <button
      type="button"
      className={`v10-graph-expand-btn${showScopeLabel ? '' : ' in-canvas'}`}
      onClick={() => setExpanded(true)}
      title={`Expand ${title}`}
      aria-label={`Expand ${title}`}
    >
      &#10530;
    </button>
  );

  const body = (expandedView: boolean) => (
    <>
      {/* Don't render the scope-bar + expand-button inside the expanded
          modal — the modal has its own × close affordance and a dedicated
          subtitle. The previous CSS-only hide (display:none) left the
          duplicate expand button in the a11y tree. */}
      {showScopeLabel && !expandedView && (
      <div className="v10-graph-shell-bar">
        <div className="v10-graph-scope" title={scopeLabel}>{scopeLabel}</div>
        {expandButton}
      </div>
      )}
      <div className="v10-graph-body">
        <div className="v10-graph-canvas">
          {!showScopeLabel && !expandedView && expandButton}
          <div className="v10-graph-view">
            {renderGraph(expandedView)}
          </div>
          {overlay && <div className="v10-graph-overlay">{overlay}</div>}
          <GraphSingletonShelf items={singletonItems} onSelect={onSingletonClick} />
        </div>
        {rail && <aside className="v10-graph-rail">{rail}</aside>}
      </div>
    </>
  );

  return (
    <>
      <div className={`v10-graph-shell v10-graph-shell-${tone}${className ? ` ${className}` : ''}`}>
        {!expanded && body(false)}
      </div>
      {expanded && (
        <div
          className="v10-graph-expanded-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`${title} expanded`}
          onClick={(event) => {
            if (event.target === event.currentTarget) setExpanded(false);
          }}
        >
          <div className={`v10-graph-expanded-panel v10-graph-shell-${tone}`}>
            <div className="v10-graph-expanded-head">
              <div>
                <div className="v10-graph-expanded-title">{title}</div>
                <div className="v10-graph-expanded-subtitle">{scopeLabel}</div>
              </div>
              <button
                type="button"
                className="v10-graph-expanded-close"
                onClick={() => setExpanded(false)}
                aria-label={`Close expanded ${title}`}
              >
                ×
              </button>
            </div>
            <div className="v10-graph-expanded-body">
              {body(true)}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

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
  // Triples: canonical layer-correct total exposed by the hook
  // (§4.2.1 trap — do NOT sum per-entity tripleCount, do NOT borrow
  // SubGraphBar's `totalTriples` which excludes the root bucket).
  //
  // Codex review bug B — `useMemoryEntities` preserves partial
  // results when one layer query fails, so `allTriples.length` is
  // only a LOWER BOUND in that case. Mirror the Entities cell
  // logic: 'Unavailable' if every layer errored, '<n>+' when
  // partial, the plain number otherwise. The tooltip carries the
  // explanation (consistent with the Delta-2 tooltip-only hint
  // pattern).
  const triplesCount = memory.allTriples?.length ?? 0;
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

// ─── Layer graph panel (used by LayerContent in both inline and full views) ──

export function LayerGraphPanel({
  layer,
  triples,
  onNodeClick,
  contextGraphId,
  scopeLabel,
  trustLegendActiveLayer,
  title: titleOverride,
  scopeEntities,
  swmAttribution,
  layerEntities,
  nodeColorsOverride,
}: {
  layer: 'wm' | 'swm' | 'vm';
  triples: Triple[];
  onNodeClick?: (node: any) => void;
  contextGraphId?: string;
  scopeLabel?: string;
  trustLegendActiveLayer?: 'wm' | 'swm' | 'vm' | null;
  title?: string;
  /**
   * Per-URI colour override passed straight into the graph style's
   * `nodeColors` slot. Sits ABOVE `classColors` / `namespaceColors`
   * in the style-engine priority stack, so the caller wins for
   * specified URIs while unspecified nodes still inherit the
   * existing class/namespace palette and layer defaults. Used by
   * `SubGraphDetailView` (multi-layer view) to paint per-entity
   * trust colour (TRUST_COLORS keyed by `entity.trustLevel`) on
   * top of the WM-default-layer fallback (fold-in #6, PR #677
   * follow-up). Omit on the WM/SWM/VM layer tabs — SWM's own
   * attribution palette via `swmAttribution` still runs.
   */
  nodeColorsOverride?: Record<string, string>;
  // When provided, the panel guarantees every URI in this set appears
  // either on the canvas or on the singleton shelf. Used by callers
  // (e.g. SubGraphDetailView) whose entity scope can include entities
  // that have no triples in the rendered triple set (e.g. promoted SWM
  // entities whose triples live in `_shared_memory` and don't pass the
  // sub-graph filter). Without this, those entities silently disappear
  // from the Graph tab even though the Entities tab shows them.
  scopeEntities?: ReadonlyArray<{ uri: string; label: string }>;
  /**
   * Codex Code6 (PR #656) — when the parent already calls
   * `useSwmAttributions` (e.g. `ProjectView` shares one result between
   * the Overview activity feed and the SWM graph), it can pass that
   * result in here to suppress the internal hook call. Without this,
   * the SPARQL fires twice on every SWM-tab render. When omitted, the
   * panel falls back to the local hook (the long-standing behaviour
   * preserved for all other callsites — `SubGraphDetailView`,
   * `EntityDetailView`, tests).
   */
  swmAttribution?: SwmAttributionsResult;
  /**
   * Task #25 (PR #677) — the layer's `entityList` (entities whose
   * canonical layer matches this panel's `layer`). When supplied,
   * the panel filters object-side resources against entity membership
   * via `filterTriplesToEntities` so pure-object URIs (vocabulary
   * constants, `ipfs://` file refs, `did:` identity refs, blank-node
   * compound-property anchors) don't render as canvas nodes. Omit
   * (or pass an empty array) to preserve the legacy behaviour where
   * the panel renders every resource referenced in `triples`.
   */
  layerEntities?: ReadonlyArray<MemoryEntity>;
}) {
  const { title: layerTitle } = LAYER_CONFIG[layer];
  const title = titleOverride ?? layerTitle;
  const theme = useLayoutStore(s => s.theme);

  // All URIs that already appear as subject or object in the base VM triples.
  // We pass this into the anchor hook so synthetic anchor→entity edges only
  // get emitted for entities that actually render, avoiding dangling anchors.
  const visibleEntityUris = useMemo(() => {
    if (layer !== 'vm') return undefined;
    const s = new Set<string>();
    for (const t of triples) {
      s.add(t.subject);
      // Literals (`"..."`) are never anchor roots; skip them.
      if (isResourceNode(t.object)) s.add(t.object);
    }
    return s;
  }, [triples, layer]);

  // VM-only provenance decorations — synthetic anchor + agent identity
  // triples injected around every published KA root. Keeps the data on-disk
  // untouched; the "halo" of trust lives purely in the viz.
  const { anchors, decorationTriples } = useVerifiedMemoryAnchors(
    layer === 'vm' && contextGraphId ? contextGraphId : undefined,
    visibleEntityUris,
  );

  // SWM-only agent attribution — colours each root KA by the agent that
  // promoted it, so the graph reads as "who proposed what". Also surfaces
  // conflict nodes (multi-agent disagreement) and an agent palette for the
  // legend. No-op on WM / VM.
  //
  // Codex Code6 (PR #656) — when the parent passes `swmAttribution`
  // it has already paid for the SPARQL (e.g. `ProjectView` shares the
  // result with the Overview activity feed). Skip the internal hook's
  // network call by passing `undefined`, then read from the prop. The
  // hook still runs (rules of hooks) but short-circuits to empty state.
  const localSwmAttr = useSwmAttributions(
    layer === 'swm' && contextGraphId && !swmAttribution ? contextGraphId : undefined,
  );
  const swmAttr = swmAttribution ?? localSwmAttr;

  // Task #25 (PR #677) — entity-only graph filter, render-path side.
  // `useLayerTriples` stays the honest source of all layer triples
  // (triple counts, VM hero stats depend on that). The graph view is
  // the only surface that wants "@id-entities only" semantics, so the
  // filter lives here. Callers that don't pass `layerEntities` (older
  // callsites, tests) keep the legacy behaviour of rendering every
  // resource referenced in `triples`.
  //
  // Codex Ev_St/EwIbh: the filter must run on the BASE layer triples
  // BEFORE `decorationTriples` are merged in. VM provenance overlay
  // triples (`urn:dkg:viz:anchor:*`, `urn:dkg:viz:agent:*`) are
  // synthetic, never present in `layerEntities`, and must always
  // render. Filtering after the merge would strip the entire trust
  // halo from published Knowledge Assets.
  const filteredBaseTriples = useMemo(() => {
    if (!layerEntities || layerEntities.length === 0) return triples;
    const entityUris = new Set<string>();
    for (const e of layerEntities) entityUris.add(canonicalEntityUri(e.uri));
    return filterTriplesToEntities(triples, entityUris);
  }, [triples, layerEntities]);

  const uniqueTriples = useMemo(() => {
    const seen = new Set<string>();
    const out: Triple[] = [];
    const push = (t: Triple) => {
      const key = `${t.subject}|${t.predicate}|${t.object}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ subject: t.subject, predicate: t.predicate, object: t.object } as Triple);
    };
    for (const t of filteredBaseTriples) push(t);
    // Decoration triples are only produced for VM; for other layers the
    // hook returns an empty array so this loop is a no-op. They
    // intentionally bypass `filterTriplesToEntities` — synthetic viz
    // nodes aren't in `entityList` by design and must always show as
    // the trust halo around published KAs.
    for (const t of decorationTriples) push(t);
    return out;
  }, [filteredBaseTriples, decorationTriples]);

  const renderTriples = uniqueTriples;

  // Per-URI node tints by layer:
  //   • SWM uses `swmAttr.nodeColors` (agent attribution).
  //   • Multi-layer sub-graph callers pass `nodeColorsOverride`
  //     keyed by `entity.trustLevel` so the canvas matches the
  //     entity's canonical layer (fold-in #6).
  //   • WM / VM layer tabs use neither — classColors rules.
  // When both are supplied (SWM sub-graph view), merge with the
  // caller's override taking precedence — it's the more specific
  // intent. The style engine still falls back to classColors /
  // namespaceColors / `defaultNodeColor` for unspecified URIs.
  const mergedNodeColors = useMemo(() => {
    const swm = layer === 'swm' ? swmAttr.nodeColors : undefined;
    if (!swm && !nodeColorsOverride) return undefined;
    if (!swm) return nodeColorsOverride;
    if (!nodeColorsOverride) return swm;
    return { ...swm, ...nodeColorsOverride };
  }, [layer, swmAttr.nodeColors, nodeColorsOverride]);
  const graphOptions = useMemo(
    () => buildLayerGraphOptions(layer, mergedNodeColors),
    [layer, mergedNodeColors],
  );
  const { canvasTriples, singletonItems } = useMemo(
    () => splitGraphTriplesForShelf(renderTriples),
    [renderTriples],
  );

  // Union `singletonItems` (URIs that are *subjects* of triples but have
  // no resource→resource edges) with any caller-supplied scope entity
  // that doesn't already appear on canvas or shelf. Without this, an
  // entity that exists in the scope (e.g. `SubGraphDetailView`'s
  // `scopedEntities`) but has no triples in the rendered triple set
  // — say a promoted SWM entity whose triples live in `_shared_memory`
  // and don't pass the sub-graph scope filter — silently disappears.
  const shelfItems = useMemo(() => {
    if (!scopeEntities || scopeEntities.length === 0) return singletonItems;
    const known = new Set(singletonItems.map(item => graphNodeKey(item.uri)));
    for (const t of canvasTriples) {
      known.add(graphNodeKey(t.subject));
      if (isResourceNode(t.object)) known.add(graphNodeKey(t.object));
    }
    const extra: SingletonShelfItem[] = [];
    for (const entity of scopeEntities) {
      const key = graphNodeKey(entity.uri);
      if (known.has(key)) continue;
      known.add(key);
      extra.push({ uri: key, label: entity.label || humanizeLabel(undefined, key) });
    }
    if (extra.length === 0) return singletonItems;
    return [...singletonItems, ...extra].sort((a, b) => a.label.localeCompare(b.label));
  }, [singletonItems, canvasTriples, scopeEntities]);
  const graphKey = `${contextGraphId ?? 'context'}:${layer}`;
  const swmAttributionPending = layer === 'swm' && Boolean(contextGraphId) && swmAttr.loading;
  const graphTitle = `${title} graph`;
  const resolvedScopeLabel = scopeLabel ?? defaultGraphScopeLabel(layer);
  const showGraphScopeLabel = trustLegendActiveLayer === null && Boolean(scopeLabel);
  const nodeLayerContext = trustLegendActiveLayer === null ? undefined : trustLegendActiveLayer ?? layer;
  const hasOverlay = (layer === 'vm' && anchors.length > 0) || (layer === 'swm' && swmAttr.palette.length > 0);
  const overlay = hasOverlay ? (
    <>
      {layer === 'vm' && anchors.length > 0 && (
        <VerifiedGraphLegend anchors={anchors} />
      )}
      {layer === 'swm' && swmAttr.palette.length > 0 && (
        <SwmAttributionLegend palette={swmAttr.palette} conflicts={swmAttr.conflicts.length} />
      )}
    </>
  ) : null;
  const graphViewConfig = useMemo(() => ({
    name: `${graphKey}:${theme}`,
    palette: theme,
  }), [graphKey, theme]);

  if (uniqueTriples.length === 0 && shelfItems.length === 0) {
    return (
      <GraphSurface
        title={graphTitle}
        scopeLabel={resolvedScopeLabel}
        tone={layer}
        className="v10-graph-view-fill"
        showScopeLabel={showGraphScopeLabel}
        renderGraph={() => (
          <div className="v10-layer-empty-shell">
            <EmptyState
              compact
              tone={toneForLayer(layer)}
              icon={LAYER_CONFIG[layer].icon}
              title={`No triples in ${title}`}
              description="The graph will appear when this layer has connected triples."
            />
          </div>
        )}
      />
    );
  }

  if (swmAttributionPending) {
    return (
      <GraphSurface
        title={graphTitle}
        scopeLabel={resolvedScopeLabel}
        tone="swm"
        className="v10-graph-view-fill"
        showScopeLabel={showGraphScopeLabel}
        renderGraph={() => (
          <div className="v10-layer-empty-shell">
            <EmptyState
              compact
              tone="swm"
              icon={LAYER_CONFIG.swm.icon}
              title="Loading Shared Working Memory attribution..."
              description="Agent colors are being prepared before the graph renders."
            />
          </div>
        )}
      />
    );
  }

  return (
    <GraphSurface
      title={graphTitle}
      scopeLabel={resolvedScopeLabel}
      tone={layer}
      className="v10-graph-view-fill"
      overlay={overlay}
      showScopeLabel={showGraphScopeLabel}
      singletonItems={shelfItems}
      onSingletonClick={(uri) => onNodeClick?.(nodeLayerContext ? { id: uri, trustLayer: nodeLayerContext } : { id: uri })}
      renderGraph={(expanded) => (
        canvasTriples.length > 0 ? (
          <Suspense fallback={<span className="v10-graph-placeholder">Loading graph...</span>}>
            <RdfGraph
              key={`${graphKey}:${expanded ? 'expanded' : 'inline'}:${canvasTriples.length}`}
              data={canvasTriples}
              format="triples"
              options={graphOptions}
              viewConfig={graphViewConfig}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
              onNodeClick={nodeLayerContext
                ? (node: any) => onNodeClick?.({ ...node, trustLayer: nodeLayerContext })
                : onNodeClick}
              initialFit
            />
          </Suspense>
        ) : (
          <div className="v10-graph-placeholder v10-graph-placeholder-centered">
            Connected graph appears when this layer has linked entities.
          </div>
        )
      )}
    />
  );
}

// ─── SWM attribution legend (docked rail) ────────────
// Maps each palette slot to the agent who promoted the corresponding KA roots.
// N3's broader multi-agent attribution remains gated, so this stays scoped to
// the root attribution data already available today.
export function SwmAttributionLegend({ palette, conflicts }: { palette: AgentPaletteEntry[]; conflicts: number }) {
  return (
    <div className="v10-swm-legend" aria-label="SWM attribution legend">
      <div className="v10-swm-legend-row v10-swm-legend-head">
        <span>SWM attribution</span>
        <span className="v10-swm-legend-count">{palette.length} agent{palette.length === 1 ? '' : 's'}</span>
      </div>
      {palette.slice(0, 8).map(p => (
        <div key={p.agent} className="v10-swm-legend-row" title={p.agent}>
          <span className="v10-swm-legend-swatch" style={{ background: p.color }} />
          <span className="v10-swm-legend-label">{p.label}</span>
          <span className="v10-swm-legend-metric">{p.entityCount}</span>
        </div>
      ))}
      {conflicts > 0 && (
        <div className="v10-swm-legend-row v10-swm-legend-conflict">
          <span className="v10-swm-legend-swatch" style={{ background: '#f59e0b' }}>!</span>
          <span className="v10-swm-legend-label">In review</span>
          <span className="v10-swm-legend-metric">{conflicts}</span>
        </div>
      )}
    </div>
  );
}

// ─── Verifiable Memory graph legend (docked rail) ─────────
// Explains the synthetic VM anchor and agent decoration triples produced by
// `useVerifiedMemoryAnchors` without pulling in the later VM metadata work.
export function VerifiedGraphLegend({ anchors }: { anchors: PublishAnchor[] }) {
  const signerCount = useMemo(() => {
    const s = new Set<string>();
    for (const a of anchors) for (const g of a.agents) s.add(g);
    return s.size;
  }, [anchors]);
  const latest = anchors[0]?.publishedAt;
  const latestLabel = (() => {
    if (!latest) return null;
    try {
      return new Date(latest).toLocaleString(undefined, {
        month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
    } catch { return null; }
  })();

  return (
    <div className="v10-vm-legend" aria-label="Verifiable Memory legend">
      <div className="v10-vm-legend-row v10-vm-legend-head">
        <span>VM provenance layer</span>
        <span className="v10-vm-legend-count">{anchors.length} anchor{anchors.length === 1 ? '' : 's'}</span>
      </div>
      <div className="v10-vm-legend-row">
        <span className="v10-vm-legend-swatch" style={{ background: '#f5a524' }}>◉</span>
        <span className="v10-vm-legend-label">On-chain anchor</span>
      </div>
      <div className="v10-vm-legend-row">
        <span className="v10-vm-legend-swatch" style={{ background: '#c084fc' }}>◈</span>
        <span className="v10-vm-legend-label">Agent identity ({signerCount})</span>
      </div>
      <div className="v10-vm-legend-row">
        <span className="v10-vm-legend-swatch" style={{ background: '#4ade80' }}>—</span>
        <span className="v10-vm-legend-label">Signed / anchored edge</span>
      </div>
      {latestLabel && (
        <div className="v10-vm-legend-foot">Latest: {latestLabel}</div>
      )}
    </div>
  );
}

// S2 finalize: the expandable WM/SWM/VM `MemoryStrip` /
// `MemoryStripExpanded` duplicated the layer tabs and was removed
// from the Overview branch in PR #615. The exports lingered with
// no production caller. Removed here per "no backwards-compat
// shims" (initial release).

// ─── Generative Widget Components ─────────────────────────────

export function GenWidget({ title, agent, footnote, dismissed, onDismiss, children }: {
  title: string;
  agent?: string;
  footnote?: string;
  dismissed?: boolean;
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`v10-gen-widget ${dismissed ? 'dissolved' : ''}`}>
      <div className="v10-gen-widget-header">
        <span className="v10-gen-widget-title">{title}</span>
        <div className="v10-gen-widget-right">
          {agent && (
            <span className="v10-gen-widget-agent">
              <span className="v10-gen-widget-agent-dot" />
              {agent}
            </span>
          )}
          {onDismiss && (
            <button className="v10-gen-widget-dismiss" onClick={onDismiss}>✕</button>
          )}
        </div>
      </div>
      <div className="v10-gen-widget-body">{children}</div>
      {footnote && <div className="v10-gen-widget-footnote">{footnote}</div>}
    </div>
  );
}

export function TypeBreakdownWidget({ entities }: { entities: MemoryEntity[] }) {
  const profile = useProjectProfileContext();
  const breakdown = useMemo(() => {
    const counts = new Map<string, { icon: string; count: number }>();
    for (const e of entities) {
      const { icon, type } = entityMeta(e, profile);
      const existing = counts.get(type);
      if (existing) existing.count++;
      else counts.set(type, { icon, count: 1 });
    }
    return [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [entities, profile]);

  if (breakdown.length === 0) return null;

  return (
    <GenWidget title="Entity Types">
      <StatStrip
        compact
        items={breakdown.map(([type, { icon, count }]) => ({
          id: type,
          label: `${icon} ${type}`,
          value: count,
        }))}
      />
    </GenWidget>
  );
}

export function LayerStatsWidget({ entities, entityCount, triples, layer }: {
  entities: MemoryEntity[];
  entityCount: number;
  triples: number;
  layer: 'wm' | 'swm' | 'vm';
}) {
  const docCount = useMemo(
    () => entities.filter(e => e.properties.has('http://dkg.io/ontology/sourceContentType')).length,
    [entities]
  );
  const totalConns = useMemo(
    () => entities.reduce((sum, e) => sum + e.connections.length, 0),
    [entities]
  );
  const avgConns = entities.length > 0 ? (totalConns / entities.length).toFixed(1) : '0';
  return (
    <GenWidget title="Layer Stats">
      <StatStrip
        compact
        layer={layer}
        items={[
          { id: 'entities', label: layerNoun(layer, entityCount), value: entityCount },
          { id: 'triples', label: 'Triples', value: triples },
          { id: 'connections', label: 'Connections', value: totalConns },
          { id: 'avg', label: 'Avg. connections / entity', value: avgConns },
          ...(docCount > 0 ? [{ id: 'documents', label: 'Documents', value: docCount }] : []),
        ]}
      />
    </GenWidget>
  );
}

export function LayerActionsWidget({ layer, count, contextGraphId, onComplete }: {
  layer: 'wm' | 'swm';
  count: number;
  contextGraphId: string;
  onComplete: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isWm = layer === 'wm';

  const handleAction = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (isWm) {
        const assertions = await listAssertions(contextGraphId, 'wm');
        let promoted = 0;
        for (const a of assertions) {
          // PR #710 — thread `subGraph` so sub-graph-scoped assertions
          // hit the correct daemon lookup key `(cg, name, subGraph)`.
          const res = await promoteAssertion(contextGraphId, a.name, 'all', a.subGraph);
          promoted += res.promotedCount;
        }
        setResult(`Promoted ${promoted} triple${promoted !== 1 ? 's' : ''} to Shared Memory`);
      } else {
        await publishSharedMemory(contextGraphId);
        setResult('Published to Verifiable Memory');
      }
      onComplete?.();
    } catch (err: any) {
      setError(err.message ?? 'Action failed');
    } finally {
      setBusy(false);
    }
  }, [isWm, contextGraphId, onComplete]);

  if (count === 0) return null;
  const color = isWm ? '#f59e0b' : '#22c55e';
  const target = isWm ? 'Shared Working Memory' : 'Verifiable Memory';
  const noun = layerNoun(layer, count).toLowerCase();

  return (
    <GenWidget title={isWm ? 'Promote' : 'Publish'} footnote={`Moves ${noun} from this layer to ${target}.`}>
      <div className="v10-decision-context" style={{ marginBottom: 10 }}>
        {count} {noun} in this layer can be {isWm ? 'promoted to Shared Working Memory for collaborative review' : 'published to Verifiable Memory on-chain'}.
      </div>
      {result && <div style={{ fontSize: 11, color: 'var(--text-success)', marginBottom: 8 }}>✓ {result}</div>}
      {error && <div style={{ fontSize: 11, color: 'var(--text-danger)', marginBottom: 8 }}>✕ {error}</div>}
      <div className="v10-decision-actions">
        <button
          className={isWm ? 'v10-decision-btn approve' : 'v10-decision-btn primary-cta publish-vm'}
          style={isWm
            ? { borderColor: `${color}50`, color: 'var(--text-warning)', background: `${color}15`, opacity: busy ? 0.5 : 1 }
            : { opacity: busy ? 0.5 : 1 }}
          disabled={busy}
          onClick={handleAction}
        >
          {busy ? '...' : (isWm ? '✓ Promote All → Shared' : '◉ Publish to Verifiable Memory')}
        </button>
      </div>
    </GenWidget>
  );
}

// ─── Horizontal widget strip (stats + types + CTA) for the Entities tab ──

export function LayerWidgetStrip({ layer, entities, entityCount, tripleCount, contextGraphId, onComplete }: {
  layer: 'wm' | 'swm' | 'vm';
  entities: MemoryEntity[];
  entityCount: number;
  tripleCount: number;
  contextGraphId?: string;
  onComplete?: () => void;
}) {
  if (entityCount === 0) {
    return (
      <div className="v10-layer-widgets-strip empty">
        <EmptyState
          compact
          tone={toneForLayer(layer)}
          icon={LAYER_CONFIG[layer].icon}
          title={`No ${layerNoun(layer, 2).toLowerCase()} yet`}
          description={
            layer === 'wm'
              ? 'Import data or chat with agents to populate Working Memory.'
              : layer === 'swm'
                ? 'Promote entities from Working Memory to share them with the team.'
                : 'Publish entities from Shared Working Memory to verify them on-chain.'
          }
        />
      </div>
    );
  }
  return (
    <div className="v10-layer-widgets-strip">
      <div className="v10-layer-widgets-strip-stats">
        <LayerStatsWidget entities={entities} entityCount={entityCount} triples={tripleCount} layer={layer} />
        <TypeBreakdownWidget entities={entities} />
      </div>
      {(layer === 'wm' || layer === 'swm') && (
        <div className="v10-layer-widgets-strip-action">
          <LayerActionsWidget layer={layer} count={entityCount} contextGraphId={contextGraphId} onComplete={onComplete} />
        </div>
      )}
    </div>
  );
}

// ─── Enhanced Entity list (sorted by triple count, with type pill) ──────

const TRUST_BADGE_CONFIG: Record<TrustLevel, { layerKey: 'wm' | 'swm' | 'vm'; icon: string; label: string }> = {
  working:  { layerKey: 'wm',  icon: '◇', label: 'Working'  },
  shared:   { layerKey: 'swm', icon: '◈', label: 'Shared'   },
  verified: { layerKey: 'vm',  icon: '◉', label: 'Verifiable' },
};

export function EntityList({
  entities,
  layerKey,
  layerIcon,
  onSelectEntity,
  onOpenAgent,
  externallySorted = false,
  sortLabel,
  headerExtra,
  timestampPredicate,
  perEntityTrustBadge = false,
}: {
  entities: MemoryEntity[];
  layerKey: 'wm' | 'swm' | 'vm';
  layerIcon: string;
  onSelectEntity: (uri: string) => void;
  onOpenAgent?: (uri: string) => void;
  /** Skip the internal triple-count sort — caller already ordered `entities`. */
  externallySorted?: boolean;
  /** Hint text shown next to the count (e.g. "newest first"). Defaults to
   *  "sorted by triples" when the list does its own sort. */
  sortLabel?: string;
  /** Optional control element rendered to the right of the count
   *  (e.g. a `<select>` for sort mode). */
  headerExtra?: ReactNode;
  /** Predicate (e.g. dcterms:created) whose object value should be rendered
   *  as a relative timestamp on each entity card. Pass `binding.timelinePredicate`
   *  for sub-graphs that have one. */
  timestampPredicate?: string;
  /** When true, render the trailing trust badge from each entity's own
   *  `trustLevel` (cross-layer view — e.g. Subgraph Explorer detail).
   *  When false (default), every row uses `layerKey`/`layerIcon` (the
   *  WM/SWM/VM layer-tab convention). */
  perEntityTrustBadge?: boolean;
}) {
  const profile = useProjectProfileContext();
  const agents = useAgentsContext();
  const noun = layerNoun(layerKey, entities.length).toLowerCase();
  const sorted = useMemo(() => {
    if (externallySorted) return entities;
    const copy = [...entities];
    copy.sort((a, b) => {
      const aCount = a.tripleCount ?? 0;
      const bCount = b.tripleCount ?? 0;
      return bCount - aCount;
    });
    return copy;
  }, [entities, externallySorted]);

  const trustLabel = layerKey === 'vm' ? 'Verifiable' : layerKey === 'swm' ? 'Shared' : 'Working';

  if (entities.length === 0) {
    return (
      <div className="v10-entity-list empty">
        <EmptyState
          compact
          tone={toneForLayer(layerKey)}
          icon={layerIcon}
          title={`No ${layerNoun(layerKey, 2).toLowerCase()} yet`}
          description={`This view will fill when matching ${layerNoun(layerKey, 2).toLowerCase()} are available.`}
        />
      </div>
    );
  }

  const hint = sortLabel ?? (externallySorted ? 'click to open' : 'sorted by triples · click to open');

  return (
    <div className="v10-entity-list">
      <div className="v10-entity-list-header">
        <span className="v10-entity-list-count">{sorted.length} {noun}</span>
        <span className="v10-entity-list-hint">{hint}</span>
        {headerExtra && <span className="v10-entity-list-extra">{headerExtra}</span>}
      </div>
      {sorted.map(e => {
        const { icon, type } = entityMeta(e, profile);
        const tripleCount = e.tripleCount ?? 0;
        const authorUri = entityAuthorUri(e);
        const author = authorUri ? agents?.get(authorUri) : null;
        const ts = timestampPredicate ? entityTimestamp(e, timestampPredicate) : null;
        return (
          <div
            key={e.uri}
            className="v10-entity-card"
            onClick={(ev) => { ev.stopPropagation(); onSelectEntity(e.uri); }}
          >
            <span className="v10-entity-card-icon">{icon}</span>
            <div className="v10-entity-card-main">
              <div className="v10-entity-card-title">{e.label}</div>
              <div className="v10-entity-card-meta">
                {(author || authorUri) && (
                  <AgentChip
                    agent={author ?? undefined}
                    fallbackUri={authorUri ?? undefined}
                    size="sm"
                    onOpenAgent={onOpenAgent}
                  />
                )}
                {type && type !== 'Entity' && (
                  <span className="v10-entity-type-pill">{icon} {type}</span>
                )}
                {ts != null && (
                  <span
                    className="v10-entity-card-timestamp"
                    title={new Date(ts).toLocaleString()}
                  >
                    {formatRelativeTime(ts)}
                  </span>
                )}
                <span className="v10-entity-card-triples">{tripleCount} triples</span>
              </div>
            </div>
            {perEntityTrustBadge ? (() => {
              const badge = TRUST_BADGE_CONFIG[e.trustLevel];
              return (
                <span className={`v10-trust-badge ${badge.layerKey}`} title={`${badge.label} Memory`}>
                  {badge.icon} {badge.label}
                </span>
              );
            })() : (
              <span className={`v10-trust-badge ${layerKey}`}>
                {layerIcon} {trustLabel}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Shared LayerContent (tabs + bodies, used by both inline strip and full page) ──
// (LayerContentTab is declared at the top of the file.)

export function LayerContent({
  layer,
  entities,
  tripleCount,
  layerTriples,
  contextGraphId,
  memory,
  activeTab,
  onTabChange,
  onSelectEntity,
  onNodeClick,
  footer,
  swmAttribution,
}: {
  layer: 'wm' | 'swm' | 'vm';
  entities: MemoryEntity[];
  tripleCount: number;
  layerTriples: Triple[];
  contextGraphId: string;
  memory: ReturnType<typeof useMemoryEntities>;
  activeTab: LayerContentTab;
  onTabChange: (tab: LayerContentTab) => void;
  onSelectEntity: (uri: string) => void;
  onNodeClick?: (node: any) => void;
  footer?: React.ReactNode;
  /** Codex Code6 (PR #656) — optional shared SWM attribution result
   *  hoisted from a common parent (`ProjectView`). Passes straight
   *  through to `LayerGraphPanel` to avoid a duplicate SPARQL query
   *  when the same data is already loaded for the Overview feed. */
  swmAttribution?: SwmAttributionsResult;
}) {
  const config = LAYER_CONFIG[layer];
  const itemsLabel = layerNoun(layer, 2);
  const vmLayerStatus = memory.layerStatus?.vm ?? (memory.loading ? 'loading' : memory.error ? 'error' : 'ok');
  const isInitialVerifiedMemoryLoad = layer === 'vm' && vmLayerStatus === 'loading' && entities.length === 0;
  const isVerifiedMemoryUnavailable = layer === 'vm' && vmLayerStatus === 'error' && entities.length === 0;
  const isEmptyVerifiedMemory = layer === 'vm' && vmLayerStatus === 'ok' && entities.length === 0;
  const entityCount = memory.counts[layer];

  const handleTab = (tab: LayerContentTab) => (e: React.MouseEvent) => {
    e.stopPropagation();
    onTabChange(tab);
  };

  return (
    <>
      <div className="v10-layer-expand-tabs">
        <button
          className={`v10-layer-expand-tab ${activeTab === 'items' ? 'active' : ''}`}
          onClick={handleTab('items')}
        >{itemsLabel}</button>
        {layer !== 'vm' && (
          <button
            className={`v10-layer-expand-tab ${activeTab === 'assertions' ? 'active' : ''}`}
            onClick={handleTab('assertions')}
          >Assertions</button>
        )}
        <button
          className={`v10-layer-expand-tab ${activeTab === 'graph' ? 'active' : ''}`}
          onClick={handleTab('graph')}
        >Graph</button>
        <button
          className={`v10-layer-expand-tab ${activeTab === 'docs' ? 'active' : ''}`}
          onClick={handleTab('docs')}
        >Documents</button>
      </div>

      {activeTab === 'items' && (
        <div className="v10-layer-expand-body entities-tab" data-cg-scroll-key={`layer:${layer}:items`}>
          {layer === 'vm' && !isInitialVerifiedMemoryLoad && !isVerifiedMemoryUnavailable && (
            <VerifiedMemoryHeroBanner
              entities={entities}
              tripleCount={tripleCount}
              contextGraphId={contextGraphId}
            />
          )}
          {isInitialVerifiedMemoryLoad ? (
            <div className="v10-layer-widgets-strip empty">
              <EmptyState
                compact
                tone="vm"
                icon={LAYER_CONFIG.vm.icon}
                title="Loading Verifiable Memory..."
                description="Knowledge Assets are being read from the verified layer."
              />
            </div>
          ) : isVerifiedMemoryUnavailable ? (
            <div className="v10-layer-widgets-strip empty">
              <EmptyState
                compact
                tone="vm"
                icon={LAYER_CONFIG.vm.icon}
                title="Verifiable Memory status unavailable."
                description="This node could not read the verified layer right now."
              />
            </div>
          ) : !isEmptyVerifiedMemory && (
            <>
              <LayerWidgetStrip
                layer={layer}
                entities={entities}
                entityCount={entityCount}
                tripleCount={tripleCount}
                contextGraphId={contextGraphId}
                onComplete={memory.refresh}
              />
              <EntityList
                entities={entities}
                layerKey={layer}
                layerIcon={config.icon}
                onSelectEntity={onSelectEntity}
              />
            </>
          )}
          {footer}
        </div>
      )}

      {activeTab === 'assertions' && layer !== 'vm' && (
        <div className="v10-layer-expand-body full-width">
          <AssertionsList
            contextGraphId={contextGraphId}
            layer={layer}
            onComplete={memory.refresh}
            scrollKey={`layer:${layer}:assertions`}
          />
        </div>
      )}

      {activeTab === 'graph' && (
        <div className="v10-layer-expand-body full-width" data-cg-scroll-key={`layer:${layer}:graph`}>
          <LayerGraphPanel
            layer={layer}
            triples={layerTriples}
            onNodeClick={onNodeClick}
            contextGraphId={contextGraphId}
            swmAttribution={layer === 'swm' ? swmAttribution : undefined}
            layerEntities={entities}
          />
        </div>
      )}

      {activeTab === 'docs' && (
        <div className="v10-layer-expand-body full-width">
          <DocumentsList
            entities={entities}
            contextGraphId={contextGraphId}
            scrollKey={`layer:${layer}:docs`}
          />
        </div>
      )}
    </>
  );
}

// ─── Verifiable Memory Hero Banner ──────────────────────────────
// Sits at the top of the VM tab's "Knowledge Assets" view. Pulls together
// the DKG "secret sauce" into a compact visual: anchoring, consensus,
// agent identity — the verifiability elements that justify the VM's cost.
export function VerifiedMemoryHeroBanner({ entities, tripleCount, contextGraphId }: {
  entities: MemoryEntity[];
  tripleCount: number;
  contextGraphId: string;
}) {
  const totalAssets = entities.length;
  const typeSet = new Set<string>();
  for (const e of entities) for (const t of e.types) typeSet.add(t);
  const typeCount = typeSet.size;

  if (totalAssets === 0) {
    return (
      <div className="v10-vm-hero v10-vm-hero-empty">
        <div className="v10-vm-hero-title">
          <span className="v10-vm-hero-badge">◉ Verifiable Memory</span>
          <div className="v10-vm-hero-heading">
            <span className="v10-vm-hero-headline">Nothing published yet</span>
            <span className="v10-vm-hero-context" title={contextGraphId}>
              Context Graph: {contextGraphId}
            </span>
          </div>
        </div>
        <EmptyState
          compact
          className="v10-vm-empty-state"
          tone="vm"
          icon={LAYER_CONFIG.vm.icon}
          title="No Knowledge Assets yet."
          description="Publish entities from Shared Working Memory to verify them on-chain."
        />
      </div>
    );
  }

  return (
    <div className="v10-vm-hero">
      <div className="v10-vm-hero-title">
        <span className="v10-vm-hero-badge">◉ Verifiable Memory</span>
        <div className="v10-vm-hero-heading">
          <span className="v10-vm-hero-headline">On-chain anchored · cryptographically signed</span>
          <span className="v10-vm-hero-context" title={contextGraphId}>
            Context Graph: {contextGraphId}
          </span>
        </div>
      </div>
      <StatStrip
        className="v10-vm-hero-stats"
        layer="vm"
        items={[
          { id: 'assets', value: totalAssets, label: 'Knowledge Assets' },
          { id: 'triples', value: tripleCount.toLocaleString(), label: 'Verifiable Triples' },
          { id: 'types', value: typeCount, label: 'Entity Types' },
        ]}
      />
      <div className="v10-vm-hero-strip">
        <div className="v10-vm-hero-chip" title="Multi-agent endorsement">
          <span className="v10-vm-hero-chip-dot" style={{ background: '#22c55e' }} />
          Consensus
        </div>
        <div className="v10-vm-hero-chip" title="Published to the DKG blockchain anchor">
          <span className="v10-vm-hero-chip-dot" style={{ background: '#3b82f6' }} />
          On-chain
        </div>
        <div className="v10-vm-hero-chip" title="Each contribution bound to a DID">
          <span className="v10-vm-hero-chip-dot" style={{ background: '#a855f7' }} />
          Agent Identity
        </div>
        <div className="v10-vm-hero-chip" title="Tamper-evident via content hashing">
          <span className="v10-vm-hero-chip-dot" style={{ background: '#f59e0b' }} />
          Content Hash
        </div>
      </div>
    </div>
  );
}

function contextGraphQueryTemplate(contextGraphId: string): string {
  return `SELECT ?g ?s ?p ?o WHERE {
  GRAPH ?g { ?s ?p ?o }
  ${contextGraphQueryFilter(contextGraphId)}
}
LIMIT 1000`;
}

const CONTEXT_GRAPH_QUERY_SUBGRAPH = '__context_graph';
const USER_QUERY_CATALOG_SLUG = 'ui-saved-queries';
const USER_QUERY_CATALOG_NAME = 'Saved queries';
const USER_QUERY_CATALOG_DESCRIPTION = 'User-created SPARQL saved in this node profile for this Context Graph.';
const PROFILE_NS = 'http://dkg.io/ontology/profile/';
const SCHEMA_NS = 'http://schema.org/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
type SavedCatalogQuery = QueryCatalog['queries'][number];

function sparqlString(value: string): string {
  return JSON.stringify(value);
}

function contextGraphQueryFilter(contextGraphId: string): string {
  const cgUri = `did:dkg:context-graph:${contextGraphId}`;
  const cgPrefix = `${cgUri}/`;
  return `FILTER(
    (
      STR(?g) = ${sparqlString(cgUri)} ||
      STRSTARTS(STR(?g), ${sparqlString(cgPrefix)})
    ) &&
    !CONTAINS(STR(?g), "/_private")
  )`;
}

function contextGraphBuiltInCatalog(contextGraphId: string): QueryCatalog {
  const catalogSlug = 'whole-context-graph';
  const catalogName = 'Context graph';
  const catalogRank = -100;
  const subGraph = CONTEXT_GRAPH_QUERY_SUBGRAPH;
  const withQueryDefaults = (query: {
    slug: string;
    name: string;
    description: string;
    sparql: string;
    resultColumn?: string;
    rank: number;
  }) => ({
    subGraph,
    catalogSlug,
    catalogName,
    catalogDescription: 'Ready-made SPARQL included with the Node UI for common Context Graph checks.',
    catalogRank,
    resultColumn: '',
    ...query,
  });

  return {
    slug: catalogSlug,
    subGraph,
    name: catalogName,
    description: 'Ready-made SPARQL included with the Node UI for common Context Graph checks.',
    rank: catalogRank,
    queries: [
      withQueryDefaults({
        slug: 'all-triples',
        name: 'All triples',
        description: 'Show triples across available non-private graphs in this context graph.',
        sparql: contextGraphQueryTemplate(contextGraphId),
        resultColumn: 'o',
        rank: 1,
      }),
      withQueryDefaults({
        slug: 'graphs',
        name: 'Graphs',
        description: 'List available non-private named graphs and triple counts.',
        sparql: `SELECT ?g (COUNT(*) AS ?triples) WHERE {
  GRAPH ?g { ?s ?p ?o }
  ${contextGraphQueryFilter(contextGraphId)}
}
GROUP BY ?g
ORDER BY DESC(?triples)
LIMIT 100`,
        resultColumn: 'g',
        rank: 2,
      }),
      withQueryDefaults({
        slug: 'types',
        name: 'Types',
        description: 'Count entities by RDF type across the context graph.',
        sparql: `SELECT ?type (COUNT(DISTINCT ?s) AS ?entities) WHERE {
  GRAPH ?g { ?s a ?type }
  ${contextGraphQueryFilter(contextGraphId)}
}
GROUP BY ?type
ORDER BY DESC(?entities)
LIMIT 100`,
        resultColumn: 'type',
        rank: 3,
      }),
    ],
  };
}

function querySlug(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'saved-query';
}

function profileUri(contextGraphId: string, kind: 'catalog' | 'query', slug: string): string {
  return `urn:dkg:profile:${encodeURIComponent(contextGraphId)}:${kind}:${encodeURIComponent(slug)}`;
}

function literal(value: string): string {
  return JSON.stringify(value);
}

function intLiteral(value: number): string {
  return `"${value}"^^<${XSD_INTEGER}>`;
}

function buildSavedQueryWrite(contextGraphId: string, name: string, description: string, sparql: string): {
  query: SavedCatalogQuery;
  quads: Array<{ subject: string; predicate: string; object: string; graph: string }>;
} {
  const rank = Date.now();
  const slug = `${querySlug(name)}-${rank.toString(36)}`;
  const catalogUri = profileUri(contextGraphId, 'catalog', USER_QUERY_CATALOG_SLUG);
  const queryUri = profileUri(contextGraphId, 'query', slug);
  const query: SavedCatalogQuery = {
    slug,
    subGraph: CONTEXT_GRAPH_QUERY_SUBGRAPH,
    catalogSlug: USER_QUERY_CATALOG_SLUG,
    catalogName: USER_QUERY_CATALOG_NAME,
    catalogDescription: USER_QUERY_CATALOG_DESCRIPTION,
    catalogRank: 50,
    name,
    description: description || undefined,
    sparql,
    resultColumn: '',
    rank,
  };
  const quads = [
    { subject: catalogUri, predicate: RDF_TYPE, object: `${PROFILE_NS}QueryCatalog`, graph: '' },
    { subject: catalogUri, predicate: `${PROFILE_NS}forSubGraph`, object: literal(CONTEXT_GRAPH_QUERY_SUBGRAPH), graph: '' },
    { subject: catalogUri, predicate: `${PROFILE_NS}displayName`, object: literal(USER_QUERY_CATALOG_NAME), graph: '' },
    { subject: catalogUri, predicate: `${SCHEMA_NS}description`, object: literal(USER_QUERY_CATALOG_DESCRIPTION), graph: '' },
    { subject: catalogUri, predicate: `${PROFILE_NS}rank`, object: intLiteral(50), graph: '' },
    { subject: queryUri, predicate: RDF_TYPE, object: `${PROFILE_NS}SavedQuery`, graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}forSubGraph`, object: literal(CONTEXT_GRAPH_QUERY_SUBGRAPH), graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}inCatalog`, object: catalogUri, graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}displayName`, object: literal(name), graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}sparqlQuery`, object: literal(sparql), graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}rank`, object: intLiteral(rank), graph: '' },
  ];
  if (description) {
    quads.push({ subject: queryUri, predicate: `${SCHEMA_NS}description`, object: literal(description), graph: '' });
  }
  return { query, quads };
}

function appendSavedQueryCatalog(catalogs: QueryCatalog[], query: SavedCatalogQuery): QueryCatalog[] {
  const key = `${CONTEXT_GRAPH_QUERY_SUBGRAPH}|${USER_QUERY_CATALOG_SLUG}`;
  const next = catalogs.map(catalog => ({
    ...catalog,
    queries: [...catalog.queries],
  }));
  const existing = next.find(catalog => `${catalog.subGraph}|${catalog.slug}` === key);
  if (existing) {
    existing.queries = [...existing.queries, query].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    return next;
  }
  return [
    ...next,
    {
      slug: USER_QUERY_CATALOG_SLUG,
      subGraph: CONTEXT_GRAPH_QUERY_SUBGRAPH,
      name: USER_QUERY_CATALOG_NAME,
      description: USER_QUERY_CATALOG_DESCRIPTION,
      rank: 50,
      queries: [query],
    },
  ];
}

function mergeQueryCatalogs(catalogs: QueryCatalog[]): QueryCatalog[] {
  const byCatalog = new Map<string, QueryCatalog>();

  for (const catalog of catalogs) {
    const catalogKey = `${catalog.subGraph}|${catalog.slug}`;
    const existing = byCatalog.get(catalogKey);
    if (!existing) {
      byCatalog.set(catalogKey, {
        ...catalog,
        queries: [...catalog.queries],
      });
      continue;
    }

    const byQuery = new Map(existing.queries.map(query => [
      `${query.subGraph}|${query.catalogSlug}|${query.slug}`,
      query,
    ]));
    for (const query of catalog.queries) {
      const queryKey = `${query.subGraph}|${query.catalogSlug}|${query.slug}`;
      if (!byQuery.has(queryKey)) byQuery.set(queryKey, query);
    }
    existing.queries = Array.from(byQuery.values())
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  }

  return Array.from(byCatalog.values()).sort((a, b) =>
    a.subGraph.localeCompare(b.subGraph)
    || a.rank - b.rank
    || a.name.localeCompare(b.name),
  );
}

function bindingValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'value' in (v as any)) return String((v as any).value);
  return String(v);
}

function shortenBindingValue(value: string): string {
  if (!value) return '—';
  if (value.length <= 140) return value;
  return `${value.slice(0, 110)}...${value.slice(-24)}`;
}

function isBuiltInQueryCatalog(catalog: QueryCatalog): boolean {
  return catalog.subGraph === CONTEXT_GRAPH_QUERY_SUBGRAPH && catalog.slug === 'whole-context-graph';
}

function queryCatalogueScope(catalog: QueryCatalog): 'context' | 'subgraph' {
  return catalog.subGraph === CONTEXT_GRAPH_QUERY_SUBGRAPH ? 'context' : 'subgraph';
}

function queryCatalogueGroupLabel(catalog: QueryCatalog, scope: 'context' | 'subgraph', subGraphLabel?: string): string {
  if (isBuiltInQueryCatalog(catalog)) return 'Built-in presets';
  if (catalog.subGraph === CONTEXT_GRAPH_QUERY_SUBGRAPH && catalog.slug === USER_QUERY_CATALOG_SLUG) {
    return USER_QUERY_CATALOG_NAME;
  }
  if (scope === 'context') return catalog.name;
  return `${subGraphLabel ?? catalog.subGraph}: ${catalog.name}`;
}

function queryCatalogueGroupDescription(catalog: QueryCatalog): string {
  if (isBuiltInQueryCatalog(catalog)) {
    return 'UI-provided SPARQL for common Context Graph checks.';
  }
  if (catalog.subGraph === CONTEXT_GRAPH_QUERY_SUBGRAPH && catalog.slug === USER_QUERY_CATALOG_SLUG) {
    return USER_QUERY_CATALOG_DESCRIPTION;
  }
  return catalog.description ?? '';
}

function queryCatalogueGroupKind(catalog: QueryCatalog, scope: 'context' | 'subgraph'): string {
  if (isBuiltInQueryCatalog(catalog)) return 'Preset';
  return scope === 'context' ? 'Saved' : 'Subgraph';
}

function queryErrorMessage(error: string | null): ReactNode {
  return (
    <>
      <span>Review the query or node response details, then try again.</span>
      {error && <span className="v10-cg-query-error-detail">{error}</span>}
    </>
  );
}

export function ContextGraphQueryView({ contextGraphId }: { contextGraphId: string }) {
  const profile = useProjectProfileContext();
  const defaultQuery = useMemo(() => contextGraphQueryTemplate(contextGraphId), [contextGraphId]);
  const [draftQuery, setDraftQuery] = useState(defaultQuery);
  const [activeQuery, setActiveQuery] = useState(defaultQuery);
  const [activeCatalogQueryKey, setActiveCatalogQueryKey] = useState<string | null>(null);
  const [localSavedCatalogs, setLocalSavedCatalogs] = useState<QueryCatalog[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveDescription, setSaveDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const builtInCatalog = useMemo(() => contextGraphBuiltInCatalog(contextGraphId), [contextGraphId]);
  const queryCatalogs = useMemo(
    () => mergeQueryCatalogs([builtInCatalog, ...localSavedCatalogs, ...(profile?.queryCatalogs ?? [])]),
    [builtInCatalog, localSavedCatalogs, profile?.queryCatalogs],
  );
  const renderedQueryCatalogs = useMemo(
    () => (profile?.loading || profile?.error ? mergeQueryCatalogs([builtInCatalog, ...localSavedCatalogs]) : queryCatalogs),
    [builtInCatalog, localSavedCatalogs, profile?.error, profile?.loading, queryCatalogs],
  );

  useEffect(() => {
    setDraftQuery(defaultQuery);
    setActiveQuery(defaultQuery);
    setActiveCatalogQueryKey(null);
    setLocalSavedCatalogs([]);
    setSaveOpen(false);
    setSaveName('');
    setSaveDescription('');
    setSaveError(null);
    setSaveMessage(null);
  }, [defaultQuery]);

  const { data, loading, error, refresh } = useFetch(
    () => executeQuery(activeQuery, contextGraphId),
    [activeQuery, contextGraphId],
    0,
  );

  const rows = useMemo(
    () => (data as any)?.result?.bindings ?? (data as any)?.results?.bindings ?? [],
    [data],
  );

  const hasSavedProfileQueries = useMemo(
    () => queryCatalogs.some(catalog => !isBuiltInQueryCatalog(catalog) && catalog.queries.length > 0),
    [queryCatalogs],
  );

  const columns = useMemo(() => {
    const out: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!out.includes(key)) out.push(key);
      }
    }
    return out;
  }, [rows]);

  const runQuery = useCallback(() => {
    const next = draftQuery.trim();
    if (!next) return;
    setActiveCatalogQueryKey(null);
    setSaveMessage(null);
    setSaveError(null);
    if (next === activeQuery) {
      refresh();
      return;
    }
    setActiveQuery(next);
  }, [activeQuery, draftQuery, refresh]);

  const resetQuery = useCallback(() => {
    setDraftQuery(defaultQuery);
    setActiveCatalogQueryKey(null);
    setSaveMessage(null);
    setSaveError(null);
    if (activeQuery === defaultQuery) refresh();
    else setActiveQuery(defaultQuery);
  }, [activeQuery, defaultQuery, refresh]);

  const runCatalogQuery = useCallback((key: string, sparql: string) => {
    const next = sparql.trim();
    if (!next) return;
    setActiveCatalogQueryKey(key);
    setDraftQuery(next);
    setSaveMessage(null);
    setSaveError(null);
    if (activeQuery === next) {
      refresh();
      return;
    }
    setActiveQuery(next);
  }, [activeQuery, refresh]);

  const openSaveForm = useCallback(() => {
    const firstLine = draftQuery.trim().split('\n').find(line => line.trim());
    setSaveName(firstLine ? firstLine.replace(/\s+/g, ' ').slice(0, 60) : '');
    setSaveDescription('');
    setSaveError(null);
    setSaveMessage(null);
    setSaveOpen(true);
  }, [draftQuery]);

  const saveQuery = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    const name = saveName.trim();
    const description = saveDescription.trim();
    const sparql = draftQuery.trim();
    if (!name) {
      setSaveError('Name is required.');
      return;
    }
    if (!sparql) {
      setSaveError('Query is empty.');
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const { query, quads } = buildSavedQueryWrite(contextGraphId, name, description, sparql);
      await writeProfileQueryCatalog(contextGraphId, quads);
      setLocalSavedCatalogs(prev => appendSavedQueryCatalog(prev, query));
      const key = `${query.subGraph}|${query.catalogSlug}|${query.slug}`;
      setActiveCatalogQueryKey(key);
      setDraftQuery(query.sparql);
      if (activeQuery === query.sparql) refresh();
      else setActiveQuery(query.sparql);
      setSaveName('');
      setSaveDescription('');
      setSaveOpen(false);
      setSaveMessage('Saved to catalogue.');
    } catch (err: any) {
      setSaveError(err?.message ?? 'Failed to save query.');
    } finally {
      setSaving(false);
    }
  }, [activeQuery, contextGraphId, draftQuery, refresh, saveDescription, saveName]);

  return (
    <div className="v10-memory-layer-view v10-cg-query-view">
      <div className="v10-mlv-header">
        <span className="v10-mlv-icon">⟐</span>
        <div>
          <h2 className="v10-mlv-title">Query Catalogue</h2>
          <p className="v10-mlv-desc">
            Reusable SPARQL for this Context Graph. Use UI presets or save queries for people and local agents to reuse.
          </p>
        </div>
      </div>

      <section className="v10-cg-query-zone v10-cg-query-zone-catalog" aria-labelledby="query-catalogue-saved-title">
        <div className="v10-cg-query-zone-header">
          <div>
            <span className="v10-cg-query-eyebrow">Query Library</span>
            <h3 id="query-catalogue-saved-title">Choose a query</h3>
            <p>Load a preset or saved query into the editor below.</p>
          </div>
        </div>

        {profile?.loading && (
          <EmptyState
            compact
            inline
            tone="query"
            icon="?"
            title="Loading saved queries..."
            description="Built-in presets are available while saved queries load from this node profile."
          />
        )}

        {profile?.error && (
          <EmptyState
            compact
            inline
            tone="danger"
            icon="!"
            title="Saved query catalogue unavailable"
            description={profile.error}
          />
        )}

        {renderedQueryCatalogs.length > 0 && (
          <div className="v10-cg-query-catalog-groups">
            {renderedQueryCatalogs.map((catalog) => {
              const scope = queryCatalogueScope(catalog);
              const binding = scope === 'context' ? undefined : profile?.forSubGraph(catalog.subGraph);
              const color = binding?.color ?? '#38bdf8';
              const label = queryCatalogueGroupLabel(catalog, scope, binding?.displayName);
              const description = queryCatalogueGroupDescription(catalog);
              const kind = queryCatalogueGroupKind(catalog, scope);
              return (
                <div
                  key={`${catalog.subGraph}|${catalog.slug}`}
                  className="v10-cg-query-catalog-group"
                  style={{ '--sg-color': color } as React.CSSProperties}
                >
                  <div className="v10-cg-query-catalog-group-header">
                    <div>
                      <div className="v10-cg-query-catalog-title-row">
                        <span className="v10-cg-query-catalog-kind">{kind}</span>
                        <h4>{label}</h4>
                      </div>
                      {description && <p>{description}</p>}
                    </div>
                  </div>
                  <div className="v10-cg-query-list">
                    {catalog.queries.map((q) => {
                      const key = `${q.subGraph}|${q.catalogSlug}|${q.slug}`;
                      const isActive = activeCatalogQueryKey === key && activeQuery === q.sparql;
                      const chipLabel = q.description ? `${q.name}. ${q.description}` : q.name;
                      return (
                        <button
                          key={key}
                          type="button"
                          className={`v10-cg-query-chip${isActive ? ' active' : ''}`}
                          title={chipLabel}
                          aria-label={`Load query: ${chipLabel}`}
                          onClick={() => runCatalogQuery(key, q.sparql)}
                        >
                          <span className="v10-cg-query-chip-title">{q.name}</span>
                          {q.description && <span className="v10-cg-query-chip-desc">{q.description}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!profile?.loading && !profile?.error && queryCatalogs.length > 0 && !hasSavedProfileQueries && (
          <EmptyState
            compact
            inline
            tone="query"
            icon="?"
            title="No saved queries yet."
            description="Use Save after editing SPARQL to keep a reusable query for this Context Graph."
          />
        )}
      </section>

      <section className="v10-cg-query-zone v10-cg-query-zone-editor" aria-labelledby="query-catalogue-editor-title">
        <div className="v10-cg-query-zone-header">
          <div>
            <span className="v10-cg-query-eyebrow">Ad-hoc SPARQL</span>
            <h3 id="query-catalogue-editor-title">Editor and results</h3>
            <p>Run a one-off query against this Context Graph, or save it when it should become reusable.</p>
          </div>
        </div>

      <div className="v10-cg-query-editor">
        <textarea
          className="v10-cg-query-textarea"
          aria-label="SPARQL editor"
          value={draftQuery}
          onChange={(e) => {
            setDraftQuery(e.target.value);
            setActiveCatalogQueryKey(null);
          }}
          spellCheck={false}
        />
        <div className="v10-cg-query-actions">
          <button className="v10-mlv-run-btn" type="button" onClick={runQuery}>Run</button>
          <button className="v10-mlv-save-btn" type="button" onClick={openSaveForm}>Save</button>
          <button className="v10-mlv-clear-btn" type="button" onClick={resetQuery}>Reset</button>
        </div>
      </div>

      {saveOpen && (
        <form className="v10-cg-query-save-panel" onSubmit={saveQuery}>
          <label className="v10-cg-query-save-field">
            <span>Name</span>
            <input
              type="text"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Query name"
              maxLength={80}
            />
          </label>
          <label className="v10-cg-query-save-field">
            <span>Description</span>
            <input
              type="text"
              value={saveDescription}
              onChange={(e) => setSaveDescription(e.target.value)}
              placeholder="Optional"
              maxLength={180}
            />
          </label>
          <div className="v10-cg-query-save-actions">
            <button type="button" className="v10-mlv-clear-btn" onClick={() => setSaveOpen(false)} disabled={saving}>Cancel</button>
            <button type="submit" className="v10-mlv-run-btn" disabled={saving}>{saving ? 'Saving...' : 'Save query'}</button>
          </div>
        </form>
      )}

      {saveMessage && <p className="v10-mlv-status" style={{ color: 'var(--text-success)' }}>{saveMessage}</p>}
      {saveError && <p className="v10-mlv-status" style={{ color: 'var(--text-danger)' }}>{saveError}</p>}

      <div className="v10-cg-query-results">
        {loading && (
          <EmptyState
            compact
            tone="query"
            icon="?"
            title="Loading query results..."
          />
        )}
        {error && (
          <EmptyState
            compact
            tone="danger"
            icon="!"
            title="Query could not run."
            description={queryErrorMessage(error)}
          />
        )}

        {!loading && !error && rows.length === 0 && (
          <EmptyState
            compact
            tone="query"
            icon="?"
            title="No results for this query."
            description="Adjust the query or run a saved query against this Context Graph."
          />
        )}

        {!loading && !error && rows.length > 0 && (
          <div className="v10-mlv-table-wrap">
            <div className="v10-mlv-result-count">{rows.length} result{rows.length === 1 ? '' : 's'}</div>
            <table className="v10-mlv-table">
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row: Record<string, unknown>, index: number) => (
                  <tr key={index}>
                    {columns.map((column) => {
                      const value = bindingValue(row[column]);
                      return (
                        <td key={column} className="v10-mlv-cell" title={value}>
                          {shortenBindingValue(value)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </section>
    </div>
  );
}

// Small helper: compute unique triples for a given layer slice of memory.

export function AssertionsList({ contextGraphId, layer, onComplete, scrollKey }: {
  contextGraphId: string;
  layer: 'wm' | 'swm';
  onComplete: () => void;
  scrollKey?: string;
}) {
  const { data: assertions, loading, refresh } = useFetch(
    () => listAssertions(contextGraphId, layer),
    [contextGraphId, layer],
    0
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePromote = useCallback(async (assertion: AssertionInfo) => {
    // PR #710 Fix D — busy / React keys must use `graphUri`, not
    // `name`. A root + sub-graph pair can share a name and would
    // otherwise both highlight as busy on a single click. `graphUri`
    // is produced by the daemon and uniquely identifies the row.
    setBusy(assertion.graphUri);
    setResult(null);
    setError(null);
    try {
      if (layer === 'wm') {
        // PR #710 Fix A — sub-graph slug threads into the daemon's
        // `(cg, name, subGraph)` lookup so a row clicked from a
        // sub-graph partition resolves to that partition's
        // assertion, not a same-named root one.
        const res = await promoteAssertion(contextGraphId, assertion.name, 'all', assertion.subGraph);
        setResult(`Promoted ${res.promotedCount} triples to Shared Memory`);
      } else {
        await publishSharedMemory(contextGraphId);
        setResult('Published to Verifiable Memory');
      }
      refresh();
      onComplete();
    } catch (err: any) {
      setError(err.message ?? 'Action failed');
    } finally {
      setBusy(null);
    }
  }, [contextGraphId, layer, refresh, onComplete]);

  const handlePromoteAll = useCallback(async () => {
    if (!assertions?.length) return;
    setBusy('__all__');
    setResult(null);
    setError(null);
    try {
      if (layer === 'wm') {
        let total = 0;
        for (const a of assertions) {
          // PR #710 — see comment on the single-row handler above.
          const res = await promoteAssertion(contextGraphId, a.name, 'all', a.subGraph);
          total += res.promotedCount;
        }
        setResult(`Promoted ${total} triples across ${assertions.length} assertion${assertions.length !== 1 ? 's' : ''}`);
      } else {
        await publishSharedMemory(contextGraphId);
        setResult('Published all to Verifiable Memory');
      }
      refresh();
      onComplete();
    } catch (err: any) {
      setError(err.message ?? 'Action failed');
    } finally {
      setBusy(null);
    }
  }, [assertions, contextGraphId, layer, refresh, onComplete]);

  const scrollRootStyle = { flex: 1, overflow: 'auto' } as const;

  if (loading) {
    return (
      <div className="v10-layer-empty-shell" style={scrollRootStyle} data-cg-scroll-key={scrollKey}>
        <EmptyState
          compact
          tone={toneForLayer(layer)}
          icon={LAYER_CONFIG[layer].icon}
          title="Loading assertions..."
        />
      </div>
    );
  }

  if (!assertions?.length) {
    return (
      <div className="v10-layer-empty-shell" style={scrollRootStyle} data-cg-scroll-key={scrollKey}>
        <EmptyState
          tone={toneForLayer(layer)}
          icon={LAYER_CONFIG[layer].icon}
          title={layer === 'swm'
            ? 'No Shared Working Memory assertions listed yet.'
            : 'No Working Memory assertions yet.'}
          description={layer === 'swm'
            ? 'Promoted assertion contents are available as Shared Working Memory entities. The assertion list will populate once promoted assertions are exposed by the node.'
            : 'Create or import data to stage assertions in Working Memory.'}
        />
      </div>
    );
  }

  const actionLabel = layer === 'wm' ? 'Promote → Shared' : 'Publish to VM';
  const actionAllLabel = layer === 'wm' ? 'Promote All → Shared' : 'Publish all to Verifiable Memory';

  return (
    <div style={scrollRootStyle} data-cg-scroll-key={scrollKey}>
      <div style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{assertions.length} assertion{assertions.length !== 1 ? 's' : ''}</span>
        <button
          className={`v10-layer-expand-footer-btn ${layer === 'wm' ? 'promote' : 'publish'}`}
          disabled={busy !== null}
          onClick={handlePromoteAll}
          style={{ opacity: busy === '__all__' ? 0.5 : 1 }}
        >
          {busy === '__all__' ? '...' : actionAllLabel}
        </button>
      </div>
      {result && <div style={{ padding: '6px 16px', fontSize: 11, color: 'var(--text-success)' }}>✓ {result}</div>}
      {error && <div style={{ padding: '6px 16px', fontSize: 11, color: 'var(--text-danger)' }}>✕ {error}</div>}
      {assertions.map(a => (
        <div key={a.graphUri} className="v10-item-row">
          <span className="v10-item-icon">▤</span>
          <div className="v10-item-info">
            <div className="v10-item-name" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{a.name}</div>
            <div className="v10-item-meta-row">
              {a.tripleCount != null && <span className="v10-item-count">{a.tripleCount} triples</span>}
              {a.subGraph && (
                <span
                  className="v10-item-count v10-item-subgraph"
                  title={`In sub-graph: ${a.subGraph}`}
                >
                  › {truncateMiddle(a.subGraph, 18)}
                </span>
              )}
            </div>
          </div>
          <button
            className={`v10-layer-expand-footer-btn ${layer === 'wm' ? 'promote' : 'publish'}`}
            disabled={busy !== null}
            onClick={ev => { ev.stopPropagation(); handlePromote(a); }}
            style={{ opacity: busy === a.graphUri ? 0.5 : 1, flexShrink: 0 }}
          >
            {busy === a.graphUri ? '...' : actionLabel}
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── Full Layer Detail View (WM / SWM / VM) ─────────────────

export function LayerDetailView({
  layer,
  memory,
  onNodeClick,
  onSelectEntity,
  contextGraphId,
  activeTab,
  onTabChange,
  swmAttribution,
}: {
  layer: 'wm' | 'swm' | 'vm';
  memory: ReturnType<typeof useMemoryEntities>;
  onNodeClick: (node: any) => void;
  onSelectEntity: (uri: string) => void;
  contextGraphId: string;
  activeTab: LayerContentTab;
  onTabChange: (tab: LayerContentTab) => void;
  /** Codex Code6 (PR #656) — pass-through of the parent's shared
   *  SWM attribution result. */
  swmAttribution?: SwmAttributionsResult;
}) {
  const config = LAYER_CONFIG[layer];
  // No wrapper here: `LayerGraphPanel` already injects `trustLayer:
  // nodeLayerContext` (which resolves to `layer` in this path) on every
  // node click; re-wrapping would double-inject the same value.

  const entities = useMemo(
    () => memory.entityList.filter(e => e.trustLevel === config.trustLevel),
    [memory.entityList, config.trustLevel],
  );
  const layerTriples = useLayerTriples(memory, layer);

  return (
    <div className="v10-layer-detail">
      <div className="v10-layer-detail-header">
        <span className="v10-layer-detail-icon" style={{ color: config.color }}>{config.icon}</span>
        <div>
          <div className="v10-layer-detail-title">{config.title}</div>
          <div className="v10-layer-detail-desc">{config.desc}</div>
        </div>
        <div className="v10-layer-detail-actions" />
      </div>
      <div className="v10-layer-detail-body">
        <LayerContent
          layer={layer}
          entities={entities}
          tripleCount={layerTriples.length}
          layerTriples={layerTriples}
          contextGraphId={contextGraphId}
          memory={memory}
          activeTab={activeTab}
          onTabChange={onTabChange}
          onSelectEntity={onSelectEntity}
          onNodeClick={onNodeClick}
          swmAttribution={swmAttribution}
        />
      </div>
    </div>
  );
}

// ─── Documents List ──────────────────────────────────────────


export function DocumentsList({
  entities,
  contextGraphId,
  scrollKey,
}: {
  entities: MemoryEntity[];
  contextGraphId?: string;
  scrollKey?: string;
}) {
  const openTab = useTabsStore(s => s.openTab);

  const docs = useMemo(() => {
    return entities.filter(e => e.properties.has(SOURCE_CONTENT_TYPE));
  }, [entities]);

  const handleOpenDoc = (e: MemoryEntity) => {
    // Tab id shape: `doc:<contextGraphId>|<fileRef>|<contentType>`. The `|`
    // delimiter mirrors the `agent:` tab convention; it cannot appear in a
    // `urn:dkg:file:keccak256:<hex>` ref, a context-graph id, or a MIME type,
    // so the decoder can split unambiguously. We keep the FULL file ref
    // (algorithm prefix intact) — stripping `keccak256:` would make the
    // daemon misread the digest as sha256 and 404. When no source file is
    // linked we encode the entity uri; the viewer detects the missing
    // `urn:dkg:file:` prefix and shows a friendly empty state.
    //
    // The content-type hint must describe the *chosen* ref, not the original
    // upload: for a converter-backed import (e.g. PDF → markdown intermediate)
    // the markdown-form ref holds markdown bytes while `sourceContentType` is
    // `application/pdf`. `resolveDocRef` returns `text/markdown` for the
    // markdown form and only forwards `sourceContentType` for the raw source.
    const markdownFormRef = e.connections.find(c => c.predicate === MARKDOWN_FORM)?.targetUri;
    const sourceFileRef = e.connections.find(c => c.predicate === SOURCE_FILE)?.targetUri;
    const sourceContentType = e.properties.get(SOURCE_CONTENT_TYPE)?.[0] ?? '';
    const { ref, contentType } = resolveDocRef(markdownFormRef, sourceFileRef, sourceContentType);
    openTab({
      id: encodeDocTabId(contextGraphId ?? '', ref ?? e.uri, contentType),
      label: e.label,
      closable: true,
      icon: '📄',
    });
  };

  if (docs.length === 0) {
    return (
      <div className="v10-docs-placeholder v10-layer-empty-shell" style={{ flex: 1 }} data-cg-scroll-key={scrollKey}>
        <EmptyState
          compact
          title="No documents in this layer yet."
          description="Import a file to add document-backed entities."
        />
      </div>
    );
  }

  return (
    <div className="v10-layer-detail-content" data-cg-scroll-key={scrollKey}>
      <div className="v10-items-list">
        {docs.map(e => {
          const contentType = e.properties.get(SOURCE_CONTENT_TYPE)?.[0] ?? '';
          const fileRef = e.connections.find(c => c.predicate === MARKDOWN_FORM || c.predicate === SOURCE_FILE)?.targetUri;
          const fileEntity = fileRef ? entities.find(f => f.uri === fileRef) : undefined;
          const size = fileEntity?.properties.get(DKG_SIZE)?.[0] ?? e.properties.get(DKG_SIZE)?.[0];
          return (
            <div key={e.uri} className="v10-item-row" onClick={() => handleOpenDoc(e)}>
              <span className="v10-item-icon">📄</span>
              <div className="v10-item-info">
                <div className="v10-item-name">{e.label}</div>
                <div className="v10-item-meta-row">
                  {contentType && <span className="v10-item-type">{contentType}</span>}
                  {size && <span className="v10-item-count">· {Math.round(parseInt(size) / 1024)}KB</span>}
                </div>
              </div>
              <button className="v10-item-promote-btn" onClick={ev => { ev.stopPropagation(); handleOpenDoc(e); }}>Open →</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Provenance Bar ──────────────────────────────────────────

// ─── KA Detail View (split-pane: content+triples+graph | provenance) ─────


// Small sub-graph badge rendered next to cross-references so the user
// sees "oh, this link takes me to the github sub-graph" before clicking.
export function SubGraphBadge({
  entity,
  profile,
}: {
  entity: MemoryEntity;
  profile: ReturnType<typeof useProjectProfileContext>;
}) {
  // Pick the first non-meta sub-graph the entity has triples in. Most
  // entities only live in one sub-graph; when they span more, the
  // primary (lowest rank) binding wins.
  const slug = useMemo(() => {
    for (const s of entity.subGraphs) {
      if (s !== 'meta') return s;
    }
    return null;
  }, [entity.subGraphs]);
  if (!slug || !profile) return null;
  const binding = profile.forSubGraph(slug);
  const color = binding?.color ?? '#64748b';
  const icon = binding?.icon ?? '•';
  const label = binding?.displayName ?? slug;
  return (
    <span
      className="v10-subgraph-badge"
      style={{ '--sg-color': color } as React.CSSProperties}
      title={`In sub-graph: ${label}`}
    >
      <span className="v10-subgraph-badge-icon" style={{ color }}>{icon}</span>
      <span className="v10-subgraph-badge-label">{label}</span>
    </span>
  );
}

// ─── Verify on DKG CTA ───────────────────────────────────────
// Two-step progression driven by the profile:
//   WM  -> SWM  : promoteAssertion(sourceAssertion, [uri])  ("Propose…")
//   SWM -> VM   : publishSharedMemory([uri])                ("Ratify…")
// Labels, hints and the promote-path assertion name all come from the
// profile ontology (EntityTypeBinding + SubGraphBinding). A book-research
// project that imports into "character-sheet" / "topic-index" assertions
// and declares "Submit for editorial review" / "Publish as canon" on its
// character binding gets the exact same button with the right copy — no
// UI code changes.
//
// Returns null when no binding declares a promoteLabel / publishLabel
// for the entity's type (correct for derived artifacts like code:File
// or github:Commit that shouldn't be manually progressed).
export function VerifyOnDkgButton({
  entity,
  contextGraphId,
  onVerified,
}: {
  entity: MemoryEntity;
  contextGraphId: string;
  onVerified: () => void;
}) {
  const profile = useProjectProfileContext();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PublishResult | { promotedCount: number } | null>(null);
  const [resultKind, setResultKind] = useState<'promote' | 'publish' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const layer = entity.trustLevel;

  // Resolve the first profile binding whose rdf:type matches the entity
  // AND that declares the copy for this layer's transition. If nothing
  // matches, the CTA is suppressed entirely.
  const binding = useMemo(() => {
    if (!profile) return null;
    for (const t of entity.types) {
      const b = profile.forType(t);
      if (!b) continue;
      if (layer === 'working'  && (b.promoteLabel || b.promoteHint)) return b;
      if (layer === 'shared'   && (b.publishLabel || b.publishHint)) return b;
    }
    return null;
  }, [entity.types, profile, layer]);

  // PR #710 — keep the matched sub-graph slug alongside the binding so
  // the promote call below can pass it to the daemon (the source
  // assertion is sub-graph-scoped; daemon lookup keys on
  // `(cg, name, subGraph)`).
  const sgBinding = useMemo(() => {
    if (!profile) return null;
    for (const s of entity.subGraphs) {
      if (s === 'meta') continue;
      const b = profile.forSubGraph(s);
      if (b?.sourceAssertion) return { binding: b, subGraph: s };
    }
    return null;
  }, [entity.subGraphs, profile]);

  if (layer === 'verified') return null;
  if (!binding) return null;

  const action = layer === 'working'
    ? {
        kind: 'promote' as const,
        label:    binding.promoteLabel ?? 'Promote to Shared Memory',
        hint:     binding.promoteHint  ?? 'Shares this entity with the team.',
        busyCopy: 'Sharing…',
        disabled: !sgBinding?.binding.sourceAssertion,
        disabledReason: !sgBinding?.binding.sourceAssertion
          ? `No sourceAssertion declared on the sub-graph profile — add profile:sourceAssertion to the SubGraphBinding for "${[...entity.subGraphs].filter(s => s !== 'meta')[0] ?? '?'}".`
          : null,
      }
    : {
        kind: 'publish' as const,
        label:    binding.publishLabel ?? 'Verify on DKG',
        hint:     binding.publishHint  ?? 'Anchors this entity on-chain.',
        busyCopy: 'Anchoring…',
        disabled: false,
        disabledReason: null,
      };

  const handle = async () => {
    if (action.disabled) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setResultKind(action.kind);
    try {
      if (action.kind === 'promote') {
        // PR #710 — `sgBinding.sourceAssertion` is itself
        // sub-graph-scoped (the binding came from a SubGraphBinding
        // for slug `sgBinding.subGraph`), so we thread that slug as
        // the 4th arg. Without it the daemon's `(cg, name, subGraph)`
        // lookup falls back to the root-bucket assertion of the same
        // name (404 or wrong-target).
        const r = await promoteAssertion(
          contextGraphId,
          sgBinding!.binding.sourceAssertion!,
          [entity.uri],
          sgBinding!.subGraph,
        );
        setResult(r);
      } else {
        const r = await publishSharedMemory(contextGraphId, [entity.uri]);
        setResult(r);
      }
      onVerified();
    } catch (err: any) {
      setError(err?.message ?? 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const isPublishResult = (r: typeof result): r is PublishResult => !!r && 'status' in r;

  return (
    <div className={`v10-ka-verify v10-ka-verify-${action.kind}`}>
      <div className="v10-ka-verify-head">
        <span className="v10-ka-verify-arrow">
          {action.kind === 'promote' ? '◈' : '◉'}
        </span>
        <span className="v10-ka-verify-title">{action.label}</span>
      </div>
      <div className="v10-ka-verify-hint">{action.hint}</div>
      {action.disabledReason && (
        <div className="v10-ka-verify-err">! {action.disabledReason}</div>
      )}
      {!result && (
        <button
          className={`v10-ka-verify-btn ${action.kind}`}
          onClick={handle}
          disabled={busy || action.disabled}
        >
          {busy ? action.busyCopy : action.label}
        </button>
      )}
      {error && <div className="v10-ka-verify-err">✕ {error}</div>}
      {result && resultKind === 'promote' && !isPublishResult(result) && (
        <div className="v10-ka-verify-ok">
          <div className="v10-ka-verify-ok-row">
            <span className="v10-ka-verify-ok-lbl">Promoted</span>
            <span className="v10-ka-verify-ok-val">
              ✓ {result.promotedCount} triple{result.promotedCount === 1 ? '' : 's'} now in Shared Memory
            </span>
          </div>
          <div className="v10-ka-verify-hint" style={{ marginTop: 6 }}>
            Refresh the entity to see the next step appear.
          </div>
        </div>
      )}
      {result && resultKind === 'publish' && isPublishResult(result) && (() => {
        // OT-RFC-38 §1.1 — a publish without a TX hash never made it to chain.
        // Treat that as failure, not success, so the curator knows the data
        // is NOT in Verified Memory.
        const confirmed = result.status === 'confirmed' && !!result.txHash;
        return (
          <div className={confirmed ? 'v10-ka-verify-ok' : 'v10-ka-verify-err'}>
            <div className="v10-ka-verify-ok-row">
              <span className="v10-ka-verify-ok-lbl">Status</span>
              <span className="v10-ka-verify-ok-val">
                {confirmed ? '✓' : '✕'} {result.status}{confirmed ? '' : ' (NOT on-chain)'}
              </span>
            </div>
            {result.txHash ? (
              <div className="v10-ka-verify-ok-row">
                <span className="v10-ka-verify-ok-lbl">TX hash</span>
                <span className="v10-ka-verify-ok-val mono" title={result.txHash}>
                  {result.txHash}
                </span>
              </div>
            ) : (
              <div className="v10-ka-verify-ok-row">
                <span className="v10-ka-verify-ok-lbl">TX hash</span>
                <span className="v10-ka-verify-ok-val">none — on-chain submission skipped</span>
              </div>
            )}
            {result.blockNumber != null && (
              <div className="v10-ka-verify-ok-row">
                <span className="v10-ka-verify-ok-lbl">Block</span>
                <span className="v10-ka-verify-ok-val mono">#{result.blockNumber}</span>
              </div>
            )}
            {result.kas?.[0]?.tokenId && (
              <div className="v10-ka-verify-ok-row">
                <span className="v10-ka-verify-ok-lbl">Token</span>
                <span className="v10-ka-verify-ok-val mono">#{result.kas[0].tokenId}</span>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

export function KADetailView({ entity, allEntities, allTriples, onNavigate, onClose, contextGraphId, onRefresh, onOpenAgent }: {
  entity: MemoryEntity;
  allEntities: Map<string, MemoryEntity>;
  allTriples: Triple[];
  onNavigate: (uri: string) => void;
  onClose: () => void;
  contextGraphId: string;
  onRefresh: () => void;
  onOpenAgent?: (uri: string) => void;
}) {
  const [pane, setPane] = useState<KAPane>('content');
  const theme = useLayoutStore(s => s.theme);
  const profile = useProjectProfileContext();
  const agents = useAgentsContext();
  const { icon, type } = entityMeta(entity, profile);
  const desc = getDescription(entity);
  const authorUri = entityAuthorUri(entity);
  const author = authorUri ? agents?.get(authorUri) ?? null : null;
  const layerBadge = entity.trustLevel === 'verified' ? 'vm' : entity.trustLevel === 'shared' ? 'swm' : 'wm';
  const layerLabel = entity.trustLevel === 'verified' ? 'Verifiable Memory' : entity.trustLevel === 'shared' ? 'Shared Working Memory' : 'Working Memory';
  const detailNoun = layerNoun(entity.trustLevel, 1);

  const incoming = useMemo(() => {
    const result: Array<{ pred: string; entity: MemoryEntity }> = [];
    for (const [, other] of allEntities) {
      for (const conn of other.connections) {
        if (conn.targetUri === entity.uri) {
          result.push({ pred: shortPred(conn.predicate), entity: other });
        }
      }
    }
    return result;
  }, [entity.uri, allEntities]);

  const entityTriples = useMemo(
    // Canonicalise raw triple sides before comparing — `entity.uri`
    // was canonicalised by `getOrCreate` in `buildEntities`, but
    // `allTriples` keeps the raw daemon strings (which can ship
    // wrapped as `<urn:...>`). Without this both surfaces disagree
    // for wrapped-IRI rows: the entity-row badge counts them (it
    // uses the canonicalised entity key) while this filter would
    // drop them. Idempotent + no-op for already-bare URIs.
    () => allTriples.filter(t =>
      canonicalEntityUri(t.subject) === entity.uri ||
      canonicalEntityUri(t.object) === entity.uri),
    [entity.uri, allTriples]
  );

  // 1-hop neighborhood is the sweet spot for the entity-detail graph:
  // 2-hop quickly explodes (a function pulls in its file, the file's
  // package, every other declaration in the file, etc.) and drowns the
  // visual signal of "what does THIS entity connect to directly".
  const hoodTriples = useMemo(
    () => neighborhoodTriples(entity.uri, allTriples, 1),
    [entity.uri, allTriples]
  );

  // Task #25 (PR #677) — entity-only filter for the entity-detail
  // graph. Mirrors the rule the Entities tab uses via the shared
  // `isFirstClassEntity` predicate exported from `useMemoryEntities`
  // (single source of truth for the membership rule). `allEntities`
  // includes synthesised stubs for pure-object URIs (vocab constants,
  // IPFS refs, DID property values), so we filter to the real entity
  // set before passing it to the graph filter. The focal entity is
  // passed via the helper's `focalSubjects` allowlist so it survives
  // the gate even when the layer's entityList wouldn't otherwise
  // include it — keeps the focal node and its `initialFocus`
  // highlight in sync.
  //
  // The set rebuild is intentionally split from the filter call so
  // navigating between KAs (which changes `entity.uri`/`hoodTriples`
  // but not `allEntities`) doesn't re-iterate the entity map.
  const renderHoodEntityUris = useMemo(() => {
    const set = new Set<string>();
    for (const e of allEntities.values()) {
      if (isFirstClassEntity(e)) set.add(canonicalEntityUri(e.uri));
    }
    return set;
  }, [allEntities]);
  const focalSubjects = useMemo(
    () => new Set<string>([canonicalEntityUri(entity.uri)]),
    [entity.uri],
  );
  const renderHoodTriples = useMemo(
    () => filterTriplesToEntities(hoodTriples, renderHoodEntityUris, { focalSubjects }),
    [hoodTriples, renderHoodEntityUris, focalSubjects],
  );

  const graphOptions = useMemo(() => {
    const focalColor = TRUST_COLORS[entity.trustLevel];
    return {
      labelMode: 'humanized' as const,
      renderer: '2d' as const,
      labels: memoryGraphLabels({ minZoomForLabels: 0.2 }),
      style: {
        namespaceColors: neutraliseBuiltinNamespaces(focalColor),
        defaultNodeColor: focalColor,
        defaultEdgeColor: '#475569',
        edgeWidth: 1.0,
        fontSize: 11,
      },
      hexagon: { baseSize: 7, minSize: 4, maxSize: 10, scaleWithDegree: true },
      focus: { maxNodes: 500, hops: 999 },
    };
  }, [entity.trustLevel]);

  // ViewConfig makes the opened entity visually focal (bigger hexagon)
  // and drives the `<CenterOnEntity>` child to pan the camera to it
  // once force-graph has settled. Identity keyed on the URI so React
  // re-applies the view when we switch entities without unmounting
  // the whole RdfGraph.
  const entityViewConfig = useMemo(() => ({
    name: `entity-${entity.uri}-${theme}`,
    palette: theme,
    focal: { uri: entity.uri, sizeMultiplier: 2.4 },
  }), [entity.uri, theme]);

  // Derive from the actual triples this view renders, NOT from
  // `entity.tripleCount`. The KADetailView is opened with either
  // the raw `allTriples` (overview scope) or the SPO-deduped slice
  // (layer scope, see `ProjectView.dedupeTriplesBySpo`). Reading
  // the precomputed field would freeze on the deduped semantic and
  // disagree with the tab on overview-scoped opens. `entityTriples`
  // is already the filtered set the Triples tab counts rows from.
  const tripleCount = entityTriples.length;

  return (
    <div className="v10-ka-detail">
      <div className="v10-ka-header">
        <button className="v10-ka-back" onClick={onClose}>← Back to Context Graph</button>
        <div className="v10-ka-header-left">
          <div className="v10-ka-label">{detailNoun}</div>
          <div className="v10-ka-name">
            {icon} {entity.label}
            <span className={`v10-trust-badge ${layerBadge}`}>{layerLabel}</span>
          </div>
          <div className="v10-ka-ual">{entity.uri} · {type} · {tripleCount} triples</div>
        </div>
        {(author || authorUri) && (
          <div className="v10-ka-header-author">
            <div className="v10-ka-header-author-label">Proposed by</div>
            <AgentChip
              agent={author ?? undefined}
              fallbackUri={authorUri ?? undefined}
              size="lg"
              showOperator
              onOpenAgent={onOpenAgent}
            />
          </div>
        )}
      </div>

      <div className="v10-ka-split">
        {/* Left pane: Content / Triples / Graph */}
        <div className="v10-ka-left">
          <div className="v10-content-tabs" style={{ margin: '0 -20px', padding: '0 20px', background: 'transparent' }}>
            <button className={`v10-content-tab ${pane === 'content' ? 'active' : ''}`} onClick={() => setPane('content')}>Content</button>
            <button className={`v10-content-tab ${pane === 'triples' ? 'active' : ''}`} onClick={() => setPane('triples')}>Triples</button>
            <button className={`v10-content-tab ${pane === 'graph' ? 'active' : ''}`} onClick={() => setPane('graph')}>Graph</button>
          </div>

          {pane === 'content' && (
            <>
              {/* Profile-driven Generative UI — streamed from the DKG daemon's
                  LLM-backed /api/genui/render for any rdf:type that declares a
                  detailHint. Falls back to the generic detail below if the
                  profile has no binding for this type. */}
              {(() => {
                const binding = entity.types.map(t => profile?.forType(t)).find(b => b?.detailHint);
                if (!binding || !profile?.contextGraphId) return null;
                return (
                  <div className="v10-ka-section">
                    <GenUIEntityPanel
                      contextGraphId={profile.contextGraphId}
                      entityUri={entity.uri}
                    />
                  </div>
                );
              })()}
              {desc && (
                <div className="v10-ka-section">
                  <div className="v10-ka-desc"><p>{desc}</p></div>
                </div>
              )}

              {entity.properties.size > 0 && (
                <div className="v10-ka-section">
                  <div className="v10-ka-section-title">Properties</div>
                  {[...entity.properties].map(([pred, vals]) => (
                    <div key={pred} className="v10-ka-prop">
                      <span className="v10-ka-prop-key">{shortPred(pred)}</span>
                      <span className="v10-ka-prop-val">{vals.join(', ')}</span>
                    </div>
                  ))}
                </div>
              )}

              {entity.connections.length > 0 && (
                <div className="v10-ka-section">
                  <div className="v10-ka-section-title">References ({entity.connections.length})</div>
                  {entity.connections.map((conn, i) => {
                    const target = allEntities.get(conn.targetUri);
                    return (
                      <button key={i} className="v10-ka-conn" onClick={() => onNavigate(conn.targetUri)}>
                        <span className="v10-ka-conn-pred">{shortPred(conn.predicate)}</span>
                        <span className="v10-ka-conn-arrow">→</span>
                        <span className="v10-ka-conn-target">{conn.targetLabel}</span>
                        {target && <SubGraphBadge entity={target} profile={profile} />}
                      </button>
                    );
                  })}
                </div>
              )}

              {incoming.length > 0 && (
                <div className="v10-ka-section">
                  <div className="v10-ka-section-title">Referenced by ({incoming.length})</div>
                  {incoming.map((inc, i) => (
                    <button key={i} className="v10-ka-conn" onClick={() => onNavigate(inc.entity.uri)}>
                      <span className="v10-ka-conn-target">{inc.entity.label}</span>
                      <SubGraphBadge entity={inc.entity} profile={profile} />
                      <span className="v10-ka-conn-arrow">→</span>
                      <span className="v10-ka-conn-pred">{inc.pred}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="v10-ka-meta">
                <span className="v10-ka-meta-item">{icon} {type}</span>
                <span className="v10-ka-meta-item">{tripleCount} triples</span>
                <span className="v10-ka-meta-item">{entity.connections.length} links</span>
              </div>
            </>
          )}

          {pane === 'triples' && (
            <div style={{ marginTop: 8, overflowX: 'auto', border: '1px solid var(--border-default)', borderRadius: 6 }}>
              <table className="v10-ka-triples-table">
                <thead>
                  <tr><th>Subject</th><th>Predicate</th><th>Object</th></tr>
                </thead>
                <tbody>
                  {entityTriples.slice(0, 50).map((t, i) => (
                    <tr key={i}>
                      <td title={t.subject}>{shortPred(t.subject)}</td>
                      <td title={t.predicate}>{shortPred(t.predicate)}</td>
                      <td title={t.object}>{t.object.startsWith('"') ? t.object.replace(/^"|"$/g, '').slice(0, 60) : shortPred(t.object)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', padding: '6px 8px' }}>
                {Math.min(entityTriples.length, 50)} of {entityTriples.length} triples shown
              </div>
            </div>
          )}

          {pane === 'graph' && (
            <GraphSurface
              title={`${entity.label} graph`}
              scopeLabel={`Entity detail graph: 1-hop neighborhood around ${entity.label}.`}
              tone={layerBadge}
              className="v10-ka-graph-shell"
              renderGraph={(expanded) => (
                renderHoodTriples.length > 0 ? (
                  <Suspense fallback={<span className="v10-graph-placeholder">Loading graph...</span>}>
                    <RdfGraph
                      key={`${entity.uri}:${expanded ? 'expanded' : 'inline'}`}
                      data={renderHoodTriples}
                      format="triples"
                      options={graphOptions}
                      viewConfig={entityViewConfig}
                      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                      onNodeClick={(n: any) => n?.id && n.id !== entity.uri && onNavigate(n.id)}
                      initialFit
                      initialFocus={entity.uri}
                    />
                  </Suspense>
                ) : (
                  <div className="v10-graph-placeholder v10-graph-placeholder-centered">No neighborhood data</div>
                )
              )}
            />
          )}
        </div>

        {/* Right pane: Provenance Trail */}
        <div className="v10-ka-right">
          {/* On-chain identity banner — only for VM entities; the hook
              skips its SPARQL when `enabled` is false so there's no
              cost for WM/SWM entities. */}
          <VerifiedIdentityBanner
            contextGraphId={contextGraphId}
            entityUri={entity.uri}
            enabled={entity.trustLevel === 'verified'}
          />
          <div className="v10-ka-section-title">Provenance Trail</div>
          <ProvenanceTrail entity={entity} />

          {/* Verify on DKG — prominent CTA for WM/SWM entities */}
          <VerifyOnDkgButton
            entity={entity}
            contextGraphId={contextGraphId}
            onVerified={onRefresh}
          />

          {/* Trust Summary */}
          <div style={{ marginTop: 16, padding: '10px 12px', borderRadius: 6, background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}>
            <div className="v10-ka-section-title" style={{ marginBottom: 6 }}>Entity Summary</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-tertiary)' }}>Type</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{type}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-tertiary)' }}>Triples</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{tripleCount}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-tertiary)' }}>Links</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{entity.connections.length}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-tertiary)' }}>Layer</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{layerLabel.split(' ')[0]}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Provenance Trail ───────────────────────────────────────
// Layer-by-layer history with per-step agent attribution. Each step
// shows which agent fired the transition plus (when present) the
// timestamp. In the absence of per-transition predicates the step
// falls back to the entity's `prov:wasAttributedTo` so the trail
// always names *someone* — the demo data relies on this fallback
// because our seed scripts promote / publish in bulk without writing
// per-step attribution. When live agents start calling the write
// path they'll emit agent:promotedBy / agent:publishedBy and the
// fallback stops firing.
export function ProvenanceTrail({ entity }: { entity: MemoryEntity }) {
  const agents = useAgentsContext();

  const step = (kind: 'created' | 'promoted' | 'published') => {
    const uri = transitionAgentUri(entity, kind);
    const at  = transitionAtISO(entity, kind);
    const agent = uri ? agents?.get(uri) : null;
    return { uri, at, agent };
  };

  const created   = step('created');
  const promoted  = step('promoted');
  const published = step('published');

  return (
    <div className="v10-ka-timeline">
      {entity.trustLevel === 'verified' && (
        <TrailEvent
          toneClass="verified"
          title="Published to Verifiable Memory"
          actionWord="Published"
          agent={published.agent}
          agentUri={published.uri}
          at={published.at}
        />
      )}
      {(entity.trustLevel === 'shared' || entity.trustLevel === 'verified') && (
        <TrailEvent
          toneClass="shared"
          title="Promoted to Shared Working Memory"
          actionWord="Promoted"
          agent={promoted.agent}
          agentUri={promoted.uri}
          at={promoted.at}
        />
      )}
      <TrailEvent
        toneClass="created"
        title="Created in Working Memory"
        actionWord="Created"
        agent={created.agent}
        agentUri={created.uri}
        at={created.at}
      />
    </div>
  );
}

export function TrailEvent({
  toneClass,
  title,
  actionWord,
  agent,
  agentUri,
  at,
}: {
  toneClass: 'verified' | 'shared' | 'created';
  title: string;
  actionWord: string;
  agent: AgentSummary | null | undefined;
  agentUri: string | null;
  at: string | null;
}) {
  const when = at ? formatTrailTimestamp(at) : null;
  return (
    <div className="v10-ka-event">
      <div className={`v10-ka-event-dot ${toneClass}`} />
      <div className="v10-ka-event-header">
        <span className="v10-ka-event-title">{title}</span>
        {when && <time className="v10-ka-event-time" dateTime={at ?? undefined}>{when}</time>}
      </div>
      {(agent || agentUri) && (
        <div className="v10-ka-event-attribution">
          <span className="v10-ka-event-attribution-prefix">{actionWord} by</span>
          <AgentChip agent={agent ?? undefined} fallbackUri={agentUri ?? undefined} size="sm" />
        </div>
      )}
    </div>
  );
}


// ─── Subgraph Explorer header (page identity + permanent intro) ────
// Shared between the All / Subgraphs-overview state and every chip
// detail (named or Root). The three-sentence intro is non-dismissible —
// the subgraph concept is unfamiliar and needs a tangible always-present
// definition (UX §4.4.1). Wording is locked in §4.4.1 and must stay in
// sync with the empty-state copy below in SubGraphOverviewGrid.
export function SubGraphExplorerHeader() {
  return (
    <div className="v10-subgraph-explorer-header">
      <div className="v10-subgraph-explorer-title">Subgraph Explorer</div>
      <p className="v10-subgraph-explorer-intro">
        Subgraphs are optional topical partitions inside this Context Graph.
        An entity belongs to one or more memory layers and, optionally,
        to one or more subgraphs. Entities in no subgraph live in the
        context graph root.
      </p>
    </div>
  );
}

export function SubGraphOverviewGrid({
  contextGraphId,
  memory,
  onNodeClick,
  onSelectSubGraph,
}: {
  contextGraphId: string;
  memory: ReturnType<typeof useMemoryEntities>;
  onNodeClick?: (node: any) => void;
  onSelectSubGraph: (slug: string) => void;
}) {
  const profile = useProjectProfileContext();
  const [subGraphs, setSubGraphs] = useState<SubGraphInfo[]>([]);
  const [loading, setLoading] = useState(true);
  // Track fetch failure separately from "the daemon returned no
  // sub-graphs". Issue G — the teaching empty state explains the
  // subgraph concept and offers `View root`, which is helpful when
  // the CG genuinely has no sub-graphs yet, but reads as
  // authoritative "all clear" when the cards endpoint actually
  // failed mid-flight. The error branch below renders only when
  // we got nothing from the daemon AND the request failed; a
  // transient failure during refresh (where prior cards are still
  // populated) keeps showing the last good grid.
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    fetchSubGraphs(contextGraphId)
      .then(r => {
        if (!cancelled) {
          setSubGraphs(r.subGraphs ?? []);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFetchError(err instanceof Error ? err.message : 'Failed to load subgraphs');
          // Don't blow away prior `subGraphs` on a refresh failure —
          // the error branch below gates on `cards.length === 0` so
          // last-good cards stay rendered with a stale-but-readable
          // state instead of vanishing.
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [contextGraphId]);

  // Bucket every triple by its origin sub-graph so each mini-graph renders
  // just its slice. We dedupe on (s,p,o) and cap per-bucket to keep the
  // mini-graph canvases snappy. Without the cap, sub-graphs like `code`
  // (~25k triples) can lock up the tab while force-graph runs its layout.
  //
  // Sampling strategy: when a sub-graph exceeds MAX_PER_CARD, we keep
  // every triple for the N heaviest root entities (highest degree) so
  // the user sees a representative, connected slice rather than a
  // random first-N truncation that breaks clusters apart.
  const MAX_PER_CARD = 2500;
  const triplesBySubGraph = useMemo(() => {
    const bySg = new Map<string, Triple[]>();
    const seen = new Map<string, Set<string>>();
    for (const t of memory.allTriples) {
      if (!t.subGraph) continue;
      const key = `${t.subject}|${t.predicate}|${t.object}`;
      let s = seen.get(t.subGraph);
      if (!s) { s = new Set(); seen.set(t.subGraph, s); }
      if (s.has(key)) continue;
      s.add(key);
      let arr = bySg.get(t.subGraph);
      if (!arr) { arr = []; bySg.set(t.subGraph, arr); }
      arr.push({ subject: t.subject, predicate: t.predicate, object: t.object });
    }
    // If a bucket is over the cap, fall back to sampling the heaviest
    // subjects and dropping the long tail. This preserves cluster
    // topology far better than truncation.
    for (const [sg, triples] of bySg) {
      if (triples.length <= MAX_PER_CARD) continue;
      const degree = new Map<string, number>();
      for (const t of triples) degree.set(t.subject, (degree.get(t.subject) ?? 0) + 1);
      const order = [...degree.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([uri]) => uri);
      const keep = new Set<string>();
      let kept = 0;
      for (const uri of order) {
        if (kept >= MAX_PER_CARD) break;
        keep.add(uri);
        kept += degree.get(uri)!;
      }
      bySg.set(sg, triples.filter(t => keep.has(t.subject)));
    }
    return bySg;
  }, [memory.allTriples]);

  // Per-sub-graph layer counts — drives the mini pyramid on each card so
  // you can see at a glance which sub-graphs are mostly verified vs still
  // in flight. Each entity is counted in exactly one layer — its
  // canonical `trustLevel` (its highest layer). This matches the
  // post-M6 layer-switcher / Overview counts and the sub-graph entity
  // list, so the pyramid agrees with what the list under it actually
  // shows when narrowed to one layer chip.
  const layerCountsBySubGraph = useMemo(() => {
    const out = new Map<string, { wm: number; swm: number; vm: number }>();
    for (const e of memory.entityList) {
      for (const sg of e.subGraphs) {
        let counts = out.get(sg);
        if (!counts) { counts = { wm: 0, swm: 0, vm: 0 }; out.set(sg, counts); }
        if (e.trustLevel === 'verified') counts.vm++;
        else if (e.trustLevel === 'shared') counts.swm++;
        else counts.wm++;
      }
    }
    return out;
  }, [memory.entityList]);

  // Task #25 (PR #677) — entity-only filter for the mini-card
  // thumbnails. Same rule the Entities tab uses; computed per card
  // scoped to that card's sub-graph (Codex Ev_S2): an entity that's
  // first-class in sub-graph B but only a value/provenance object in
  // sub-graph A must not render on A's thumbnail. Per-sub-graph scope
  // = `memory.entityList.filter(e => e.subGraphs.has(sg.name))`.
  const entityUrisBySubGraph = useMemo(() => {
    const out = new Map<string, Set<string>>();
    for (const e of memory.entityList) {
      const canonical = canonicalEntityUri(e.uri);
      for (const sg of e.subGraphs) {
        let s = out.get(sg);
        if (!s) { s = new Set(); out.set(sg, s); }
        s.add(canonical);
      }
    }
    return out;
  }, [memory.entityList]);

  // Per-sub-graph URI → trust-level map. Drives the mini-graph
  // per-node trust colouring (#3 polish, ui-locked priority chain).
  // Keyed by canonical URI to match the entity-only filter
  // (`filterTriplesToEntities`) that gates the rendered triple set.
  // Same `entityList` loop as `entityUrisBySubGraph` so the two
  // collections stay aligned (every entity in `entityUrisBySubGraph`
  // has a corresponding `entityTrustByUri` entry).
  const entityTrustByUriBySubGraph = useMemo(() => {
    const out = new Map<string, Map<string, TrustLevel>>();
    for (const e of memory.entityList) {
      const canonical = canonicalEntityUri(e.uri);
      for (const sg of e.subGraphs) {
        let m = out.get(sg);
        if (!m) { m = new Map<string, TrustLevel>(); out.set(sg, m); }
        // PR #793 Codex sweep 4 (Bug M) — defensive dual-key
        // write. Mirrors the dual-key shape in `trustNodeColors`
        // further down this file so consumers can resolve both
        // raw and canonical URI forms.
        //
        // Important: as of HEAD, `useMemoryEntities.ts` calls
        // `canonicalEntityUri(uri)` at entity-storage time
        // (`getOrCreate` ~:386) AND graph-viz's `addTriple`
        // applies `cleanUri()` at ingestion (~core/graph-model.ts:128).
        // Both pipelines therefore canonicalize, so
        // `canonical !== e.uri` is currently unreachable and the
        // raw-key write never fires. Codex sweep 7 (local
        // reviewer) flagged Bug M's fix as dead code under the
        // current architecture — keep this as defence-in-depth
        // against future de-canonicalisation in either pipeline,
        // but DO NOT trust this branch as the active fix for any
        // current wrapped-URI lookup failure. If you remove
        // either canonicalisation, this branch becomes load-
        // bearing again.
        m.set(canonical, e.trustLevel);
        if (canonical !== e.uri) m.set(e.uri, e.trustLevel);
      }
    }
    return out;
  }, [memory.entityList]);

  // Merge registered user-facing sub-graphs with profile bindings so
  // icon/color/label/rank all flow from the single source of truth.
  // `isUserFacingSubGraph` centralises the reserved-slug rule
  // (Codex review issue M) — same filter as SubGraphBar + the
  // Overview Subgraphs stat.
  const cards = useMemo(() => {
    return subGraphs
      .filter(isUserFacingSubGraph)
      .map(sg => {
        const binding = profile?.forSubGraph(sg.name) ?? {};
        const rawTriples = triplesBySubGraph.get(sg.name) ?? [];
        const cardEntityUris = entityUrisBySubGraph.get(sg.name) ?? new Set<string>();
        const cardEntityTrust = entityTrustByUriBySubGraph.get(sg.name) ?? new Map<string, TrustLevel>();
        return {
          slug: sg.name,
          icon: binding.icon ?? '•',
          color: binding.color ?? '#64748b',
          displayName: binding.displayName ?? sg.name,
          description: binding.description,
          rank: binding.rank ?? 99,
          // Use the client-canonicalised entity set size (the same one we
          // use for the filter and that the Entities tab renders) so the
          // mini-card count matches the detail page. The server-reported
          // `sg.entityCount` is a liberal COUNT(DISTINCT ?s) per named
          // graph and can include subjects that fail our entityList
          // membership rule. Fall back to the server count if we have no
          // client set for this sub-graph (e.g. nothing yet hydrated).
          entityCount: cardEntityUris.size > 0 ? cardEntityUris.size : sg.entityCount,
          tripleCount: sg.tripleCount,
          triples: filterTriplesToEntities(rawTriples, cardEntityUris),
          layerCounts: layerCountsBySubGraph.get(sg.name) ?? { wm: 0, swm: 0, vm: 0 },
          entityTrustByUri: cardEntityTrust,
        };
      })
      .sort((a, b) => a.rank - b.rank);
  }, [subGraphs, profile, triplesBySubGraph, layerCountsBySubGraph, entityUrisBySubGraph, entityTrustByUriBySubGraph]);

  if (loading && cards.length === 0) {
    return (
      <EmptyState
        compact
        icon="#"
        title="Loading subgraphs..."
        className="v10-sgov-state"
      />
    );
  }
  // Issue G — distinguish "fetch failed" from "no sub-graphs". A
  // cold-start failure plus the success-empty branch's `View root`
  // CTA reads as authoritative "no subgraphs exist", but it's
  // actually a transient API error. Only render this when the
  // request failed AND we have no last-good cards.
  if (fetchError && cards.length === 0) {
    return (
      <EmptyState
        icon="!"
        title="Couldn't load subgraphs."
        description="Refresh the page to try again."
        tone="danger"
        className="v10-sgov-state"
      />
    );
  }
  if (cards.length === 0) {
    // Teaching empty state (UX §4.4.1). Replaces the previous bare
    // "No sub-graphs registered yet." — explains what a subgraph is,
    // how one comes into being, and offers a one-click jump to the
    // Root bucket so the user can still see their actual data.
    return (
      <EmptyState
        icon="#"
        title="No subgraphs in this Context Graph yet."
        description={
          <>
            A subgraph is a named topical slice of this Context Graph
            (e.g. <code>recipes</code>, <code>decisions</code>). Agents
            create one when they scope an assertion to a subgraph. All
            current entities live in the Context Graph root.
          </>
        }
        actions={[
          { label: 'View root', onClick: () => onSelectSubGraph(ROOT_SLUG_SENTINEL), variant: 'primary' },
        ]}
        className="v10-sgov-state"
      />
    );
  }

  return (
    <div className="v10-sgov">
      <div className="v10-sgov-header">
        <div className="v10-sgov-title">Subgraphs</div>
        <div className="v10-sgov-sub">
          {cards.length} subgraphs · {cards.reduce((a, b) => a + b.entityCount, 0)} entities · {cards.reduce((a, b) => a + b.tripleCount, 0)} triples
        </div>
      </div>
      <div className="v10-sgov-grid">
        {cards.map(card => (
          <SubGraphMiniCard
            key={card.slug}
            card={card}
            onNodeClick={onNodeClick}
            onOpen={() => onSelectSubGraph(card.slug)}
          />
        ))}
      </div>
    </div>
  );
}

export function SubGraphMiniCard({
  card,
  onNodeClick,
  onOpen,
}: {
  card: {
    slug: string; icon: string; color: string; displayName: string;
    description?: string; entityCount: number; tripleCount: number;
    triples: Triple[];
    layerCounts: { wm: number; swm: number; vm: number };
    entityTrustByUri: Map<string, TrustLevel>;
  };
  onNodeClick?: (node: any) => void;
  onOpen: () => void;
}) {
  // Per-URI trust palette for the mini-graph (#3 polish).
  // ui-locked priority chain (graph-viz style engine):
  //   1. `nodeColors[uri]` — wins for any entity carrying a
  //      canonical trust level (TRUST_COLORS[e.trustLevel]).
  //   2. `defaultNodeColor: card.color` — fallback for non-entity
  //      URIs (vocabulary IRIs, blank-node anchors) preserves the
  //      card's chrome identity.
  //   3. `namespaceColors` — built-in graph-viz tints, neutralised
  //      to `card.color` so cross-cutting namespaces don't drown
  //      the per-trust signal.
  // Build at the card scope from `card.entityTrustByUri` (attached
  // by the parent `cards` derivation). The upstream map carries
  // BOTH canonical AND raw URI forms (PR #793 sweep 4 Bug M), so
  // this loop produces a `nodeColors` map that resolves either
  // form the rendered triple set may carry — wrapped `<urn:...>`
  // subjects/objects survive promotion without falling through to
  // `card.color`. Mirrors the dual-key shape in `trustNodeColors`
  // further down this file.
  const nodeColors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [uri, trustLevel] of card.entityTrustByUri) {
      out[uri] = TRUST_COLORS[trustLevel];
    }
    return out;
  }, [card.entityTrustByUri]);

  // A compact-mode graph options block — pared-down labels, smaller nodes,
  // brighter default color (driven by the sub-graph's profile color) so each
  // card reads as a distinct "island" at a glance.
  const graphOptions = useMemo(() => ({
    labelMode: 'humanized' as const,
    renderer: '2d' as const,
    labels: memoryGraphLabels({ minZoomForLabels: 0.8 }), // Keep labels out of the way in the mini view.
    style: {
      classColors: CODE_CLASS_COLORS,
      predicateColors: CODE_PREDICATE_COLORS,
      namespaceColors: neutraliseBuiltinNamespaces(card.color),
      // Per-URI tints sit ABOVE classColors / namespaceColors in
      // the style-engine priority stack — TRUST_COLORS wins for
      // every entity in the card's scope (#3 polish).
      ...(Object.keys(nodeColors).length > 0 ? { nodeColors } : {}),
      defaultNodeColor: card.color,
      defaultEdgeColor: '#475569',
      edgeWidth: 1.0,
      fontSize: 12,
      gradient: true,
      gradientIntensity: 0.35,
    },
    hexagon: { baseSize: 6, minSize: 3, maxSize: 16, scaleWithDegree: true },
    focus: { maxNodes: 5000, hops: 999 },
  }), [card.color, nodeColors]);

  return (
    <div
      className="v10-sgov-card"
      style={{
        '--sg-color': card.color,
        borderColor: card.color + '55',
      } as React.CSSProperties}
    >
      <div className="v10-sgov-card-head">
        <span className="v10-sgov-card-icon" style={{ color: card.color }}>{card.icon}</span>
        <div className="v10-sgov-card-title-wrap">
          <div className="v10-sgov-card-title">{card.displayName}</div>
          {card.description && (
            <div className="v10-sgov-card-desc" title={card.description}>{card.description}</div>
          )}
        </div>
        <button type="button" className="v10-sgov-card-open" onClick={onOpen} title={`Focus on ${card.displayName}`}>
          ↗
        </button>
      </div>
      <div className="v10-sgov-card-stats">
        <span className="v10-sgov-card-stat"><b>{card.entityCount}</b> entities</span>
        <span className="v10-sgov-card-stat"><b>{card.tripleCount}</b> triples</span>
      </div>
      <div className="v10-sgov-card-pyramid">
        {/* compact mode collapses the empty-counts branch to `null`
            inside MiniLayerBar, eliminating the duplicate "No data"
            label that sat next to the card-body fallback. Populated
            cards render identically. (#2 — ui-locked) */}
        <MiniLayerBar counts={card.layerCounts} compact />
      </div>
      <div className="v10-sgov-card-graph">
        {card.triples.length === 0 ? (
          <div className="v10-sgov-card-empty">
            {/* Two-branch wording locked by ux-lead in the #2 amendment.
                `entityCount > 0` AND mini-graph empty means the
                sub-graph has content but no WM-shaped data this card
                can render — pair the literal with the existing ↗ open
                button so the next action is obvious. */}
            {card.entityCount > 0 ? 'Promoted — open to view' : 'No data yet'}
          </div>
        ) : (
          <Suspense fallback={<div className="v10-sgov-card-empty">Loading…</div>}>
            <RdfGraph
              data={card.triples}
              format="triples"
              options={graphOptions}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
              onNodeClick={onNodeClick}
              initialFit
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

// ─── MiniLayerBar ────────────────────────────────────────
// Three-segment WM/SWM/VM bar. Used as a header widget in the sub-graph
// page (clickable — toggles which layers contribute entities) and as a
// compact badge on SubGraphOverviewGrid cards (read-only).
export function MiniLayerBar({
  counts,
  activeLayers,
  onClickLayer,
  compact = false,
}: {
  counts: { wm: number; swm: number; vm: number };
  activeLayers?: Set<TrustLevel>;
  onClickLayer?: (layer: TrustLevel) => void;
  compact?: boolean;
}) {
  const total = counts.wm + counts.swm + counts.vm;
  if (total === 0) {
    return compact ? null : <div className="v10-minibar v10-minibar-empty">No data</div>;
  }
  const rows: Array<{ key: TrustLevel; short: string; count: number; color: string; label: string }> = [
    { key: 'verified', short: 'VM',  count: counts.vm,  color: '#22c55e', label: 'Verifiable' },
    { key: 'shared',   short: 'SWM', count: counts.swm, color: '#f59e0b', label: 'Shared' },
    { key: 'working',  short: 'WM',  count: counts.wm,  color: '#64748b', label: 'Working' },
  ];
  const interactive = !!onClickLayer;
  return (
    <div className={`v10-minibar${compact ? ' compact' : ''}`}>
      {!compact && (
        <div className="v10-minibar-bar">
          {rows.filter(r => r.count > 0).map(r => {
            const pct = (r.count / total) * 100;
            const active = activeLayers ? activeLayers.has(r.key) : true;
            return (
              <div
                key={r.key}
                className={`v10-minibar-seg${active ? '' : ' dim'}`}
                style={{ width: `${pct}%`, background: r.color }}
                title={`${r.label}: ${r.count}`}
              />
            );
          })}
        </div>
      )}
      <div className="v10-minibar-legend">
        {rows.map(r => {
          const active = activeLayers ? activeLayers.has(r.key) : true;
          return (
            <button
              key={r.key}
              type="button"
              className={`v10-minibar-chip${active ? '' : ' dim'}${interactive ? ' interactive' : ''}`}
              onClick={interactive ? () => onClickLayer!(r.key) : undefined}
              disabled={!interactive}
              title={`${r.label} Memory — ${r.count} entities${interactive ? ' (click to toggle)' : ''}`}
            >
              <span className="v10-minibar-dot" style={{ background: r.color }} />
              <span className="v10-minibar-short">{r.short}</span>
              <span className="v10-minibar-count">{r.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── SubGraphTimeline ────────────────────────────────────────
// Horizontal ribbon of entities sorted by the sub-graph's declared
// `profile:timelinePredicate`. Grouped into year-month buckets so the
// ribbon has natural section headers.
export function SubGraphTimeline({
  items,
  color,
  onSelectEntity,
  scrollKey,
}: {
  items: Array<{ entity: MemoryEntity; date: Date }>;
  color: string;
  onSelectEntity: (uri: string) => void;
  scrollKey?: string;
}) {
  const profile = useProjectProfileContext();
  const agents = useAgentsContext();
  const grouped = useMemo(() => {
    const out = new Map<string, Array<{ entity: MemoryEntity; date: Date }>>();
    for (const it of items) {
      const key = `${it.date.getFullYear()}-${String(it.date.getMonth() + 1).padStart(2, '0')}`;
      const arr = out.get(key) ?? [];
      arr.push(it);
      out.set(key, arr);
    }
    return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);

  if (items.length === 0) {
    return (
      <div className="v10-subgraph-timeline-empty" data-cg-scroll-key={scrollKey}>
        <EmptyState
          compact
          title="No timeline values yet."
          description="Entities in this sub-graph do not currently expose the configured timeline field."
        />
      </div>
    );
  }

  return (
    <div className="v10-subgraph-timeline" data-cg-scroll-key={scrollKey}>
      {grouped.map(([bucket, rows]) => (
        <div key={bucket} className="v10-subgraph-timeline-bucket">
          <div className="v10-subgraph-timeline-bucket-head">
            <span className="v10-subgraph-timeline-bucket-dot" style={{ background: color }} />
            <span className="v10-subgraph-timeline-bucket-label">{formatTimelineBucket(bucket)}</span>
            <span className="v10-subgraph-timeline-bucket-count">{rows.length}</span>
          </div>
          <div className="v10-subgraph-timeline-items">
            {rows.map(({ entity, date }) => {
              const { icon } = entityMeta(entity, profile);
              const authorUri = entityAuthorUri(entity);
              const author = authorUri ? agents?.get(authorUri) : null;
              return (
                <button
                  key={entity.uri}
                  className="v10-subgraph-timeline-item"
                  onClick={() => onSelectEntity(entity.uri)}
                  title={`${entity.label} · ${date.toISOString().slice(0, 10)}`}
                >
                  <span className="v10-subgraph-timeline-item-icon">{icon}</span>
                  <span className="v10-subgraph-timeline-item-label">{entity.label}</span>
                  {(author || authorUri) && (
                    <AgentChip
                      agent={author ?? undefined}
                      fallbackUri={authorUri ?? undefined}
                      size="sm"
                    />
                  )}
                  <span className="v10-subgraph-timeline-item-date">{date.toISOString().slice(0, 10)}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}


/** Sort modes for the Entities tab on a sub-graph page. `created-*` is
 *  only meaningful when the sub-graph profile defines a `timelinePredicate`
 *  (e.g. chat → dcterms:created); falls back gracefully otherwise. */

/** Best-effort timestamp parser shared between Timeline and Entities sort.
 *  Strips `"…"@en` / `"…"^^xsd:dateTime` wrappers and accepts plain ISO. */

export function SubGraphDetailView({
  slug,
  rawMemory,
  contextGraphId,
  onNodeClick,
  onSelectEntity,
  activeTab,
  onTabChange,
  initialLayer,
  initialEnabledLayers: initialEnabledLayersProp,
  onEnabledLayersChange,
}: {
  slug: string;
  rawMemory: ReturnType<typeof useMemoryEntities>;
  contextGraphId: string;
  onNodeClick: (node: any) => void;
  onSelectEntity: (uri: string) => void;
  activeTab?: SubGraphTab;
  onTabChange?: (tab: SubGraphTab) => void;
  /** S3 polish #9 — single-layer seed for the common chip-click
   *  case. When the chip click came from a layer page
   *  (WM/SWM/VM) the originating layer is forwarded here so
   *  `enabledLayers` seeds to that layer instead of the
   *  default all-three. Fold-in #4 from §4.4.1: scope must
   *  never silently change semantics across a navigation
   *  transition. Superseded by `initialEnabledLayers` when both
   *  are set. */
  initialLayer?: 'wm' | 'swm' | 'vm';
  /** S3 polish PR #793 Bug J — multi-layer seed for
   *  detail→detail navigation. Pre-fix the chip-click handler
   *  preserved the STALE seed across hops, dropping any
   *  user-applied widening (e.g. WM-seeded entry → user widens
   *  to WM+SWM → hops to another subgraph → next detail
   *  silently narrowed back to WM-only). Routing the current
   *  scope through this prop lets the user's exact narrow OR
   *  widen survive the hop. Single-layer current scope can also
   *  route through `initialLayer` for callers that prefer the
   *  simpler shape; multi-layer must use this prop. Wins over
   *  `initialLayer` when both are set. */
  initialEnabledLayers?: ReadonlySet<TrustLevel>;
  /** S3 polish PR #793 Bug J — mirrors the detail view's
   *  `enabledLayers` state up to the parent so it can route the
   *  current scope through chip clicks. Optional — without it
   *  the detail view stays uncontrolled and chip-hop navigation
   *  reverts to the stale seed shape. */
  onEnabledLayersChange?: (layers: ReadonlySet<TrustLevel>) => void;
}) {
  const profile = useProjectProfileContext();
  const binding = profile?.forSubGraph(slug);
  const chips = profile?.chipsFor(slug) ?? [];
  const queryCatalogs = profile?.savedQueryCatalogsFor(slug) ?? [];
  const timelinePredicate = binding?.timelinePredicate;

  const [localActiveTab, setLocalActiveTab] = useState<SubGraphTab>('items');
  const rawSelectedTab = activeTab ?? localActiveTab;
  const selectedTab = rawSelectedTab === 'timeline' && !timelinePredicate ? 'items' : rawSelectedTab;
  const setSelectedTab = onTabChange ?? setLocalActiveTab;
  // Default to newest-first for any sub-graph that defines a timeline
  // predicate (chat, github, tasks, decisions). Sub-graphs with no time
  // signal (code, meta) fall back to the legacy "richest entity first"
  // ordering so the list still feels organised.
  const [entitySort, setEntitySort] = useState<SubGraphEntitySort>(
    binding?.timelinePredicate ? 'created-desc' : 'triples',
  );
  // Reset sort when the user navigates between sub-graphs that have
  // different time signals — otherwise switching from chat → code
  // would leave us trying to sort by a predicate the sub-graph lacks.
  useEffect(() => {
    setEntitySort(binding?.timelinePredicate ? 'created-desc' : 'triples');
  }, [slug, binding?.timelinePredicate]);
  // #9 polish + PR #793 Bug J — derive the seeded scope from
  // `initialEnabledLayers` (multi-layer Set form, Bug J) or
  // `initialLayer` (single-layer convenience, #9), in that
  // precedence. Carrying the user's scope across the navigation
  // transition is the §4.4.1 fold-in #4 contract.
  const initialEnabledLayers = useMemo(() => {
    if (initialEnabledLayersProp && initialEnabledLayersProp.size > 0) {
      return new Set<TrustLevel>(initialEnabledLayersProp);
    }
    if (initialLayer === 'wm') return new Set<TrustLevel>(['working']);
    if (initialLayer === 'swm') return new Set<TrustLevel>(['shared']);
    if (initialLayer === 'vm') return new Set<TrustLevel>(['verified']);
    return new Set<TrustLevel>(['working', 'shared', 'verified']);
  }, [initialLayer, initialEnabledLayersProp]);
  const [enabledLayers, setEnabledLayers] = useState<Set<TrustLevel>>(initialEnabledLayers);
  // Mirror current scope up to the parent so chip-hop navigation
  // routes the user's actual current scope (not the stale seed)
  // through the layer-agnostic chip-click handler. Stable callback
  // identity from the parent is assumed; the deps capture the Set
  // identity so widening/narrowing pushes a fresh value through.
  useEffect(() => {
    onEnabledLayersChange?.(enabledLayers);
  }, [enabledLayers, onEnabledLayersChange]);
  const [chipState, setChipState] = useState<Map<string, Set<string>>>(new Map());
  const [activeQuerySlug, setActiveQuerySlug] = useState<string | null>(null);
  const [queryResults, setQueryResults] = useState<Set<string> | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);

  // The synthesized Root bucket — "entities not in any named sub-graph" —
  // and the named-sub-graph branch share this body. They differ only in
  // their scope predicate (no-membership vs. has-this-slug) and chrome
  // (icon/title/binding).
  const isRoot = slug === ROOT_SLUG_SENTINEL;

  // Base slice: every entity scoped to this subgraph.
  //  • Named branch: at least one WM triple tagged with the slug, plus
  //    cross-layer slices (an entity promoted to SWM/VM whose WM-era
  //    membership still pins it here).
  //  • Root branch: no sub-graph membership at all.
  const scopedEntities = useMemo(() => {
    const scoped: MemoryEntity[] = [];
    for (const e of rawMemory.entityList) {
      if (isRoot ? e.subGraphs.size === 0 : e.subGraphs.has(slug)) scoped.push(e);
    }
    return scoped;
  }, [rawMemory.entityList, slug, isRoot]);

  const scopedUris = useMemo(
    () => new Set(scopedEntities.map(e => e.uri)),
    [scopedEntities],
  );

  // Triples visible in the Graph tab. Routing is *exact-tag-first*,
  // erased-tag recovery second:
  //   1. Triples carrying an explicit `subGraph` tag are routed to
  //      that exact slug (named branch only — the Root bucket has no
  //      tagged triples by definition). A triple tagged for "other"
  //      must never leak into the current view just because one of
  //      its endpoints happens to be a scoped entity (an entity in
  //      multiple sub-graphs is shared territory, not a broadcast
  //      channel).
  //   2. Triples with NO `subGraph` tag are admitted if either
  //      endpoint is in scope. This is the post-promotion recovery
  //      path — promoting an assertion erases the `subGraph` origin
  //      tag from the resulting SWM/VM triples; without this branch
  //      promoted entities lose their rdf:type / labels / literal
  //      properties and their cross-layer edges in this view.
  // Root branch: rule (1) can never fire (the Root bucket carries
  // no tagged triples); only the untagged-recovery path admits.
  const scopedTriples = useMemo(
    () => rawMemory.graphTriples.filter(t => {
      if (!isRoot && t.subGraph === slug) return true;
      // Exact-tag-routing: a triple with a non-matching subGraph tag
      // belongs to that other slug's view, not this one — even if an
      // endpoint is shared.
      if (t.subGraph) return false;
      return scopedUris.has(t.subject) || scopedUris.has(t.object);
    }),
    [rawMemory.graphTriples, scopedUris, slug, isRoot],
  );

  // Layer counts for the pyramid header. Each entity counted in exactly
  // one layer — its canonical `trustLevel` (highest layer) — so the
  // pyramid agrees with the Entities tab when narrowed to a single
  // layer chip. Matches the post-M6 canonical-count convention used
  // by the layer-switcher badges and Overview pipeline bar.
  const layerCounts = useMemo(() => {
    let wm = 0, swm = 0, vm = 0;
    for (const e of scopedEntities) {
      if (e.trustLevel === 'verified') vm++;
      else if (e.trustLevel === 'shared') swm++;
      else wm++;
    }
    return { wm, swm, vm, total: scopedEntities.length };
  }, [scopedEntities]);

  // When the subgraph is filtered to exactly one trust layer, propagate
  // that layer to the graph + detail navigation so clicking a node opens
  // the layer-specific entity rather than the merged/highest-trust one.
  const singleLayer = useMemo<'wm' | 'swm' | 'vm' | null>(() => {
    if (enabledLayers.size !== 1) return null;
    const only = enabledLayers.values().next().value as TrustLevel;
    if (only === 'verified') return 'vm';
    if (only === 'shared') return 'swm';
    if (only === 'working') return 'wm';
    return null;
  }, [enabledLayers]);

  // Apply the three filter axes on top of the base scope.
  const filteredEntities = useMemo(() => {
    let out = scopedEntities;
    if (enabledLayers.size < 3) {
      out = out.filter(e => enabledLayers.has(e.trustLevel));
    }
    if (chipState.size > 0) {
      for (const chip of chips) {
        const selected = chipState.get(chip.slug);
        if (!selected || selected.size === 0) continue;
        out = out.filter(e => {
          const vals = e.properties.get(chip.predicate);
          if (!vals || vals.length === 0) return false;
          return vals.some(v => selected.has(v));
        });
      }
    }
    if (queryResults) {
      out = out.filter(e => queryResults.has(e.uri));
    }
    return out;
  }, [scopedEntities, enabledLayers, chipState, chips, queryResults]);

  const filteredUris = useMemo(
    () => new Set(filteredEntities.map(e => e.uri)),
    [filteredEntities],
  );

  const filteredTriples = useMemo(() => {
    if (filteredEntities.length === scopedEntities.length) return scopedTriples;
    return scopedTriples.filter(
      t => filteredUris.has(t.subject) || filteredUris.has(t.object),
    );
  }, [scopedTriples, scopedEntities, filteredEntities, filteredUris]);

  // Graph-tab triples — when the user has narrowed the trust filter to one
  // layer (`singleLayer`), source from the layered triple stream and drop
  // any triple whose origin layer doesn't match, so a WM-only / SWM-only /
  // VM-only graph never renders edges that exist only in another layer.
  // Without this, clicks were already layer-scoped (C14) but the rendered
  // graph could show cross-layer edges (C15).
  //
  // Scope predicate is asymmetric (C17): a triple is in scope when
  //   (a) it carries this sub-graph's origin tag,
  //   (b) its subject is in `scopedUris` — covers `rdf:type`, labels and
  //       literal-valued attribute triples on promoted entities whose
  //       `subGraph` was lost on promotion, OR
  //   (c) its object is a scoped *resource* (object-side recovery edges).
  // The previous both-ends test (`scopedUris.has(subject) && scopedUris.has(object)`)
  // accidentally dropped subject-local triples whose object is a class IRI
  // or a literal, making isolated promoted entities lose their types /
  // labels in a narrowed single-layer view.
  //
  // Endpoint-presence gate (C18): the URI set for "at least one endpoint
  // belongs to the narrowed view" must be built from `entity.layers.has(...)`
  // rather than from `filteredEntities` — the latter is `trustLevel`-filtered
  // (single highest-trust value per entity), which excludes mixed-layer
  // entities from the URI set whenever their `trustLevel` doesn't match the
  // single enabled layer. Chip + query filters still apply in addition.
  // Split from the selector below so the heavy layer-scoped loop only
  // re-runs when its real inputs change — chip/query toggles that move
  // `filteredTriples` (the `!singleLayer` fallback) don't invalidate the
  // single-layer computation.
  const singleLayerPanelTriples = useMemo(() => {
    if (!singleLayer) return null;
    const layerTrust: TrustLevel =
      singleLayer === 'vm' ? 'verified' :
      singleLayer === 'swm' ? 'shared' : 'working';
    const panelEntities = scopedEntities.filter(e => {
      if (!e.layers.has(layerTrust)) return false;
      if (chipState.size > 0) {
        for (const chip of chips) {
          const selected = chipState.get(chip.slug);
          if (!selected || selected.size === 0) continue;
          const vals = e.properties.get(chip.predicate);
          if (!vals || vals.length === 0) return false;
          if (!vals.some(v => selected.has(v))) return false;
        }
      }
      if (queryResults && !queryResults.has(e.uri)) return false;
      return true;
    });
    const panelUris = new Set(panelEntities.map(e => e.uri));
    const seen = new Set<string>();
    const out: Triple[] = [];
    for (const t of rawMemory.allTriples) {
      if (t.layer !== layerTrust) continue;
      const inScope = t.subGraph === slug
        || scopedUris.has(t.subject)
        || (isResourceNode(t.object) && scopedUris.has(t.object));
      if (!inScope) continue;
      if (!(panelUris.has(t.subject) || panelUris.has(t.object))) continue;
      const key = `${t.subject}|${t.predicate}|${t.object}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ subject: t.subject, predicate: t.predicate, object: t.object, subGraph: t.subGraph });
    }
    return out;
  }, [singleLayer, rawMemory.allTriples, scopedUris, slug, scopedEntities, chips, chipState, queryResults]);

  const graphPanelTriples = singleLayerPanelTriples ?? filteredTriples;

  // Entities that should be visible on the Graph tab — either as canvas
  // nodes (subject/object of a rendered triple) or as singleton-shelf
  // chips. Driven by the same filter axes as `graphPanelTriples`, so
  // the Graph tab agrees with what the Entities tab below it shows
  // (Issue C: an entity in scope with no triples in the rendered set
  // — e.g. a promoted SWM entity whose triples live in `_shared_memory`
  // and don't pass `scopedTriples` — used to silently disappear from
  // the Graph view).
  const graphPanelEntities = useMemo(() => {
    if (singleLayer) {
      const layerTrust: TrustLevel =
        singleLayer === 'vm' ? 'verified' :
        singleLayer === 'swm' ? 'shared' : 'working';
      return scopedEntities.filter(e => {
        if (!e.layers.has(layerTrust)) return false;
        if (chipState.size > 0) {
          for (const chip of chips) {
            const selected = chipState.get(chip.slug);
            if (!selected || selected.size === 0) continue;
            const vals = e.properties.get(chip.predicate);
            if (!vals || vals.length === 0) return false;
            if (!vals.some(v => selected.has(v))) return false;
          }
        }
        if (queryResults && !queryResults.has(e.uri)) return false;
        return true;
      });
    }
    return filteredEntities;
  }, [singleLayer, scopedEntities, filteredEntities, chips, chipState, queryResults]);

  const graphPanelScopeEntities = useMemo(
    () => graphPanelEntities.map(e => ({ uri: e.uri, label: e.label })),
    [graphPanelEntities],
  );

  // Fold-in #6 (PR #677 follow-up). Per-URI trust colouring on the
  // multi-layer Graph pane. Pre-fix `LayerGraphPanel` received
  // `layer={singleLayer ?? 'wm'}` and painted every node WM-gray
  // when no single layer was active — even in a sub-graph spanning
  // SWM and VM. Build a `nodeColors` map keyed by entity URI using
  // the canonical `TRUST_COLORS` palette (same hex values as the
  // layer chips and the Knowledge Pipeline bar). When a single
  // layer is active, every panel entity belongs to that layer by
  // construction, so the per-URI map collapses to the layer default
  // and we can skip the override (saves a copy on the common path).
  const trustNodeColors = useMemo(() => {
    if (singleLayer) return undefined;
    const out: Record<string, string> = {};
    for (const e of graphPanelEntities) {
      out[e.uri] = TRUST_COLORS[e.trustLevel];
      const canonical = canonicalEntityUri(e.uri);
      if (canonical !== e.uri) out[canonical] = TRUST_COLORS[e.trustLevel];
    }
    return out;
  }, [singleLayer, graphPanelEntities]);

  // Locked active-layer chip pill copy (UX §4.4.1). "All layers"
  // when every layer is enabled; otherwise the single enabled
  // layer's title — visible whenever scope is narrower than the
  // canonical "all three" so the user can never lose sight of
  // which layer the count strip is reporting on.
  const activeLayerLabel = enabledLayers.size === 3
    ? 'All layers'
    : singleLayer
      ? LAYER_CONFIG[singleLayer].title
      : Array.from(enabledLayers).map(l => LAYER_CONFIG[l === 'verified' ? 'vm' : l === 'shared' ? 'swm' : 'wm'].trustLabel).join(' + ');

  const timelineItems = useMemo(() => {
    if (!timelinePredicate) return [];
    const out: Array<{ entity: MemoryEntity; date: Date }> = [];
    for (const e of filteredEntities) {
      const t = entityTimestamp(e, timelinePredicate);
      if (t == null) continue;
      out.push({ entity: e, date: new Date(t) });
    }
    out.sort((a, b) => a.date.getTime() - b.date.getTime());
    return out;
  }, [filteredEntities, timelinePredicate]);

  // Apply the user's chosen sort to the Entities tab. Time-based modes
  // bucket undated entities at the bottom so the list stays predictable
  // when only some entities carry the timeline predicate.
  const sortedEntities = useMemo(() => {
    const copy = [...filteredEntities];
    if ((entitySort === 'created-desc' || entitySort === 'created-asc') && timelinePredicate) {
      const dir = entitySort === 'created-desc' ? -1 : 1;
      copy.sort((a, b) => {
        const ta = entityTimestamp(a, timelinePredicate);
        const tb = entityTimestamp(b, timelinePredicate);
        if (ta == null && tb == null) return 0;
        if (ta == null) return 1;
        if (tb == null) return -1;
        return (ta - tb) * dir;
      });
      return copy;
    }
    if (entitySort === 'label') {
      copy.sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''));
      return copy;
    }
    // 'triples' (default fallback)
    copy.sort((a, b) => {
      const aCount = a.tripleCount ?? 0;
      const bCount = b.tripleCount ?? 0;
      return bCount - aCount;
    });
    return copy;
  }, [filteredEntities, entitySort, timelinePredicate]);

  const sortLabel =
    entitySort === 'created-desc' ? 'newest first · click to open'
    : entitySort === 'created-asc' ? 'oldest first · click to open'
    : entitySort === 'label' ? 'A → Z · click to open'
    : 'sorted by triples · click to open';

  const toggleLayer = useCallback((layer: TrustLevel) => {
    setEnabledLayers(prev => {
      const next = new Set(prev);
      if (next.has(layer)) {
        // Refuse to turn off the last enabled layer — otherwise the list
        // empties with no obvious recovery affordance.
        if (next.size > 1) next.delete(layer);
      } else {
        next.add(layer);
      }
      return next;
    });
  }, []);

  const toggleChip = useCallback((chipSlug: string, value: string) => {
    setChipState(prev => {
      const next = new Map(prev);
      const curr = new Set(next.get(chipSlug) ?? []);
      if (curr.has(value)) curr.delete(value);
      else curr.add(value);
      if (curr.size === 0) next.delete(chipSlug);
      else next.set(chipSlug, curr);
      return next;
    });
  }, []);

  const clearQuery = useCallback(() => {
    setActiveQuerySlug(null);
    setQueryResults(null);
    setQueryError(null);
  }, []);

  const runQuery = useCallback(async (q: { slug: string; sparql: string; resultColumn: string; name: string }) => {
    setQueryLoading(true);
    setQueryError(null);
    setActiveQuerySlug(q.slug);
    try {
      const r = await executeQuery(q.sparql, contextGraphId);
      const bindings = (r as any)?.result?.bindings ?? [];
      const col = q.resultColumn || 'uri';
      const ids = new Set<string>();
      for (const row of bindings) {
        const raw = (row as any)[col];
        if (!raw) continue;
        const s = typeof raw === 'string' ? raw : String(raw);
        const iri = s.startsWith('<') && s.endsWith('>') ? s.slice(1, -1) : s;
        ids.add(iri);
      }
      setQueryResults(ids);
    } catch (err: any) {
      setQueryError(err?.message ?? String(err));
      setQueryResults(null);
      setActiveQuerySlug(null);
    } finally {
      setQueryLoading(false);
    }
  }, [contextGraphId]);

  // `profile.forSubGraph` short-circuits ROOT_SLUG_SENTINEL to the
  // synthesized Root binding (icon ⊘ / displayName "Root" /
  // description) so every Subgraph Explorer surface — chip, this
  // detail header, the project breadcrumb strip — reads the same
  // identity. Root's color is left unset so the CSS neutral
  // (--text-tertiary via the `--sg-color` fallback) wins.
  const color = binding?.color ?? (isRoot ? 'var(--text-tertiary)' : '#64748b');
  const icon = binding?.icon ?? '•';
  const title = binding?.displayName ?? slug;
  const desc = binding?.description;

  // Reset filters when the sub-graph changes — otherwise chips from
  // `tasks` would linger when the user jumps to `decisions` and silently
  // zero out the list. `enabledLayers` re-seeds to `initialEnabledLayers`
  // (default all-three OR the originating-layer scope per #9 polish).
  useEffect(() => {
    setEnabledLayers(initialEnabledLayers);
    setChipState(new Map());
    clearQuery();
  }, [slug, clearQuery, initialEnabledLayers]);

  useEffect(() => {
    if (!activeTab) setLocalActiveTab('items');
  }, [slug, activeTab]);

  useEffect(() => {
    if (rawSelectedTab !== selectedTab) setSelectedTab(selectedTab);
  }, [rawSelectedTab, selectedTab, setSelectedTab]);

  // PR #793 Codex sweep 2 (Bug I) — derive the "are we at the
  // seeded state?" predicate against `initialEnabledLayers`,
  // NOT the hard-coded all-three set. Pre-fix the seeded
  // single-layer scope was indistinguishable from a user-applied
  // filter, so:
  //   • `Reset filters` was visible immediately on a WM-seeded
  //     entry — clicking it widened to all-three instead of
  //     restoring WM.
  //   • The active-layer pill was clickable at the seeded scope —
  //     it would widen the same way.
  // Comparing against `initialEnabledLayers` makes both
  // affordances honest: hidden / disabled when the user is at
  // their entry scope; visible / enabled only after they've
  // actually narrowed or widened.
  const isAtSeededScope = enabledLayers.size === initialEnabledLayers.size
    && [...enabledLayers].every(l => initialEnabledLayers.has(l));
  const hasAnyFilter = !isAtSeededScope || chipState.size > 0 || !!queryResults;
  const resetFilters = () => {
    setEnabledLayers(new Set<TrustLevel>(initialEnabledLayers));
    setChipState(new Map());
    clearQuery();
  };

  return (
    <div
      className="v10-layer-detail v10-subgraph-detail"
      style={{ '--sg-color': color } as React.CSSProperties}
    >
      <div className="v10-subgraph-detail-header">
        <span className="v10-subgraph-detail-icon" style={{ color }}>{icon}</span>
        <div className="v10-subgraph-detail-title-wrap">
          <div className="v10-subgraph-detail-title">{title}</div>
          {desc && <div className="v10-subgraph-detail-desc">{desc}</div>}
        </div>
        <MiniLayerBar
          counts={{ wm: layerCounts.wm, swm: layerCounts.swm, vm: layerCounts.vm }}
          activeLayers={enabledLayers}
          onClickLayer={toggleLayer}
          compact
        />
      </div>

      {/* Cross-layer count strip + active-layer chip pill (UX §4.4.1).
          The count strip is the page's whole point — every subgraph
          (and the Root bucket) is *cross-layer* and the user must
          never lose sight of that. The active-layer chip pill below
          the strip surfaces the current scope (M2 / S5 strand —
          "scope must never silently change semantics across a
          navigation transition" — the chip makes the change
          visible). */}
      <div className="v10-subgraph-cross-layer">
        <div className="v10-subgraph-cross-layer-lede">
          {isRoot
            ? 'Root entities, across the three memory layers:'
            : 'This subgraph, across the three memory layers:'}
        </div>
        <div className="v10-subgraph-cross-layer-strip" data-testid="cross-layer-strip">
          {/* Cells are interactive buttons wired to `toggleLayer`
              (#6, ui-locked). The `→` arrows stay inert span
              separators — they shouldn't grow click targets. The
              "refuse last enabled" safeguard at `toggleLayer:4683`
              already prevents the all-empty state; the
              `aria-pressed="false"` cells render at 0.5 opacity
              (CSS) to signal the dimmed state. */}
          <button
            type="button"
            className="v10-subgraph-cross-layer-cell"
            data-layer="wm"
            aria-pressed={enabledLayers.has('working')}
            onClick={() => toggleLayer('working')}
          >
            <span className="v10-subgraph-cross-layer-cell-icon" style={{ color: TRUST_COLORS.working }}>◇</span>
            <span className="v10-subgraph-cross-layer-cell-label">Working</span>
            <span className="v10-subgraph-cross-layer-cell-count">{layerCounts.wm}</span>
          </button>
          <span className="v10-subgraph-cross-layer-arrow" aria-hidden="true">→</span>
          <button
            type="button"
            className="v10-subgraph-cross-layer-cell"
            data-layer="swm"
            aria-pressed={enabledLayers.has('shared')}
            onClick={() => toggleLayer('shared')}
            /* #8 polish (c) — when SWM is the only enabled layer
               the Graph pane swaps to agent-attribution coloring;
               the tooltip surfaces that context-sensitive
               behaviour so the user understands the colour change. */
            title={singleLayer === 'swm'
              ? 'Showing Shared Working Memory only — graph is colored by contributing agent (see legend).'
              : undefined}
          >
            <span className="v10-subgraph-cross-layer-cell-icon" style={{ color: TRUST_COLORS.shared }}>◈</span>
            <span className="v10-subgraph-cross-layer-cell-label">Shared</span>
            <span className="v10-subgraph-cross-layer-cell-count">{layerCounts.swm}</span>
          </button>
          <span className="v10-subgraph-cross-layer-arrow" aria-hidden="true">→</span>
          <button
            type="button"
            className="v10-subgraph-cross-layer-cell"
            data-layer="vm"
            aria-pressed={enabledLayers.has('verified')}
            onClick={() => toggleLayer('verified')}
          >
            <span className="v10-subgraph-cross-layer-cell-icon" style={{ color: TRUST_COLORS.verified }}>◉</span>
            <span className="v10-subgraph-cross-layer-cell-label">Verifiable</span>
            <span className="v10-subgraph-cross-layer-cell-count">{layerCounts.vm}</span>
          </button>
        </div>
        {/* PR #793 round 2 — demoted from clickable pill to
            inline caption per ui-lead (option c). The
            "restore" affordance the button used to claim was
            confusing (it looked dressable but didn't go
            anywhere); the `Reset filters` button covers the
            same semantic when chip filters exist. `Bug I`'s
            `isAtSeededScope` predicate stays — it still gates
            the Reset button's visibility — but no longer
            affects this element. Rendered as a `<span>` with
            metadata role. */}
        <span
          className={`v10-subgraph-active-layer-pill${enabledLayers.size === 3 ? ' all-layers' : ''}`}
          data-testid="active-layer-pill"
        >
          <span className="v10-subgraph-active-layer-pill-label">Active layer:</span>
          <span className="v10-subgraph-active-layer-pill-value">{activeLayerLabel}</span>
        </span>
      </div>

      {queryCatalogs.length > 0 && (
        <div className="v10-subgraph-savedqueries">
          <span className="v10-subgraph-savedqueries-label">Query catalog</span>
          {queryCatalogs.map(catalog => (
            <React.Fragment key={catalog.slug}>
              <span
                className="v10-subgraph-savedqueries-label"
                title={catalog.description || catalog.name}
                style={{ marginLeft: 8, opacity: 0.8 }}
              >
                {catalog.name}
              </span>
              {catalog.queries.map(q => {
                const isActive = activeQuerySlug === q.slug;
                return (
                  <button
                    key={q.slug}
                    type="button"
                    className={`v10-subgraph-savedquery${isActive ? ' active' : ''}`}
                    onClick={() => isActive ? clearQuery() : runQuery(q)}
                    title={q.description || q.name}
                    disabled={queryLoading && !isActive}
                  >
                    <span className="v10-subgraph-savedquery-glyph">
                      {queryLoading && isActive ? '…' : isActive ? '✓' : '◎'}
                    </span>
                    {q.name}
                  </button>
                );
              })}
            </React.Fragment>
          ))}
          {queryError && (
            <span className="v10-subgraph-savedquery-error" title={queryError}>✕ query failed</span>
          )}
          {queryResults && activeQuerySlug && (
            <span className="v10-subgraph-savedquery-count">
              {queryResults.size} match{queryResults.size === 1 ? '' : 'es'}
            </span>
          )}
        </div>
      )}

      {chips.length > 0 && (
        <div className="v10-subgraph-filters">
          {chips.map(chip => {
            const selected = chipState.get(chip.slug) ?? new Set<string>();
            return (
              <div key={chip.slug} className="v10-subgraph-filter-row">
                <span className="v10-subgraph-filter-label">{chip.label}</span>
                <div className="v10-subgraph-filter-chips">
                  {chip.values.map(v => {
                    const on = selected.has(v);
                    return (
                      <button
                        key={v}
                        type="button"
                        className={`v10-subgraph-filter-chip${on ? ' active' : ''}`}
                        onClick={() => toggleChip(chip.slug, v)}
                      >
                        {v}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {hasAnyFilter && (
            <button type="button" className="v10-subgraph-filter-reset" onClick={resetFilters}>
              Reset filters
            </button>
          )}
        </div>
      )}

      <div className="v10-layer-detail-body">
        <div className="v10-layer-expand-tabs">
          <button
            className={`v10-layer-expand-tab ${selectedTab === 'items' ? 'active' : ''}`}
            onClick={() => setSelectedTab('items')}
          >
            Entities ({filteredEntities.length}{filteredEntities.length !== scopedEntities.length ? ` / ${scopedEntities.length}` : ''})
          </button>
          <button
            className={`v10-layer-expand-tab ${selectedTab === 'graph' ? 'active' : ''}`}
            onClick={() => setSelectedTab('graph')}
          >
            Graph
          </button>
          {timelinePredicate && (
            <button
              className={`v10-layer-expand-tab ${selectedTab === 'timeline' ? 'active' : ''}`}
              onClick={() => setSelectedTab('timeline')}
            >
              Timeline
            </button>
          )}
          <button
            className={`v10-layer-expand-tab ${selectedTab === 'docs' ? 'active' : ''}`}
            onClick={() => setSelectedTab('docs')}
          >
            Documents
          </button>
        </div>

        {selectedTab === 'items' && (
          <div className="v10-layer-expand-body entities-tab" data-cg-scroll-key={`subgraph:${slug}:items`}>
            <EntityList
              entities={sortedEntities}
              layerKey="wm"
              layerIcon={icon}
              onSelectEntity={onSelectEntity}
              externallySorted
              sortLabel={sortLabel}
              timestampPredicate={timelinePredicate}
              perEntityTrustBadge

              headerExtra={
                <label className="v10-entity-list-sort">
                  <span className="v10-entity-list-sort-label">Sort</span>
                  <select
                    className="v10-entity-list-sort-select"
                    value={entitySort}
                    onChange={(e) => setEntitySort(e.target.value as SubGraphEntitySort)}
                    aria-label="Sort entities"
                  >
                    {timelinePredicate && (
                      <>
                        <option value="created-desc">Newest first</option>
                        <option value="created-asc">Oldest first</option>
                      </>
                    )}
                    <option value="triples">Most triples</option>
                    <option value="label">Label (A→Z)</option>
                  </select>
                </label>
              }
            />
          </div>
        )}

        {selectedTab === 'graph' && (
          <div className="v10-layer-expand-body full-width" data-cg-scroll-key={`subgraph:${slug}:graph`}>
            {/* PR #793 round 2 — the inline "Colored by
                contributing agent" badge (sweep 0 Bug #8's
                ux-locked (a) discoverability surface) was removed
                after manual-test feedback from the original
                requester. The `SwmAttributionLegend` inside
                LayerGraphPanel already carries the load-bearing
                disclosure; the badge above the canvas added
                visual noise without adding signal. The
                context-sensitive tooltip on the SWM cross-layer
                cell (`title` when `singleLayer === 'swm'`) is
                hover-only insurance and stays. */}
            <LayerGraphPanel
              layer={singleLayer ?? 'wm'}
              triples={graphPanelTriples}
              onNodeClick={onNodeClick}
              contextGraphId={contextGraphId}
              title={title}
              scopeLabel={`Subgraph graph: ${title} entities and entity-to-entity triples from loaded subgraph data.`}
              trustLegendActiveLayer={singleLayer}
              scopeEntities={graphPanelScopeEntities}
              layerEntities={graphPanelEntities}
              nodeColorsOverride={trustNodeColors}
            />
          </div>
        )}

        {selectedTab === 'timeline' && timelinePredicate && (
          <div className="v10-layer-expand-body full-width">
            <SubGraphTimeline
              items={timelineItems}
              color={color}
              onSelectEntity={onSelectEntity}
              scrollKey={`subgraph:${slug}:timeline`}
            />
          </div>
        )}

        {selectedTab === 'docs' && (
          <div className="v10-layer-expand-body full-width">
            <DocumentsList
              entities={filteredEntities}
              contextGraphId={contextGraphId}
              scrollKey={`subgraph:${slug}:docs`}
            />
          </div>
        )}
      </div>
    </div>
  );
}
