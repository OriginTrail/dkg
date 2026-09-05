import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useFetch } from '../hooks.js';
import { api } from '../api-wrapper.js';
import { useMemoryGraphEvents } from '../hooks/useNodeEvents.js';
import { isUserFacingSubGraph } from '../lib/subGraphs.js';
import { ImportFilesModal } from '../components/Modals/ImportFilesModal.js';
import { ShareProjectModal } from '../components/Modals/ShareProjectModal.js';
import {
  buildMemoryEntities,
  canonicalEntityUri,
  useMemoryEntities,
  type LayeredTriple,
  type TrustLevel,
} from '../hooks/useMemoryEntities.js';
import { useProjectProfile, ProjectProfileContext } from '../hooks/useProjectProfile.js';
import { useAgents, AgentsContext } from '../hooks/useAgents.js';
import { useCurrentAgent } from '../hooks/useCurrentAgent.js';
import { useSwmAttributions } from '../hooks/useSwmAttributions.js';
import { useAssertionLifecycleEvents } from '../hooks/useAssertionLifecycleEvents.js';
import { ActivityFeed } from '../components/ActivityFeed.js';
import { SubGraphBar } from '../components/SubGraphBar.js';
import { CONTEXT_GRAPH_PRIMER_TAB } from '../lib/contextGraphPrimer.js';
import { useTabsStore } from '../stores/tabs.js';
import {
  shouldFetchSwmAttribution,
  useCanonicalTriples,
  type LayerView,
  type LayerContentTab,
  type SubGraphTab,
} from './project/helpers.js';
import {
  ProjectHeaderStrip,
  LayerSwitcher,
  KADetailView,
  SubGraphDetailView,
  ProjectOverviewCard,
  PendingJoinRequestsSection,
  OverviewPrimerEntry,
  curatorStatusForOverview,
  SubGraphOverviewGrid,
  SubGraphExplorerHeader,
  ContextGraphQueryView,
  LayerDetailView,
} from './project/components.js';

interface ProjectViewProps {
  contextGraphId: string;
}

type MemoryLayerView = Extract<LayerView, 'wm' | 'swm' | 'vm'>;
type ParticipantsStatus = 'loading' | 'ok' | 'error';
type ParticipantsState = {
  contextGraphId: string | null;
  list: string[];
  status: ParticipantsStatus;
};

interface DetailOrigin {
  activeLayer: LayerView;
  activeSubGraph: string | null;
  layerTabs: Record<MemoryLayerView, LayerContentTab>;
  subGraphTabs: Record<string, SubGraphTab>;
  scroll: { key: string; top: number };
  /** PR #793 sweep 6 Bug P — snapshot of the detail view's
   *  `enabledLayers` at the moment the entity was opened. Pre-Bug-P
   *  the user could enter subgraph A from a WM tab, widen scope
   *  to WM+SWM in the detail, open an entity, then close back —
   *  and `SubGraphDetailView` would remount from the STALE
   *  `subGraphInitialEnabledLayers` seed (still WM-only) and
   *  silently snap back. Capturing the current scope here and
   *  restoring it in `handleDetailClose` preserves the user's
   *  widening/narrowing across the round-trip. `null` when the
   *  entity was opened from a layer-tab (no subgraph context). */
  subGraphEnabledLayers: ReadonlySet<TrustLevel> | null;
}

const DEFAULT_LAYER_TABS: Record<MemoryLayerView, LayerContentTab> = {
  wm: 'items',
  swm: 'items',
  vm: 'items',
};

const TRUST_FOR_LAYER: Record<MemoryLayerView, TrustLevel> = {
  wm: 'working',
  swm: 'shared',
  vm: 'verified',
};

function isMemoryLayerView(layer: LayerView): layer is MemoryLayerView {
  return layer === 'wm' || layer === 'swm' || layer === 'vm';
}

function dedupeTriplesBySpo<T extends { subject: string; predicate: string; object: string }>(triples: T[]): T[] {
  const seen = new Set<string>();
  return triples.filter(t => {
    // Canonicalise wrapped/bare IRIs so this dedup agrees with
    // `buildEntities`' per-entity `tripleCount` dedup
    // (`useMemoryEntities.ts` builds its SPO key from canonical
    // subject/object). Daemon sometimes ships wrapped `<urn:...>`
    // for the same triple it returns bare elsewhere; without
    // canonicalisation here the detail-page Triples tab would show
    // two rows for what the badge counts as one.
    const key = `${canonicalEntityUri(t.subject)}|${t.predicate}|${canonicalEntityUri(t.object)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scrollElementFor(key: string, fallback: HTMLElement | null): HTMLElement | null {
  if (typeof document === 'undefined') return fallback;
  const elements = document.querySelectorAll<HTMLElement>('[data-cg-scroll-key]');
  for (const element of elements) {
    if (element.dataset.cgScrollKey === key) return element;
  }
  return fallback;
}

export function ProjectView({ contextGraphId }: ProjectViewProps) {
  // GH #905: consume `error`/`loading`/`refresh` — not just `data`. Gating the
  // render on `cgData` alone meant a failed `fetchContextGraphs` left `cg`
  // undefined and the view stuck on "Loading context graph…" forever, with no
  // way to tell loading from error and no retry.
  const { data: cgData, error: cgError, loading: cgLoading, refresh: refreshContextGraphs } = useFetch(
    api.fetchContextGraphs,
    [],
    30_000,
  );
  const [showImport, setShowImport] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [activeLayer, setActiveLayer] = useState<LayerView>('overview');
  const [showQueryCatalog, setShowQueryCatalog] = useState(false);
  const [selectedUri, setSelectedUri] = useState<string | null>(null);
  useEffect(() => {
    setShowQueryCatalog(false);
  }, [contextGraphId]);
  const [participantsState, setParticipantsState] = useState<ParticipantsState>({
    contextGraphId: null,
    list: [],
    status: 'loading',
  });
  // S2 finalize — Overview "At a glance" needs a subgraph count.
  // Lifted from SubGraphBar's identical fetch so we don't sneak a
  // peer hook into useMemoryEntities. `null` = not yet known; the
  // stat strip then suppresses the cell rather than rendering "0".
  // The reserved `meta` slug never counts (see `lib/subGraphs.ts`).
  // `subGraphFetchFailed` distinguishes "still loading" from
  // "permanently unavailable" (Codex review bug D).
  const [subGraphCount, setSubGraphCount] = useState<number | null>(null);
  const [subGraphFetchFailed, setSubGraphFetchFailed] = useState(false);
  const subGraphRequestRef = useRef(0);
  // Active sub-graph *page* — when set, the middle pane renders the sub-graph
  // detail view instead of the overview / layer views. This is structurally
  // a sibling of `activeLayer`, not a filter over it: sub-graphs are a peer
  // axis to layers, and each axis gets its own first-class page.
  const [activeSubGraph, setActiveSubGraph] = useState<string | null>(null);
  // S3 polish #9 + PR #793 Bug J — multi-layer carry-over for the
  // subgraph detail view's `enabledLayers` seed. Storing the Set
  // (rather than the single-layer alias #9 originally used) lets
  // the user's exact scope survive across detail→detail hops
  // even when they've widened past one layer (e.g. WM seeded
  // entry → user widens to WM+SWM → hops to bakers → bakers
  // detail seeds WM+SWM, not WM-only). null = no narrowing
  // (default — fresh entries land at all-three).
  const [subGraphInitialEnabledLayers, setSubGraphInitialEnabledLayers] = useState<ReadonlySet<TrustLevel> | null>(null);
  // Mirror of the detail view's current `enabledLayers` state,
  // pushed up via `onEnabledLayersChange` (Bug J). Read by
  // `handleSelectSubGraph`'s layer-agnostic branch when the user
  // hops between subgraphs from the detail-view internal bar —
  // we route the current scope through, NOT the stale seed.
  //
  // PR #793 sweep 6 Bug O — also stored as React state so the
  // sibling `SubGraphBar` mounted next to the detail view can
  // pass it through as `enabledScope`. The bar's chip counts
  // were pre-Bug-O layer-agnostic above a filtered detail body,
  // causing on-screen number disagreement. Ref + state stay in
  // lockstep — the ref carries the SYNC value for race-window
  // discriminators (Bug L); the state drives the bar's re-render
  // when the user widens/narrows inside the detail view.
  const detailScopeRef = useRef<ReadonlySet<TrustLevel> | null>(null);
  const [currentDetailScope, setCurrentDetailScope] = useState<ReadonlySet<TrustLevel> | null>(null);
  const handleDetailEnabledLayersChange = useCallback((layers: ReadonlySet<TrustLevel>) => {
    detailScopeRef.current = layers;
    setCurrentDetailScope(layers);
  }, []);
  // PR #793 sweep 4 Bug L — `activeSubGraph` from the useCallback
  // closure can be stale during a fast chip-to-chip burst (the
  // state update from click 1 hasn't re-rendered before click 2
  // fires). A ref kept in sync at the top of every
  // handleSelectSubGraph call captures the latest active-subgraph
  // identity synchronously so the layer-agnostic branch's
  // "overview-vs-detail" discriminator stays fresh across the
  // race window.
  const activeSubGraphRef = useRef<string | null>(null);
  // PR #793 sweep 5 Bug N — `activeSubGraph` is mutated by THREE
  // paths in ProjectView: handleSelectSubGraph (chip click),
  // handleLayerSwitch (layer tab click), handleDetailClose (M2
  // origin restore). Each must keep both `activeSubGraphRef` and
  // `detailScopeRef` in sync or the next chip click's
  // discriminator misfires (Bug N: subgraph A → WM tab → overview
  // → click B misclassified as detail→detail hop because
  // activeSubGraphRef still held 'A' from a path that bypassed
  // the ref sync). This helper makes both refs invariant: refs
  // always equal the state they model, regardless of mutation
  // path. Any future caller that mutates `activeSubGraph` MUST
  // go through this helper.
  //
  // The seed scope (`subGraphInitialEnabledLayers`) is NOT mirrored
  // here because callers route it explicitly — chip clicks read
  // the live scope via `detailScopeRef`; layer-switch and
  // detail-close paths clear it via the slug === null branch
  // below or directly when needed.
  const setActiveSubGraphSync = useCallback((slug: string | null) => {
    activeSubGraphRef.current = slug;
    if (slug === null) {
      // Exit always clears the scope mirror so the next chip
      // click from a fresh route doesn't see a stale carry-over.
      // Both the ref (sync read path) and the state (bar
      // re-render path) clear in lockstep.
      detailScopeRef.current = null;
      setCurrentDetailScope(null);
    }
    setActiveSubGraph(slug);
  }, []);
  const [selectedLayerContext, setSelectedLayerContext] = useState<MemoryLayerView | null>(null);
  // Mirror `selectedUri` into a ref so `handleNavigate` can read the
  // current value without listing it in deps — listing it caused the
  // callback identity to churn on every entity click and re-ran every
  // downstream memo that consumed `handleNavigate`.
  const selectedUriRef = useRef<string | null>(null);
  useEffect(() => { selectedUriRef.current = selectedUri; }, [selectedUri]);
  const [layerContentTabs, setLayerContentTabs] = useState<Record<MemoryLayerView, LayerContentTab>>(
    DEFAULT_LAYER_TABS,
  );
  const [subGraphTabs, setSubGraphTabs] = useState<Record<string, SubGraphTab>>({});
  const pageRef = useRef<HTMLElement | null>(null);
  const detailOriginRef = useRef<DetailOrigin | null>(null);
  const pendingScrollRestoreRef = useRef<DetailOrigin['scroll'] | null>(null);
  const participantsRequestRef = useRef(0);
  const profile = useProjectProfile(contextGraphId);
  const agentsData = useAgents(contextGraphId);
  const openTab = useTabsStore((s) => s.openTab);
  const { data: currentAgent, loading: currentAgentLoading, error: currentAgentError } = useCurrentAgent();

  const currentScrollKey = useCallback(() => {
    if (activeSubGraph) {
      return `subgraph:${activeSubGraph}:${subGraphTabs[activeSubGraph] ?? 'items'}`;
    }
    if (isMemoryLayerView(activeLayer)) {
      return `layer:${activeLayer}:${layerContentTabs[activeLayer]}`;
    }
    return 'page';
  }, [activeLayer, activeSubGraph, layerContentTabs, subGraphTabs]);

  const captureDetailOrigin = useCallback((originScrollKey?: string): DetailOrigin => {
    const key = originScrollKey ?? currentScrollKey();
    const scrollEl = scrollElementFor(key, pageRef.current);
    return {
      activeLayer,
      activeSubGraph,
      layerTabs: { ...layerContentTabs },
      subGraphTabs: { ...subGraphTabs },
      scroll: { key, top: scrollEl?.scrollTop ?? 0 },
      // Bug P — snapshot the current detail scope into a fresh
      // Set so the unmounting SubGraphDetailView's state mutation
      // can't share the reference. `null` when there's no
      // subgraph in scope (origin is a layer tab → no scope to
      // preserve). Read from the ref (sync source of truth) so
      // the snapshot reflects the user's exact scope at the
      // moment the entity opened.
      subGraphEnabledLayers: activeSubGraph !== null && detailScopeRef.current
        ? new Set<TrustLevel>(detailScopeRef.current)
        : null,
    };
  }, [
    activeLayer,
    activeSubGraph,
    currentScrollKey,
    layerContentTabs,
    subGraphTabs,
  ]);

  const restoreScroll = useCallback((scroll: DetailOrigin['scroll']) => {
    const restore = () => {
      const scrollEl = scrollElementFor(scroll.key, pageRef.current);
      if (scrollEl) scrollEl.scrollTop = scroll.top;
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(restore);
    } else {
      setTimeout(restore, 0);
    }
  }, []);

  // Reads `selectedUri` via `selectedUriRef` so the callback identity
  // stays stable across navigation — listing `selectedUri` here would
  // recreate `openEntityDetail` on every entity click, which in turn
  // recreates `handleNavigate` and the cross-tab listener effect (R2-2).
  const openEntityDetail = useCallback((uri: string, originScrollKey?: string) => {
    if (!selectedUriRef.current || !detailOriginRef.current) {
      detailOriginRef.current = captureDetailOrigin(originScrollKey);
    }
    setSelectedUri(uri);
  }, [captureDetailOrigin]);

  const clearDetailOrigin = useCallback(() => {
    detailOriginRef.current = null;
  }, []);

  useEffect(() => {
    if (selectedUri) return;
    const scroll = pendingScrollRestoreRef.current;
    if (!scroll) return;
    pendingScrollRestoreRef.current = null;
    restoreScroll(scroll);
  }, [selectedUri, activeLayer, activeSubGraph, layerContentTabs, subGraphTabs, restoreScroll]);

  // Cross-tab entity open — e.g. the agent profile page in another tab
  // fires a CustomEvent("v10:open-entity", { contextGraphId, entityUri })
  // when the user clicks an activity row. We honour it when it's scoped
  // to *this* project. R2-3 fix: clear `selectedLayerContext` before
  // routing to `openEntityDetail`. Without this, an in-progress detail
  // open (e.g. user opened a WM entity then alt-tabbed without closing)
  // leaves `detailEntities` scoped to the prior layer, so a cross-tab
  // open for a non-WM entity lands in a slice that doesn't contain it,
  // `selectedEntity` resolves to null, and the cleanup effect silently
  // clears the selection — the cross-tab open is dropped on the floor.
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (!detail) return;
      if (detail.contextGraphId !== contextGraphId) return;
      if (typeof detail.entityUri !== 'string') return;
      setSelectedLayerContext(null);
      openEntityDetail(detail.entityUri);
    };
    window.addEventListener('v10:open-entity', handler);
    return () => window.removeEventListener('v10:open-entity', handler);
  }, [contextGraphId, openEntityDetail]);

  const openAgent = useCallback((uri: string) => {
    const slug = uri.startsWith('urn:dkg:agent:')
      ? uri.slice('urn:dkg:agent:'.length)
      : uri;
    const name = agentsData.get(uri)?.name ?? slug;
    openTab({
      id: `agent:${contextGraphId}|${slug}`,
      label: `@ ${name}`,
      closable: true,
    });
  }, [agentsData, contextGraphId, openTab]);

  // Inject the project-aware `openAgent` into the context so every
  // AgentChip under this ProjectView click-opens an agent profile tab
  // without having to thread callbacks through wrapper components.
  const agentsContextValue = useMemo(
    () => ({ ...agentsData, openAgent }),
    [agentsData, openAgent],
  );

  const cg = useMemo(
    () => cgData?.contextGraphs?.find((c: any) => c.id === contextGraphId),
    [cgData, contextGraphId]
  );

  // `signalErrors: true` flips `rawMemory.error` to a real string
  // when all three layer queries fail. Without it the hook treats
  // "every layer failed" as `error: null, partial: false` (since
  // `partial` only triggers on a PARTIAL failure), and the Bug C
  // `memoryReady` gate below incorrectly classes that state as
  // ready — passing an empty entityList into SubGraphBar while the
  // daemon-backed `sg.entityCount` totals stay non-zero (the same
  // contradiction Bug C set out to prevent). Mirrors the
  // DashboardView caller, which already opts in for the same
  // failed-vs-empty-distinct reason.
  const includeQueryCatalogInMemory = showQueryCatalog
    && (activeLayer === 'wm' || activeLayer === 'swm');
  const rawMemory = useMemoryEntities(contextGraphId, {
    signalErrors: true,
    includeQueryCatalog: includeQueryCatalogInMemory,
  });
  // Canonical (de-duped, Root-inclusive) triple total — the SAME number the
  // Subgraph Explorer panel subtitle shows. Fed to the SubGraphBar "All" chip
  // tooltip so it stops reporting "0 triples" on Root-only graphs (the daemon
  // per-named-subgraph sum excludes Root). See SubGraphBar.allTriplesTotal.
  const canonicalTripleTotal = useCanonicalTriples(rawMemory).total;
  // SWM attribution drives the SWM graph's agent-tint legend (its
  // sole remaining consumer). PR #694 review — the Overview no
  // longer reads this stream (lifecycle source replaced it), so the
  // gate is `'swm'`-only now (see `shouldFetchSwmAttribution`); the
  // 5k-row SPARQL no longer fires on Overview renders.
  const swmAttributionNeeded = shouldFetchSwmAttribution({ activeLayer, activeSubGraph });
  const swmAttributionsResult = useSwmAttributions(swmAttributionNeeded ? contextGraphId : undefined);

  // N6 polish (task #23) — bundle-keyed lifecycle events feed the
  // Overview activity feed. Gated to Overview only (PR #694 Comment
  // 20 — we don't fire the 5k-row SPARQL on WM/SWM/VM/Query tabs
  // where nothing consumes it). The hook now PRESERVES its last
  // successful result when the gate flips off (PR #694 Comment 16),
  // so returning to Overview shows the cached events immediately
  // while a background refresh runs — no empty-feed flicker. SWM
  // graph attribution coloring stays on `useSwmAttributions`
  // (separate source of truth for the legend).
  const overviewIsActive = !activeSubGraph && activeLayer === 'overview';
  const lifecycleEventsResult = useAssertionLifecycleEvents(
    overviewIsActive ? contextGraphId : undefined,
  );
  // PR #694 review fix (Comment 6) — when the Overview is the
  // active consumer, pass `[]` during the transition window (cold
  // load, project switch, or post-leave-and-return) instead of
  // `undefined`. The joiner contract is presence-keyed: `[]` opts
  // INTO the lifecycle source (legacy `dcterms:created`-derived
  // `'added'` rows are suppressed); `undefined` falls back to the
  // legacy path. Passing `undefined` mid-transition let legacy
  // rows render briefly before the fetch resolved, then flipped
  // to lifecycle rows — exactly the shape-change Comment 4 was
  // meant to prevent. Empty briefly is better than wrong-shape
  // briefly. Off-Overview we still pass `undefined` so other
  // callers (none today; future surfaces) get the legacy path.
  const overviewLifecycleEvents = overviewIsActive
    ? (lifecycleEventsResult.resultContextGraphId === contextGraphId
        ? lifecycleEventsResult.events
        : [])
    : undefined;
  // PR #694 Comment 8 — plumb the lifecycle error so the feed can
  // distinguish "loaded with zero rows" from "the query failed".
  // After the Comment 3 fix, `resultContextGraphId` advances in
  // both success and catch paths, so consumers can't infer failure
  // from the events array alone. Only surface the error to the
  // Overview consumer; off-Overview the prop stays undefined so
  // legacy callers don't grow an error pathway they don't use.
  const overviewLifecycleError = overviewIsActive
    && lifecycleEventsResult.resultContextGraphId === contextGraphId
    ? lifecycleEventsResult.error
    : null;

  const refreshParticipants = useCallback(() => {
    const targetId = cg?.id;
    if (!targetId) return;
    const requestId = participantsRequestRef.current + 1;
    participantsRequestRef.current = requestId;
    setParticipantsState({ contextGraphId: targetId, list: [], status: 'loading' });
    api.listParticipants(targetId)
      .then(data => {
        if (participantsRequestRef.current !== requestId) return;
        setParticipantsState({ contextGraphId: targetId, list: data.allowedAgents, status: 'ok' });
      })
      .catch(() => {
        if (participantsRequestRef.current !== requestId) return;
        setParticipantsState({ contextGraphId: targetId, list: [], status: 'error' });
      });
  }, [cg?.id]);

  useEffect(() => { refreshParticipants(); }, [refreshParticipants]);

  const refreshSubGraphCount = useCallback(() => {
    const requestId = ++subGraphRequestRef.current;
    // Codex review bug F — route through api-wrapper so the
    // Subgraphs stat resolves in mock mode (the direct
    // `../api.js` import bypassed the mock/offline fallback and
    // left the cell stuck in the loading state forever).
    api.fetchSubGraphs(contextGraphId)
      .then(res => {
        if (subGraphRequestRef.current !== requestId) return;
        // Codex review issue M — single source of truth for the
        // reserved-slug rule. Used by SubGraphBar (chips),
        // SubGraphOverviewGrid (cards), and this Overview stat.
        // Previously diverged between sites; centralising avoids
        // future drift.
        const count = (res.subGraphs ?? []).filter(isUserFacingSubGraph).length;
        setSubGraphCount(count);
        setSubGraphFetchFailed(false);
      })
      .catch(() => {
        if (subGraphRequestRef.current !== requestId) return;
        // Codex review bug D — distinguish "still loading" (count
        // null + failed=false) from "permanently unavailable"
        // (count null + failed=true) so the stat strip can render
        // 'Unavailable' instead of a perpetual ellipsis.
        setSubGraphCount(null);
        setSubGraphFetchFailed(true);
      });
  }, [contextGraphId]);

  useEffect(() => {
    setSubGraphCount(null);
    setSubGraphFetchFailed(false);
    refreshSubGraphCount();
  }, [refreshSubGraphCount]);
  useMemoryGraphEvents(contextGraphId, refreshSubGraphCount);

  const selectedLayerTrust = selectedLayerContext ? TRUST_FOR_LAYER[selectedLayerContext] : null;
  const detailEntityTriples = useMemo(
    () => selectedLayerTrust
      ? rawMemory.allTriples.filter(t => t.layer === selectedLayerTrust)
      : rawMemory.graphTriples,
    [rawMemory.allTriples, rawMemory.graphTriples, selectedLayerTrust],
  );
  const detailTriples = useMemo(
    () => selectedLayerTrust ? dedupeTriplesBySpo(detailEntityTriples) : detailEntityTriples,
    [detailEntityTriples, selectedLayerTrust],
  );
  const detailEntities = useMemo(
    () => selectedLayerTrust
      ? buildMemoryEntities(detailEntityTriples as LayeredTriple[])
      : rawMemory.entities,
    [detailEntityTriples, rawMemory.entities, selectedLayerTrust],
  );
  const selectedEntity = useMemo(
    () => selectedUri ? detailEntities.get(selectedUri) ?? null : null,
    [selectedUri, detailEntities]
  );

  useEffect(() => {
    if (!selectedUri || selectedEntity || rawMemory.loading) return;
    setSelectedUri(null);
    setSelectedLayerContext(null);
    clearDetailOrigin();
  }, [selectedUri, selectedEntity, rawMemory.loading, clearDetailOrigin]);

  // Route a sub-graph chip click to the sub-graph page. Selecting "All"
  // (null) exits the page back to the current layer view, or overview if
  // we were already on one. The optional `originatingLayer` carries the
  // bar's `layer` prop through to the detail view so the user's
  // existing layer scope follows them across the navigation (#9
  // polish, fold-in #4).
  //
  // Three distinct call patterns route differently (PR #793 sweeps 2-3):
  //   1. Exit (slug === null) → clear scope.
  //   2. Layer-mode entry (originatingLayer is set, fired from the bar
  //      mounted on a WM/SWM/VM tab) → seed scope to that single layer.
  //   3. Layer-agnostic entry (originatingLayer === undefined):
  //        a. From the Subgraph Explorer overview (no activeSubGraph
  //           before the click) → clear (fresh entry lands at
  //           all-layers).
  //        b. From an already-scoped detail (activeSubGraph != null
  //           before the click — detail→detail hop on the layer-
  //           agnostic bar inside the detail view) → carry the
  //           DETAIL VIEW'S CURRENT scope through, NOT the stale
  //           seed. Pre-Bug-J this preserved the original seed
  //           (e.g. user enters from WM, widens to WM+SWM in detail,
  //           hops to another subgraph → next detail silently
  //           narrowed back to WM-only). Reading `detailScopeRef`
  //           gives us the user's actual current scope at click time.
  // PR #793 Codex sweep 4 (Bug L) — every branch that updates the
  // `subGraphInitialEnabledLayers` state also writes
  // `detailScopeRef.current` synchronously to the same value. The
  // mirror effect inside SubGraphDetailView only fires after React
  // paints, so without a sync ref write a fast chip-to-chip hop
  // (overview → A → B before A's mount effect runs, or any
  // hop-faster-than-effect-schedule) would read a stale ref and
  // silently lose the intended seed.
  //
  // The new detail view's mirror effect still overwrites
  // `ref.current` once it mounts — usually with the same value —
  // and subsequently with the user's scope changes inside the
  // detail view (which is what Bug J's fix is supposed to
  // capture). The sync write here just closes the pre-mount
  // timing window.
  const handleSelectSubGraph = useCallback((slug: string | null, originatingLayer?: MemoryLayerView) => {
    // Snapshot the prior subgraph identity BEFORE
    // `setActiveSubGraphSync` overwrites it — the layer-agnostic
    // branch's overview-vs-detail discriminator needs the value
    // that was current at click time.
    const priorActiveSubGraph = activeSubGraphRef.current;
    clearDetailOrigin();
    // Commit the new slug — the helper writes both the ref and
    // (for slug === null) the scope-mirror ref, so any
    // sub-branch below that needs to write `detailScopeRef`
    // overrides the helper's clear with a fresh value.
    setActiveSubGraphSync(slug);
    if (slug === null) {
      setSubGraphInitialEnabledLayers(null);
      // detailScopeRef.current and currentDetailScope already
      // cleared by the helper.
    } else if (originatingLayer !== undefined) {
      // Single-layer seed (layer-tab entry).
      const seed = new Set<TrustLevel>([TRUST_FOR_LAYER[originatingLayer]]);
      setSubGraphInitialEnabledLayers(seed);
      detailScopeRef.current = seed;
      // Bar's `enabledScope` prop needs the current scope state
      // immediately so the chip counts agree with the detail
      // view's seed on first render (Bug O — same-screen
      // disagreement at the moment of entry, before the detail
      // view's mirror effect has fired).
      setCurrentDetailScope(seed);
    } else if (priorActiveSubGraph !== null && slug === priorActiveSubGraph) {
      // PR #793 sweep 7 Bug Q — same-chip click. Pre-fix this
      // fell through the detail→detail branch and snapshotted
      // the live `detailScopeRef.current` (which may have
      // widened past the entry seed) into
      // `subGraphInitialEnabledLayers`. Result: the user's
      // entry baseline silently became their current scope; the
      // Bug I `isAtSeededScope` predicate then flipped true so
      // the active-layer pill's "restore originating scope"
      // affordance disappeared. The natural user expectation —
      // pre-PR semantic — is that clicking the chip you're
      // already on is a no-op. Honour that: leave seed and
      // current-scope mirrors untouched.
      return;
    } else {
      // Layer-agnostic detail→detail hop (different chip) OR
      // fresh entry from the overview. Discriminator read from
      // the prior-ref snapshot (not stale closure state) so a
      // fast hop right after another chip click sees the prior
      // detail context correctly.
      if (priorActiveSubGraph !== null && detailScopeRef.current) {
        // Snapshot the current scope into a fresh Set so the
        // unmounting detail view's state mutation (via the next
        // mirror tick) doesn't share the reference. Subsequent
        // fast hops read this snapshot, not the about-to-unmount
        // detail's mutating Set.
        const snapshot = new Set<TrustLevel>(detailScopeRef.current);
        setSubGraphInitialEnabledLayers(snapshot);
        detailScopeRef.current = snapshot;
        setCurrentDetailScope(snapshot);
      } else {
        setSubGraphInitialEnabledLayers(null);
        detailScopeRef.current = null;
        setCurrentDetailScope(null);
      }
    }
    setSelectedUri(null);
    setSelectedLayerContext(null);
  }, [clearDetailOrigin, setActiveSubGraphSync]);

  const handleLayerSwitch = useCallback((layer: LayerView) => {
    clearDetailOrigin();
    setActiveLayer(layer);
    setSelectedUri(null);
    setSelectedLayerContext(null);
    // PR #793 sweep 5 Bug N — go through the sync helper so the
    // refs stay invariant with state. Pre-fix this path bypassed
    // the refs entirely, leaving `activeSubGraphRef` holding the
    // prior subgraph slug. A subsequent layer-agnostic chip
    // click would then misclassify itself as a detail→detail
    // hop and reuse the stale scope.
    setActiveSubGraphSync(null);
    // The seed-state must also clear so the next chip click
    // starts fresh.
    setSubGraphInitialEnabledLayers(null);
  }, [clearDetailOrigin, setActiveSubGraphSync]);

  const handleLayerTabChange = useCallback((layer: MemoryLayerView, tab: LayerContentTab) => {
    setLayerContentTabs(prev => prev[layer] === tab ? prev : { ...prev, [layer]: tab });
  }, []);

  const handleSubGraphTabChange = useCallback((slug: string, tab: SubGraphTab) => {
    setSubGraphTabs(prev => prev[slug] === tab ? prev : { ...prev, [slug]: tab });
  }, []);

  // M2 keeps the user's origin stable: linked entities open in the detail
  // pane, but the underlying layer/sub-graph page does not silently change
  // until S5 adds breadcrumbs that can make that movement visible.
  //
  // Intent: a brand-new top-level open (no selected entity yet) resets
  // the layer context; in-detail navigation (a click inside an open
  // detail) keeps the prior layer context. We read both `selectedUri`
  // (via ref) and the prior `selectedLayerContext` (via the setter
  // `prev` argument) so the callback identity stays stable — listing
  // them in deps would re-create `handleNavigate` on every navigation
  // and rebuild every downstream memo / callback that consumes it.
  const handleNavigate = useCallback((uri: string, originScrollKey?: string, layerContext?: MemoryLayerView) => {
    const hadSelection = selectedUriRef.current != null;
    openEntityDetail(uri, originScrollKey);
    setSelectedLayerContext(prev => layerContext ?? (hadSelection ? prev : null));
  }, [openEntityDetail]);

  const handleDetailClose = useCallback(() => {
    const origin = detailOriginRef.current;
    detailOriginRef.current = null;
    setSelectedUri(null);
    setSelectedLayerContext(null);
    if (!origin) return;
    setActiveLayer(origin.activeLayer);
    // PR #793 sweep 5 Bug N — restoring the M2 origin's
    // activeSubGraph must go through the sync helper so the refs
    // mirror the restored state. When origin.activeSubGraph is
    // null (entity opened from a layer-tab origin), the helper's
    // null branch also clears detailScopeRef so the next chip
    // click sees a clean overview-entry context.
    setActiveSubGraphSync(origin.activeSubGraph);
    // PR #793 sweep 6 Bug P — restore the subgraph scope the
    // user had at entity-open time. Without this the remounted
    // SubGraphDetailView would seed from the stale
    // `subGraphInitialEnabledLayers` (the original entry seed)
    // and silently snap back to it, losing any widening or
    // narrowing the user did inside the detail.
    if (origin.activeSubGraph !== null && origin.subGraphEnabledLayers) {
      const restored = new Set<TrustLevel>(origin.subGraphEnabledLayers);
      setSubGraphInitialEnabledLayers(restored);
      detailScopeRef.current = restored;
      setCurrentDetailScope(restored);
    }
    setLayerContentTabs(origin.layerTabs);
    setSubGraphTabs(origin.subGraphTabs);
    pendingScrollRestoreRef.current = origin.scroll;
  }, [setActiveSubGraphSync]);

  const handleNodeClick = useCallback((node: any) => {
    if (!node?.id) return;
    const layerContext = isMemoryLayerView(node.trustLayer) ? node.trustLayer : undefined;
    handleNavigate(node.id, undefined, layerContext);
  }, [handleNavigate]);

  const handleLayerSelectEntity = useCallback((uri: string) => {
    const layerContext = isMemoryLayerView(activeLayer) ? activeLayer : undefined;
    handleNavigate(uri, undefined, layerContext);
  }, [activeLayer, handleNavigate]);

  const handleOverviewActivityNavigate = useCallback((uri: string) => {
    handleNavigate(uri, 'page');
  }, [handleNavigate]);

  const handleOpenPrimer = useCallback(() => {
    openTab(CONTEXT_GRAPH_PRIMER_TAB);
  }, [openTab]);

  // A 401 surfaces from useFetch as a specific auth-expiry message whose
  // remediation is re-authentication (a page refresh), NOT retrying the fetch —
  // a refetch just 401s again. Detect it so the auth copy + correct affordance
  // isn't buried behind the generic "Failed to load" + Retry path (Codex, #905).
  const cgAuthError = !!cgError && /authentication|unauthor|expired|sign in|log in/i.test(cgError);

  if (!cg) {
    // GH #905: a failed fetch must surface an error + retry, not masquerade as
    // a perpetual loading state. `useFetch` keeps last-good data, so once the
    // list has loaded at least once `cgError` only trips on a genuine refetch
    // failure; `cgData && !cgLoading` covers "loaded fine but this id isn't in
    // the list" (also previously stuck on "Loading…").
    if (cgError || (cgData && !cgLoading)) {
      return (
        <div className="v10-view-placeholder">
          <p style={{ color: 'var(--text-tertiary)', fontSize: 12, marginBottom: 10 }}>
            {cgError
              ? cgAuthError
                ? cgError
                : 'Failed to load context graph.'
              : 'Context graph not found.'}
          </p>
          {cgAuthError ? (
            <button type="button" className="v10-retry-btn" onClick={() => window.location.reload()}>
              Refresh page
            </button>
          ) : (
            <button type="button" className="v10-retry-btn" onClick={refreshContextGraphs}>
              Retry
            </button>
          )}
        </div>
      );
    }
    return (
      <div className="v10-view-placeholder">
        <p style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>Loading context graph...</p>
      </div>
    );
  }

  // Active sub-graph binding (for the breadcrumb strip) — stays in scope
  // across sub-graph / layer / overview routes.
  const activeSubGraphBinding = activeSubGraph ? profile.forSubGraph(activeSubGraph) : null;

  // Codex Bug C — gate the `entities`-driven chip-count path on a
  // fully-loaded memory snapshot. While `useMemoryEntities` is mid-
  // hydration or a layer query is in-flight, `entityList` is partial
  // (often empty) and the chip counts derived from it disagree with
  // the daemon-side `sg.entityCount` fallback used by
  // SubGraphOverviewGrid — same screen, two numbers for the same
  // subgraph. Passing `undefined` keeps SubGraphBar on the daemon
  // total path until both readiness conditions hold; the `partial`
  // flag covers individual-layer fetch failures (counts incomplete
  // but not absent), which is also a contradiction we don't want
  // surfacing on the chip row.
  const memoryReady = !rawMemory.loading && !rawMemory.error && !rawMemory.partial;
  const chipBarEntities = memoryReady ? rawMemory.entityList : undefined;
  const activePage = selectedEntity
    ? 'entity'
    : activeSubGraph
      ? 'subgraph'
      : activeLayer;
  const participantsForCurrentGraph = participantsState.contextGraphId === cg.id
    ? participantsState.list
    : [];
  const participantsStatusForCurrentGraph = participantsState.contextGraphId === cg.id
    ? participantsState.status
    : 'loading';

  return (
    <ProjectProfileContext.Provider value={profile}>
    <AgentsContext.Provider value={agentsContextValue}>
    <div className="v10-memory-explorer">
      {/* GH #905: when a project is already open, `useFetch` keeps the
          last-good `cgData`, so a failing 30s refresh leaves `cg` truthy and
          the view would silently show stale data. Surface an inline,
          non-blocking banner + retry while keeping the content visible
          (Codex). Clears automatically once a refresh succeeds. */}
      {cgError && (
        <div className="v10-stale-banner" role="status">
          {cgAuthError ? (
            <>
              <span>{cgError}</span>
              <button type="button" className="v10-retry-btn" onClick={() => window.location.reload()}>
                Refresh page
              </button>
            </>
          ) : (
            <>
              <span>Couldn’t refresh context-graph data — showing last known values.</span>
              <button type="button" className="v10-retry-btn" onClick={refreshContextGraphs}>
                Retry
              </button>
            </>
          )}
        </div>
      )}
      {/* Persistent project chrome — always visible so the user never
          loses "which project am I in" context when drilling into a
          sub-graph, a layer, or an entity detail. */}
      <ProjectHeaderStrip
        cg={cg}
        profile={profile}
        activeSubGraph={activeSubGraphBinding}
        onClearSubGraph={() => handleSelectSubGraph(null)}
      />

      {/* Layer Switcher — always visible now. Clicking a layer from within
          a sub-graph page exits back to that layer's top-level view, which
          is the least surprising thing a persistent top-nav can do. */}
      <LayerSwitcher
        active={activeLayer}
        counts={rawMemory.counts}
        onSwitch={handleLayerSwitch}
        onShare={() => setShowShare(true)}
        onImport={() => setShowImport(true)}
        onRefresh={rawMemory.refresh}
      />

      <main className="v10-memory-explorer-page" data-view={activePage} data-cg-scroll-key="page" ref={pageRef}>
      {/* Drilldown overlay */}
      {selectedEntity && (
        <KADetailView
          entity={selectedEntity}
          allEntities={detailEntities}
          allTriples={detailTriples}
          onNavigate={handleNavigate}
          onClose={handleDetailClose}
          contextGraphId={contextGraphId}
          onRefresh={rawMemory.refresh}
        />
      )}

      {/* Subgraph Explorer — page mode (specific chip or Root selected).
          First-class peer of the layer views; the page identity, intro
          and chip row are shared with the All / Subgraphs-overview state
          (rendered below in the graph-overview branch). */}
      {activeSubGraph && !selectedEntity && (
        <>
          <SubGraphExplorerHeader />
          <SubGraphBar
            contextGraphId={contextGraphId}
            profile={profile}
            selected={activeSubGraph}
            entities={chipBarEntities}
            onSelect={handleSelectSubGraph}
            /* Bug O — chip counts now reflect the detail's
               current scope so the bar and the body show
               consistent numbers (no all-three counts above
               a filtered detail). The state is updated
               synchronously by `handleSelectSubGraph` on entry
               + on user toggles via the mirror callback. */
            enabledScope={currentDetailScope ?? undefined}
            allTriplesTotal={canonicalTripleTotal}
          />
          <SubGraphDetailView
            slug={activeSubGraph}
            rawMemory={rawMemory}
            contextGraphId={contextGraphId}
            onNodeClick={handleNodeClick}
            onSelectEntity={handleNavigate}
            activeTab={subGraphTabs[activeSubGraph] ?? 'items'}
            onTabChange={tab => handleSubGraphTabChange(activeSubGraph, tab)}
            initialEnabledLayers={subGraphInitialEnabledLayers ?? undefined}
            onEnabledLayersChange={handleDetailEnabledLayersChange}
            onOpenQueryCatalog={() => {
              setActiveSubGraphSync(null);
              setActiveLayer('query');
            }}
          />
        </>
      )}

      {/* Overview View — S2 finalize section order (§4.2.1):
          identity row + At a glance + Knowledge Pipeline + Participant
          agents live inside ProjectOverviewCard. Pending join requests
          is a peer section below it (curator-only). Recent activity
          moves to the last content row before the primer escape hatch
          which lives inside the card's footer. */}
      {!activeSubGraph && activeLayer === 'overview' && !selectedEntity && (
        <>
          <ProjectOverviewCard
            cg={cg}
            memory={rawMemory}
            subGraphCount={subGraphCount}
            subGraphFetchFailed={subGraphFetchFailed}
            participants={participantsForCurrentGraph}
            participantsStatus={participantsStatusForCurrentGraph}
            currentAgent={currentAgent ?? null}
            currentAgentStatus={currentAgentLoading ? 'loading' : currentAgentError ? 'error' : 'ok'}
            onSwitchLayer={handleLayerSwitch}
            onOpenPrimer={handleOpenPrimer}
          />
          <PendingJoinRequestsSection
            contextGraphId={contextGraphId}
            curatorStatus={curatorStatusForOverview({
              cg,
              currentAgent: currentAgent ?? null,
              currentAgentStatus: currentAgentLoading ? 'loading' : currentAgentError ? 'error' : 'ok',
            })}
            onParticipantsChanged={refreshParticipants}
          />
          {rawMemory.loading && (
            <div className="v10-me-loading"><div className="v10-me-loading-text">Loading memory...</div></div>
          )}
          {rawMemory.error && (
            <div className="v10-me-error">Error: {rawMemory.error}</div>
          )}
          <div data-section="activity">
            <ActivityFeed
              entities={rawMemory.entityList}
              lifecycleEvents={overviewLifecycleEvents}
              lifecycleError={overviewLifecycleError}
              onSelectEntity={handleOverviewActivityNavigate}
              title="Recent activity"
              limit={40}
              includeUndated={false}
              emptyHint="Once knowledge starts being added and managed in this context graph, activities will show up here as a live feed."
              className="v10-overview-activity"
            />
          </div>
          <OverviewPrimerEntry onOpenPrimer={handleOpenPrimer} />
        </>
      )}

      {/* Subgraph Explorer — All state (page heading + intro + chip row
          + card-wall body). Selecting a chip transitions to the detail
          body via `activeSubGraph` (branch above). */}
      {!activeSubGraph && activeLayer === 'graph-overview' && !selectedEntity && (
        <>
          <SubGraphExplorerHeader />
          <SubGraphBar
            contextGraphId={contextGraphId}
            profile={profile}
            selected={null}
            entities={chipBarEntities}
            onSelect={handleSelectSubGraph}
            allTriplesTotal={canonicalTripleTotal}
          />
          <SubGraphOverviewGrid
            contextGraphId={contextGraphId}
            memory={rawMemory}
            onNodeClick={handleNodeClick}
            onSelectSubGraph={handleSelectSubGraph}
          />
        </>
      )}

      {!activeSubGraph && activeLayer === 'query' && !selectedEntity && (
        <ContextGraphQueryView contextGraphId={contextGraphId} />
      )}

      {/* Layer Detail Views */}
      {!activeSubGraph && (activeLayer === 'wm' || activeLayer === 'swm' || activeLayer === 'vm') && !selectedEntity && (
        <>
          <SubGraphBar
            contextGraphId={contextGraphId}
            profile={profile}
            selected={activeSubGraph}
            entities={chipBarEntities}
            onSelect={handleSelectSubGraph}
            layer={activeLayer}
          />
          <LayerDetailView
            layer={activeLayer}
            memory={rawMemory}
            onNodeClick={handleNodeClick}
            onSelectEntity={handleLayerSelectEntity}
            contextGraphId={contextGraphId}
            activeTab={layerContentTabs[activeLayer]}
            onTabChange={tab => handleLayerTabChange(activeLayer, tab)}
            swmAttribution={swmAttributionsResult}
            showQueryCatalog={showQueryCatalog}
            onShowQueryCatalogChange={setShowQueryCatalog}
          />
        </>
      )}

      </main>

      <ImportFilesModal
        open={showImport}
        onClose={() => setShowImport(false)}
        contextGraphId={cg.id}
        contextGraphName={cg.name}
      />
      <ShareProjectModal
        open={showShare}
        onClose={() => setShowShare(false)}
        contextGraphId={cg.id}
        contextGraphName={cg.name}
      />
    </div>
    </AgentsContext.Provider>
    </ProjectProfileContext.Provider>
  );
}
