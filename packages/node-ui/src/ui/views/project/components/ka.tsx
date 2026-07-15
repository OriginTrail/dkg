import React, { useMemo, useState, Suspense } from 'react';
import { api } from '../../../api-wrapper.js';
import { promoteAssertion, describePromoteResult, describePromoteError, knowledgeAssetPublishWithSeal, partialPublishWarning, PARTIAL_PUBLISH_STATUS_SUFFIX, type PromoteOutcome, type PublishResult } from '../../../api.js';
import { useMemoryEntities, canonicalEntityUri, isFirstClassEntity, type MemoryEntity, type Triple } from '../../../hooks/useMemoryEntities.js';
import { decodeRdfStringLiteral } from '../../../../rdf-literal.js';
import { useProjectProfileContext } from '../../../hooks/useProjectProfile.js';
import { useAgentsContext, type AgentSummary } from '../../../hooks/useAgents.js';
import { AgentChip } from '../../../components/AgentChip.js';
import { VerifiedIdentityBanner } from '../../../components/VerifiedIdentityBanner.js';
import { GenUIEntityPanel } from '../../../genui/index.js';
import { memoryGraphLabels } from '../../../lib/memoryLabels.js';
import { useLayoutStore } from '../../../stores/layout.js';
import { TRUST_COLORS, entityAuthorUri, transitionAgentUri, transitionAtISO, shortPred, entityMeta, getDescription, neighborhoodTriples, neutraliseBuiltinNamespaces, layerNoun, filterTriplesToEntities, formatTrailTimestamp, type KAPane } from '../helpers.js';
import { GraphSurface, RdfGraph } from './graph.js';

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
//   WM  -> SWM  : promoteAssertion(sourceAssertion)                ("Propose…")
//   SWM -> VM   : knowledgeAssetPublishWithSeal(sourceAssertion)   ("Ratify…")
// The SWM→VM step publishes the entity's owning NAMED assertion as one
// Knowledge Asset via the canonical per-KA /vm/publish (named-only, #1087).
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
  // Codex review on #874 / #898 round 2 — promote results now flow
  // through `describePromoteResult` so a `promotedCount === 0`
  // response surfaces the same actionable hint the WMAssertionsPane
  // shows ("had no triples to promote …"), and `ASSERTION_NOT_PERSISTED`
  // surfaces the typed describePromoteError message instead of the
  // raw "409 …" backend string. The promote branch stores a
  // `PromoteOutcome`; the publish branch stores a `PublishResult`.
  const [result, setResult] = useState<PublishResult | PromoteOutcome | null>(null);
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
        hint:     binding.promoteHint  ?? 'Shares the complete owning Knowledge Asset with the team.',
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
        // Named-only publish (#1087): /vm/publish is keyed by a named SWM
        // assertion. We publish the entity's owning assertion (its
        // `sourceAssertion`); an entity with no named source assertion (e.g. a
        // loose root written straight to SWM) is not publishable from here.
        disabled: !sgBinding?.binding.sourceAssertion,
        disabledReason: !sgBinding?.binding.sourceAssertion
          ? 'This entity is not part of a named Shared-Memory asset, so it cannot be published to Verifiable Memory from here.'
          : null,
      };

  const handle = async () => {
    if (action.disabled) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setResultKind(action.kind);
    const assertionName = sgBinding?.binding.sourceAssertion ?? 'assertion';
    try {
      if (action.kind === 'promote') {
        // Share the entity's complete owning Knowledge Asset. The sub-graph
        // slug is part of the daemon lookup key, so it must travel with the
        // source assertion; root-entity subset selection is intentionally gone.
        const r = await promoteAssertion(
          contextGraphId,
          sgBinding!.binding.sourceAssertion!,
          sgBinding!.subGraph ? { subGraphName: sgBinding!.subGraph } : {},
        );
        // Issue #864 — fan the promote response through the central
        // describe helper so 0-count returns get an actionable hint
        // instead of the misleading "Promoted 0 triples" toast.
        setResult(describePromoteResult(assertionName, r));
      } else {
        // Named-only publish (#1087): publish the entity's owning SWM assertion
        // as one Knowledge Asset via the canonical per-KA /vm/publish. We do
        // NOT pre-register the CG: the daemon checks local preconditions first and only
        // auto-registers (with the stored publish policy) on its
        // `CG_NOT_REGISTERED` retry path, so a doomed publish never burns gas.
        // The CTA is disabled above when no sourceAssertion resolves, so
        // `sgBinding.sourceAssertion` is present here.
        const r = await knowledgeAssetPublishWithSeal(
          contextGraphId,
          sgBinding!.binding.sourceAssertion!,
          sgBinding!.subGraph ? { subGraphName: sgBinding!.subGraph } : {},
        );
        setResult(r as unknown as PublishResult);
      }
      onVerified();
    } catch (err: any) {
      // Issue #864 — `ASSERTION_NOT_PERSISTED` (HTTP 409) gets a
      // typed message that points the user at the re-import path
      // instead of the raw backend error string.
      const typed = action.kind === 'promote' ? describePromoteError(assertionName, err) : null;
      const message = typed ? typed.message : (err?.message ?? 'Action failed');
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const isPublishResult = (r: typeof result): r is PublishResult => !!r && 'status' in r;
  const isPromoteOutcome = (r: typeof result): r is PromoteOutcome => !!r && 'kind' in r;

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
      {result && resultKind === 'promote' && isPromoteOutcome(result) && result.kind === 'success' && (
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
      {result && resultKind === 'promote' && isPromoteOutcome(result) && result.kind !== 'success' && (
        // 0-count or not-persisted — surface the typed message as a
        // warning, not a faux success. Mirrors the WMAssertionsPane's
        // describePromoteResult/describePromoteError handling so the
        // entity-level CTA stops misreporting empty promotes as "✓".
        <div className="v10-ka-verify-err">! {result.message}</div>
      )}
      {result && resultKind === 'publish' && isPublishResult(result) && (() => {
        // OT-RFC-38 §1.1 — a publish without a TX hash never made it to chain.
        // Treat that as failure, not success, so the curator knows the data
        // is NOT in Verifiable Memory.
        const confirmed = result.status === 'confirmed' && !!result.txHash;
        // PR #972 — a daemon 207 partial publish: the KA minted on-chain but the
        // context-graph binding failed. Confirmed on-chain, but NOT a clean
        // success. Re-publishing does NOT repair the binding (the KA is already
        // minted), so we render a warning with the shared, accurate copy.
        const partial = confirmed && !!result.contextGraphError;
        return (
          <div className={!confirmed ? 'v10-ka-verify-err' : partial ? 'v10-ka-verify-warn' : 'v10-ka-verify-ok'}>
            <div className="v10-ka-verify-ok-row">
              <span className="v10-ka-verify-ok-lbl">Status</span>
              <span className="v10-ka-verify-ok-val">
                {!confirmed ? '✕' : partial ? '⚠' : '✓'} {result.status}{!confirmed ? ' (NOT on-chain)' : partial ? ` (${PARTIAL_PUBLISH_STATUS_SUFFIX})` : ''}
              </span>
            </div>
            {partial && (
              <div className="v10-ka-verify-hint" style={{ marginTop: 6 }}>
                {partialPublishWarning(result.contextGraphError)}
              </div>
            )}
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
                      <td title={t.object}>{t.object.startsWith('"') ? decodeRdfStringLiteral(t.object).slice(0, 60) : shortPred(t.object)}</td>
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
