import React, { useMemo, useState, useCallback, useEffect, Suspense } from 'react';
import { executeQuery, type QueryExecutionView, type SubGraphInfo } from '../../../api.js';
// PR #2131 review — route through api-wrapper so the cards resolve in mock
// mode (see SubGraphBar.tsx). `withFallback` only diverts when mock mode is
// latched, so a real transient failure still rejects into `setFetchError`.
import { api } from '../../../api-wrapper.js';
import { useMemoryEntities, canonicalEntityUri, type TrustLevel, type MemoryEntity, type Triple, type LayeredTriple } from '../../../hooks/useMemoryEntities.js';
import { useProjectProfileContext } from '../../../hooks/useProjectProfile.js';
import { useAgentsContext } from '../../../hooks/useAgents.js';
import { AgentChip } from '../../../components/AgentChip.js';
import { SubGraphBar } from '../../../components/SubGraphBar.js';
import { memoryGraphLabels } from '../../../lib/memoryLabels.js';
import { TRUST_COLORS, LAYER_CONFIG, CODE_CLASS_COLORS, CODE_PREDICATE_COLORS, entityAuthorUri, entityMeta, neutraliseBuiltinNamespaces, useLayerTriples, useCanonicalTriples, applyCanonicalAdmission, filterTriplesToEntities, admitTripleForScope, entityTimestamp, formatTimelineBucket, type SubGraphTab, type SubGraphEntitySort } from '../helpers.js';
import { EmptyState } from '../../../components/ContextGraphPrimitives.js';
import { isUserFacingSubGraph, ROOT_SLUG_SENTINEL } from '../../../lib/subGraphs.js';
import { applyHeaviestSubjectsCap, RdfGraph, LayerGraphPanel } from './graph.js';
import { EntityList, DocumentsList } from './entities.js';

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
    api.fetchSubGraphs(contextGraphId)
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

  // GH #819 — canonical triple set: single helper call surfaces
  // both the subtitle total AND the input for `triplesBySubGraph`
  // + Root mini-card derivations below. Lock subtitle + Overview
  // Triples stat + named cards' `tripleCount` + Root card to one
  // source of truth.
  // History: GH #805 swapped subtitle from `memory.allTriples.length`
  // to a `useLayerTriples` layer-sum; that was correct on per-layer
  // residue + cross-graph dedup but still dropped mixed-layer
  // edges. The canonical helper's BOTH-endpoints-moved rule keeps
  // those mixed-layer edges as facts.
  const { total: subtitleTripleCount } = useCanonicalTriples(memory);

  // GH #819 round 7 (Codex sweep 5 🔴 #14) — split the hydration
  // gate from the failure gate. Round 6 collapsed both into one
  // `canonicalIncomplete` flag and rendered the "Loading…"
  // affordance for both — so a settled error/partial result kept
  // masquerading as in-progress hydration forever.
  //
  // `MemoryLayerStatus` is `'loading' | 'ok' | 'error'`
  // (`useMemoryEntities.ts:8`). `isHydrating` covers the transient
  // state (initial fetch in flight, or any layer's status === 'loading');
  // `isFailedOrPartial` covers the settled-incomplete state
  // (hard error, partial result, or any layer's status === 'error').
  // The badge matrix at the render site routes them to different
  // affordances: loading → `…`, failed/partial → `0 triples` with
  // a "Some layers unavailable" tooltip.
  const layerStatuses = Object.values(memory.layerStatus ?? {});
  const isHydrating =
    memory.loading || layerStatuses.some(s => s === 'loading');
  const isFailedOrPartial =
    memory.error !== null
    || memory.partial
    || layerStatuses.some(s => s === 'error');

  // Task #25 (PR #677) — entity-only filter for the mini-card
  // thumbnails. Same rule the Entities tab uses; computed per card
  // scoped to that card's sub-graph (Codex Ev_S2): an entity that's
  // first-class in sub-graph B but only a value/provenance object in
  // sub-graph A must not render on A's thumbnail. Per-sub-graph scope
  // = `memory.entityList.filter(e => e.subGraphs.has(sg.name))`.
  //
  // GH #819 round 11 (Codex sweep 9 🔴 #19) — also consumed by the
  // bucketer below for promoted-untagged row recovery (via
  // `admitTripleForScope`), so it's hoisted above the bucketer's
  // useMemo.
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

  // Bucket every triple by its origin sub-graph so each mini-graph
  // renders just its slice. Cap per-bucket via the shared
  // `applyHeaviestSubjectsCap` helper at module scope (see its doc
  // block for the sampling / dense-pack / residual-fallback
  // rationale carried over from PR #818 sweeps 1-3).
  //
  // GH #819 round 4 (Codex sweep 2 🔴 #5) — apply the canonical
  // admission rule (residue filter + canonical-SPO dedup) PER
  // BUCKET. Per-call dedup state means cross-scope SPOs each admit
  // in their own scope (round 3 🔴 #1 property preserved).
  //
  // GH #819 round 11 (Codex sweep 9 🔴 #19) — recover promoted-
  // untagged rows. After promote/publish the daemon strips
  // `subGraph` from triples; pre-round-11 we filtered to tagged
  // rows only, so a fully-promoted subgraph's mini-card showed
  // `0 triples` even though deep-dive listed the data. The rest
  // of the UI recovers via `admitTripleForScope` entity-scope
  // membership; the bucketer now mirrors that. Pass 1 keeps tagged
  // rows in their declared bucket; pass 2 admits each untagged row
  // to EVERY bucket whose `entityUrisBySubGraph` contains the
  // subject or resource-object (no inner-loop break — a cross-
  // membership entity's untagged edges legitimately appear in
  // multiple subgraphs, preserving the round 3 #1 contract).
  //
  // `tripleCountBySubGraph` carries the pre-cap distinct total so
  // the card stat reads the true count (decoupled from the
  // post-cap rendered slice — same convention as Root card +
  // PR #839 sweep 2's helper-extract contract).
  const { triplesBySubGraph, tripleCountBySubGraph } = useMemo(() => {
    const rawBySg = new Map<string, LayeredTriple[]>();
    // Pass 1: tagged rows route to their declared bucket.
    for (const t of memory.allTriples) {
      if (!t.subGraph) continue;
      let arr = rawBySg.get(t.subGraph);
      if (!arr) { arr = []; rawBySg.set(t.subGraph, arr); }
      arr.push(t);
    }
    // Pass 2: untagged rows recover via entity-scope membership
    // (`admitTripleForScope` with `isRoot: false` and the bucket's
    // scoped URI set — same rule the rest of the UI uses for
    // sub-graph scope, PR #839 sweep 2 helper-extract).
    for (const t of memory.allTriples) {
      if (t.subGraph) continue;
      for (const [sg, scopedUris] of entityUrisBySubGraph) {
        if (admitTripleForScope(t, { slug: sg, isRoot: false, scopedUris })) {
          let arr = rawBySg.get(sg);
          if (!arr) { arr = []; rawBySg.set(sg, arr); }
          arr.push(t);
          // No break — cross-membership entity's untagged edges
          // legitimately appear in multiple subgraphs.
        }
      }
    }
    // Pass 3: apply canonical admission (residue + canonical-SPO
    // dedup) per bucket independently.
    const bySg = new Map<string, Triple[]>();
    const countBySg = new Map<string, number>();
    for (const [sg, rawRows] of rawBySg) {
      const admitted = applyCanonicalAdmission(rawRows, memory.entities);
      const stripped = admitted.map(t => ({
        subject: t.subject,
        predicate: t.predicate,
        object: t.object,
      }));
      countBySg.set(sg, stripped.length);
      bySg.set(sg, applyHeaviestSubjectsCap(stripped));
    }
    return { triplesBySubGraph: bySg, tripleCountBySubGraph: countBySg };
  }, [memory.allTriples, memory.entities, entityUrisBySubGraph]);

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
          // GH #819 — `tripleCount` reads the canonical per-subgraph
          // pre-cap distinct total (`tripleCountBySubGraph` derived
          // from `canonicalTriples` post-residue-filter +
          // post-dedup). Card stat now agrees with the subtitle's
          // distinct total when summed without double-counting
          // cross-graph duplicates. Pre-#819 this read `sg.tripleCount`
          // (daemon-reported raw count) which inflated on CGs with
          // cross-graph SPO duplicates.
          //
          // GH #819 round 3 (Codex sweep 1 🔴 #3) — fallback to the
          // daemon-reported `sg.tripleCount` while the canonical
          // universe is INCOMPLETE for any reason: loading, hard
          // error, partial result (some layer query failed), or any
          // per-layer status not yet 'ok'. Round 2 gated only on
          // `memory.loading` which missed the post-hydration error
          // case (`loading` flips false but the canonical universe
          // is still incomplete because a layer query failed).
          //
          // GH #819 round 5 (Codex sweep 3 🔴 #8) — never read the
          // daemon-reported `sg.tripleCount`. The daemon route
          // (`packages/cli/src/daemon/routes/context-graph.ts:769`)
          // builds it via raw `COUNT(*)` SPARQL grouped by named
          // graph and sums per first-path-segment — NO SPO-dedup,
          // NO residue filter. So `sg.tripleCount` is structurally
          // inflated by the same cross-graph dupes + WM residue
          // this PR is removing. Earlier rounds tried to use it as
          // a lower-bound fallback when canonical was incomplete;
          // that was wrong — it's an UPPER bound (inflated), not a
          // lower one. Render the client-canonical bucket honestly,
          // even when a layer query errored mid-hydration: missing
          // bucket → 0 (genuine empty), partial-hydrated → the
          // count of what we could honestly admit. No upward clamp.
          tripleCount: tripleCountBySubGraph.get(sg.name) ?? 0,
          triples: filterTriplesToEntities(rawTriples, cardEntityUris),
          layerCounts: layerCountsBySubGraph.get(sg.name) ?? { wm: 0, swm: 0, vm: 0 },
          entityTrustByUri: cardEntityTrust,
        };
      })
      .sort((a, b) => a.rank - b.rank);
  }, [subGraphs, profile, triplesBySubGraph, tripleCountBySubGraph, layerCountsBySubGraph, entityUrisBySubGraph, entityTrustByUriBySubGraph]);

  // GH #813 — Root mini-card. Synthesizes a card for the
  // "entities not in any named sub-graph" bucket so the grid
  // mirrors the SubGraphBar chip row (which already exposes Root
  // as a peer of the named chips). Renders LAST, after named
  // cards, mirroring the Root chip's rightmost chip-row position.
  //
  // The derivations below mirror SubGraphDetailView's Root branch
  // (`isRoot = slug === ROOT_SLUG_SENTINEL` at `:4527`):
  //   • scoped entities: `subGraphs.size === 0` (same rule as
  //     SubGraphBar.rootEntityCount).
  //   • scoped triples: rule (1) "exact-tag-routing" can never
  //     fire for Root (the Root bucket carries no tagged triples
  //     by definition) — only the untagged-recovery branch admits
  //     triples whose subject OR resource-object is in scope.
  // Same canonical-source discipline as round 4.1's subtitle
  // anchor; what you click maps to the same scope the Root
  // detail view shows.
  //
  // Edge case — CG with zero root entities: we still render the
  // card (option b per team-lead lean). Named subgraphs with 0
  // entities render the same "No data yet" empty-state branch;
  // hiding Root only would create inconsistency (and a missing
  // affordance for the user wondering whether the bucket exists).
  const rootCard = useMemo(() => {
    const rootEntities: typeof memory.entityList = [];
    const rootEntityUris = new Set<string>();
    const rootEntityTrust = new Map<string, TrustLevel>();
    let wm = 0, swm = 0, vm = 0;
    for (const e of memory.entityList) {
      if (e.subGraphs.size > 0) continue;
      rootEntities.push(e);
      const canonical = canonicalEntityUri(e.uri);
      rootEntityUris.add(canonical);
      rootEntityTrust.set(canonical, e.trustLevel);
      if (canonical !== e.uri) rootEntityTrust.set(e.uri, e.trustLevel);
      if (e.trustLevel === 'verified') vm++;
      else if (e.trustLevel === 'shared') swm++;
      else wm++;
    }
    // Untagged-recovery only — Root bucket has no tagged triples
    // by definition (see SubGraphDetailView's rule 1 → "never
    // fires for Root"). A triple admitted here must have NO
    // subGraph tag AND an endpoint in scope.
    //
    // PR #818 Codex sweep 4 (ux-lead Finding 1+2 verdict A) —
    // reverted from sweep-2's `useLayerTriples` union back to
    // `memory.allTriples` filtered by `!t.subGraph`. Sweep 2's
    // layer-correct universe was a fix at the symptom (Root
    // inflation) that introduced two regressions of its own at
    // the next consumer downstream:
    //   • Per-slice SPO-dedup race — `useLayerTriples` dedupes
    //     within each layer independently, so the same SPO under
    //     both root and per-sub-graph SWM graphs collapsed to one
    //     ENTRY in the swm slice. Joining the slices then admitted
    //     it once. Outcome: a cross-graph triple involving a root
    //     entity could under-count to zero on the Root mini-card.
    //   • Mixed-layer edge drop — `useLayerTriples` applies a
    //     subject-trust-level residue filter (drops triples whose
    //     subject's canonical trustLevel doesn't match the slice's
    //     layer). For a WM root entity pointing at an SWM entity,
    //     the row enters the wm slice (subject is WM), passes the
    //     subject check, but the row's `layer: 'shared'` means it
    //     was never in the wm slice. The same row enters the swm
    //     slice but fails the subject-trust check (subject is WM,
    //     slice is SWM). The mixed-layer edge falls through every
    //     slice and never reaches the Root card.
    // ux-lead's call: restoring symmetry with the named-card path
    // (`memory.allTriples` filtered by `!t.subGraph` vs
    // `t.subGraph === slug`) gives both cards the same machinery
    // and the same edge cases. Inflation (WM residue + SWM cross-
    // graph) is consistent across Root AND named cards — easier
    // to reason about and easier to fix in one render-side follow-
    // up (GH #819) than a Root-specific divergence between
    // under-count and inflation.
    //
    // PR #818 Codex sweep 1 — Bug M family (preserved). The
    // canonical-URI membership check + canonical SPO-dedup key
    // still apply on the symmetric-with-named universe.
    //
    // PR #818 Codex sweep 6 — admission rule symmetry. Named
    // cards route through `filterTriplesToEntities(rawTriples,
    // cardEntityUris)` at `:4051` (AND-membership with rdf:type
    // exemption). User caught the divergence on `ui-refresh`:
    // pre-sweep-6 OR-membership admitted rows whose non-root
    // object rendered as a phantom node in the Root mini-graph.
    //
    // GH #819 round 4 (Codex sweep 2 🔴 #7) — Root candidates
    // are root-scoped rows (`!t.subGraph`) from raw
    // `memory.allTriples`, then passed through
    // `applyCanonicalAdmission` for independent per-scope
    // residue + SPO dedup. Pre-round-4 this filtered
    // `canonicalTriples` (which had already been GLOBALLY
    // deduped) for `!t.subGraph` rows — order-dependent: if a
    // tagged copy of the same SPO arrived first in the global
    // pass, the root copy lost the dedup race and `filter(!t.subGraph)`
    // dropped the surviving entry, leaving Root showing 0.
    // Same root-cause family as 🔴 #5 — global dedup namespace
    // collided with per-scope needs. Per-call namespace via
    // `applyCanonicalAdmission` fixes both.
    //
    // Then routed through `filterTriplesToEntities` for AND-
    // membership + rdf:type exemption (PR #818 sweep 6
    // admission rule preserved).
    const rootScopedRaw = memory.allTriples.filter(t => !t.subGraph);
    const candidateTriples = applyCanonicalAdmission(rootScopedRaw, memory.entities)
      .map(t => ({ subject: t.subject, predicate: t.predicate, object: t.object }));
    // GH #819 round 11 (Codex sweep 9 🟡 #20) — Root tripleCount
    // is the PRE-`filterTriplesToEntities` candidate count, mirroring
    // the named-card contract (`tripleCountBySubGraph` is set from
    // `applyCanonicalAdmission` output, also pre-filter). Pre-round-11
    // Root read `rootTriples.length` (post-AND-filter), so an
    // untagged root-scoped edge to a non-root entity contributed to
    // the subtitle total (canonical pass admits it) but showed as
    // 0 on the Root card (AND-filter drops it because the non-root
    // object isn't in `rootEntityUris`). Stat (0) === rendered (0)
    // meant the β stat-vs-rendered tooltip never fired — no
    // disclosure of the asymmetry. Carrying the pre-filter count
    // restores symmetry with named cards and lets the β tooltip
    // fire naturally when the count exceeds the rendered slice.
    const rootTripleCount = candidateTriples.length;
    const rootTriples = filterTriplesToEntities(candidateTriples, rootEntityUris);
    // PR #818 Codex sweep 4 (finding 3) — shared cap helper. The
    // earlier inline copy duplicated the named-card sampling shape
    // verbatim; refactored to call `applyHeaviestSubjectsCap` so
    // both paths stay in lockstep when the sampling rule evolves.
    const cappedRootTriples = applyHeaviestSubjectsCap(rootTriples);
    const binding = profile?.forSubGraph(ROOT_SLUG_SENTINEL) ?? {};
    return {
      slug: ROOT_SLUG_SENTINEL,
      icon: binding.icon ?? '⊘',
      // Color left unset — the chrome falls through to neutral
      // tokens via the `.v10-sgov-card.root` modifier (mirrors
      // the chip's `--text-tertiary` neutral fallback).
      color: binding.color ?? '#64748b',
      displayName: binding.displayName ?? 'Root',
      description: binding.description,
      rank: 999,
      entityCount: rootEntities.length,
      // tripleCount stays the pre-cap distinct total so the
      // stats badge reports the true count (matches what the
      // Root detail view would show), while `triples` carries
      // the post-cap sampled slice the mini-graph renders.
      // Mirrors the named-card behaviour where `sg.tripleCount`
      // (daemon-reported) decouples the badge from the rendered
      // slice.
      tripleCount: rootTripleCount,
      triples: cappedRootTriples,
      layerCounts: { wm, swm, vm },
      entityTrustByUri: rootEntityTrust,
    };
  }, [memory.entityList, memory.allTriples, memory.entities, profile]);

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
  // PR #818 Codex sweep 1 — the teaching empty state fires when
  // there are no named sub-graphs registered. Pre-sweep the gate
  // was `cards.length === 0` alone, which short-circuited the
  // grid render BEFORE the Root mini-card render block — so a CG
  // with no named sub-graphs but non-zero root entities lost the
  // direct Root affordance (user had to click the empty-state's
  // "View root" CTA instead of seeing the Root card in-place).
  //
  // Post-sweep: only render the teaching empty state when BOTH the
  // named-sub-graph set AND the Root bucket are empty — the only
  // truly "nothing to show" case. Three resulting states:
  //   • named cards + Root entities → full grid (named cards +
  //     Root card last)
  //   • zero named cards + Root entities → grid renders only the
  //     Root card (it stands alone as the entire grid)
  //   • zero named cards + zero Root entities → teaching empty
  //     state (unchanged behaviour for the truly-empty case)
  if (cards.length === 0 && rootCard.entityCount === 0) {
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
        {/* Round 4.1 (ux-lead, GH #812) — subtitle anchors to
            canonical hook surfaces (`memory.counts.total` for
            entities, layer-sum via `useLayerTriples` for triples)
            so it matches both the SubGraphBar `All` chip AND the
            per-layer LayerStats by construction.
            Pre-round-4.1: derived from card-level aggregates
            (sum-of-`entityCount` double-counted cross-membership
            entities; sum-of-`tripleCount` excluded the root bucket).
            Round 4.1 swapped to `memory.counts.total` + raw
            `memory.allTriples.length` — entity anchor was correct,
            triple anchor was still inflated by SWM cross-graph SPO
            duplicates + WM residue (GH #805). The #805 layer-sum
            fix on the same surface makes subtitle == Overview
            Triples == per-layer LayerStats.
            PR #818 Codex sweep 2 — label says "named subgraphs"
            (was "subgraphs"). The Root mini-card is a peer-but-
            different surface that now renders in the grid; the
            old label overstated what `cards.length` includes
            (named subgraphs only, never Root) and produced a
            "0 subgraphs" subtitle reading while a Root card
            visibly rendered. The new label is honest about the
            count's scope and applies regardless of Root
            presence. */}
        <div className="v10-sgov-sub">
          {cards.length} named subgraphs · {memory.counts.total} entities · {subtitleTripleCount} triples
        </div>
      </div>
      <div className="v10-sgov-grid">
        {cards.map(card => (
          <SubGraphMiniCard
            key={card.slug}
            card={card}
            isHydrating={isHydrating}
            isFailedOrPartial={isFailedOrPartial}
            onNodeClick={onNodeClick}
            onOpen={() => onSelectSubGraph(card.slug)}
          />
        ))}
        {/* GH #813 — Root mini-card. Last position mirrors the
            Root chip's rightmost chip-row position. Rendered even
            at 0 entities (consistency with named cards' empty
            branches; option b per team-lead lean). The `root`
            modifier on the card chrome reads as "synthesized
            bucket" vs the solid borders of daemon-emitted cards. */}
        <SubGraphMiniCard
          key={ROOT_SLUG_SENTINEL}
          card={rootCard}
          isHydrating={isHydrating}
          isFailedOrPartial={isFailedOrPartial}
          onNodeClick={onNodeClick}
          onOpen={() => onSelectSubGraph(ROOT_SLUG_SENTINEL)}
          variant="root"
        />
      </div>
    </div>
  );
}

export function SubGraphMiniCard({
  card,
  isHydrating = false,
  isFailedOrPartial = false,
  onNodeClick,
  onOpen,
  variant,
}: {
  card: {
    slug: string; icon: string; color: string; displayName: string;
    description?: string; entityCount: number; tripleCount: number;
    triples: Triple[];
    layerCounts: { wm: number; swm: number; vm: number };
    entityTrustByUri: Map<string, TrustLevel>;
  };
  // GH #819 round 7 (Codex sweep 5 🔴 #14) — split hydration vs
  // failure flags. `isHydrating` is the transient state (still
  // fetching, no settled result yet); the badge renders the `…`
  // loading affordance when bucket is empty. `isFailedOrPartial`
  // is the settled-incomplete state (hard error or partial
  // result); the badge keeps `0 triples` but adds a tooltip so
  // users see the result is best-effort. Both default to false
  // so consumers that don't thread the gates render the badge
  // exactly as before.
  isHydrating?: boolean;
  isFailedOrPartial?: boolean;
  onNodeClick?: (node: any) => void;
  onOpen: () => void;
  // GH #813 — `root` opts into the quieter neutral-border chrome
  // that distinguishes the synthesized Root bucket from daemon-
  // emitted named sub-graphs (which carry per-card `--sg-color`
  // tinted borders). Same render shape, different chrome modifier.
  variant?: 'root';
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

  const isRoot = variant === 'root';
  return (
    <div
      className={`v10-sgov-card${isRoot ? ' root' : ''}`}
      style={isRoot
        // Root card: chrome falls through to neutral tokens via
        // the `.root` modifier — no per-card color injection.
        ? undefined
        : {
            '--sg-color': card.color,
            borderColor: card.color + '55',
          } as React.CSSProperties}
    >
      <div className="v10-sgov-card-head">
        <span className="v10-sgov-card-icon" style={isRoot ? undefined : { color: card.color }}>{card.icon}</span>
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
        {/* GH #819 round 2 — conditional stat-vs-rendered tooltip
            (ux-lead lock, option (i) from sweep 1 yellow finding).
            When the in-scope canonical count differs from what
            actually renders on the mini-graph (cross-card edges
            whose other endpoint isn't in this subgraph drop via
            `filterTriplesToEntities`, or `applyHeaviestSubjectsCap`
            truncated a populated bucket), surface the gap via a
            native `title` tooltip on the badge. When equal (most
            common — no cross-card edges + bucket under the cap),
            no tooltip is added so we don't add chrome to the
            quiet case. Same conditional-when-it-has-something-to-
            say pattern as S2's `Pending join requests` empty
            state. */}
        {/* GH #890 round 2 (Codex sweep 1 🟡 A) — bucket-aware
            precedence. Round 1 (#882) made `isHydrating`
            short-circuit the entire chain, so a mixed state
            (some layers `loading`, others `error`) on a non-zero
            bucket rendered the optimistic "still loading; count
            may grow" tooltip and masked the known-incomplete
            failure. Round 2 splits the precedence so the failure
            disclosure wins everywhere except the zero-bucket
            initial-fetch window:
              1. hydrating + bucket 0 → `…` "Loading triples…"
                 (loading affordance is the priority signal when
                 we have no count yet — preserves the round 6 #11
                 anti-flash contract: `useMemoryEntities`
                 initializes `allTriples = []` so a real subgraph
                 briefly shows 0 during initial fetch)
              2. failed/partial (any bucket) → failure tooltip
                 (wins over hydrating on non-zero — the count is
                 already known-incomplete because a layer errored)
              3. hydrating + bucket > 0 (no failure) → "still
                 loading; count may grow" (#882 wording, only
                 fires when no failure flag is set)
              4. stat-vs-rendered mismatch → β literal (round 8)
              5. otherwise → no tooltip */}
        <span
          className="v10-sgov-card-stat"
          title={
            isHydrating && card.tripleCount === 0
              ? 'Loading triples for this subgraph…'
              : isFailedOrPartial
                ? card.tripleCount === 0
                  ? 'Some layers unavailable; count may be incomplete.'
                  : `${card.tripleCount} triples (some layers unavailable; count may be incomplete).`
                : isHydrating
                  ? `${card.tripleCount} triples (still loading; count may grow).`
                  : card.tripleCount !== card.triples.length
                    // GH #819 round 8 (Codex sweep 6 🟡 #4 / #9 / #12,
                    // team-lead call β) — broader wording so the
                    // tooltip covers both causes of stat-vs-rendered
                    // gap: (1) cross-card edges whose other endpoint
                    // sits outside the subgraph and (2) cap-trimmed
                    // rows in dense buckets via `applyHeaviestSubjectsCap`.
                    // Earlier copy blamed only cause (1); Codex
                    // re-raised the cap-trim case 5 sweeps in a row.
                    ? `${card.tripleCount} triples in this subgraph's scope; ${card.triples.length} rendered (some in-scope edges aren't drawn — either endpoints outside this subgraph, or cap-trimmed in dense buckets).`
                    : undefined
          }
        ><b>{isHydrating && card.tripleCount === 0 ? '…' : card.tripleCount}</b> triples</span>
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
  // erased-tag recovery second — see `admitTripleForScope` in
  // `helpers.ts` for the three-rule shape (the extracted predicate
  // shared with `singleLayerPanelTriples` per PR #839 sweep 2).
  const scopedTriples = useMemo(
    () => rawMemory.graphTriples.filter(t =>
      admitTripleForScope(t, { slug, isRoot, scopedUris }),
    ),
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
    // Task #19 — exact-tag-routing via the shared
    // `admitTripleForScope` helper (PR #839 sweep 2 extract).
    // `requireResourceObject: true` keeps the object-side recovery
    // limited to resource-shaped objects on this surface; literals
    // reach the panel via the subject-local property branch on a
    // separate path. The `panelUris` predicate below is layer-
    // narrowing on top of routing (chip/query filters), so it
    // stays the same; the bug Task #19 fixed was the OR-shape in
    // the routing predicate itself.
    for (const t of rawMemory.allTriples) {
      if (t.layer !== layerTrust) continue;
      if (!admitTripleForScope(t, {
        slug, isRoot, scopedUris,
        requireResourceObject: true,
      })) continue;
      if (!(panelUris.has(t.subject) || panelUris.has(t.object))) continue;
      const key = `${t.subject}|${t.predicate}|${t.object}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ subject: t.subject, predicate: t.predicate, object: t.object, subGraph: t.subGraph });
    }
    return out;
  }, [singleLayer, rawMemory.allTriples, scopedUris, slug, isRoot, scopedEntities, chips, chipState, queryResults]);

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

  const runQuery = useCallback(async (q: {
    slug: string;
    sparql: string;
    resultColumn: string;
    name: string;
    view?: QueryExecutionView;
  }) => {
    setQueryLoading(true);
    setQueryError(null);
    setActiveQuerySlug(q.slug);
    try {
      const r = await executeQuery(q.sparql, contextGraphId, undefined, undefined, q.view);
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
