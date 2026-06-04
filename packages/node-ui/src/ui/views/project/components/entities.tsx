import React, { useMemo, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { useFetch } from '../../../hooks.js';
import { encodeDocTabId, resolveDocRef } from '../../../lib/doc-tab-id.js';
import { truncateMiddle } from '../../../lib/truncate.js';
import { listAssertions, promoteAssertion, describePromoteResult, describePromoteError, ensureContextGraphOnChain, knowledgeAssetFinalize, knowledgeAssetPublish, fetchAssertionUals, type AssertionInfo } from '../../../api.js';
import { useMemoryEntities, type TrustLevel, type MemoryEntity, type Triple } from '../../../hooks/useMemoryEntities.js';
import { useProjectProfileContext } from '../../../hooks/useProjectProfile.js';
import { useAgentsContext } from '../../../hooks/useAgents.js';
import { AgentChip } from '../../../components/AgentChip.js';
import { useTabsStore } from '../../../stores/tabs.js';
import type { SwmAttributionsResult } from '../../../hooks/useSwmAttributions.js';
import { LAYER_CONFIG, SOURCE_CONTENT_TYPE, MARKDOWN_FORM, SOURCE_FILE, DKG_SIZE, entityAuthorUri, entityMeta, layerNoun, useLayerTriples, entityTimestamp, formatRelativeTime, type LayerContentTab } from '../helpers.js';
import { EmptyState, StatStrip, toneForLayer } from '../../../components/ContextGraphPrimitives.js';
import { LayerGraphPanel } from './graph.js';
import { LayerWidgetStrip } from './layer-widgets.js';

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
  // Deterministic Option-1 UAL per assertion (dkg:reservedUal), shown next to
  // the filename. Refreshes alongside the list.
  const { data: ualMap } = useFetch(
    () => fetchAssertionUals(contextGraphId),
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
      // VM is the on-chain layer; finalize/publish need the CG registered, so
      // auto-register transparently first.
      await ensureContextGraphOnChain(contextGraphId);
      if (layer === 'wm') {
        // Seal the draft before sharing — promote moves content out of WM and a
        // later vm/publish requires a finalized assertion, so finalize must run
        // here. Tolerate already-sealed / nothing-to-seal.
        try {
          await knowledgeAssetFinalize(contextGraphId, assertion.name, assertion.subGraph ? { subGraphName: assertion.subGraph } : {});
        } catch (e: any) {
          const m = String(e?.message ?? '');
          if (!/already|finaliz|sealed|promoted|no quads|reserved/i.test(m)) throw e;
        }
        // PR #710 Fix A — sub-graph slug threads into the daemon's
        // `(cg, name, subGraph)` lookup so a row clicked from a
        // sub-graph partition resolves to that partition's
        // assertion, not a same-named root one.
        const res = await promoteAssertion(contextGraphId, assertion.name, 'all', assertion.subGraph);
        // Issue #864 — fan the promote response through the central
        // describe helper so 0-count returns get an actionable hint
        // instead of the misleading "Promoted 0 triples" toast.
        const outcome = describePromoteResult(assertion.name, res);
        setResult(outcome.message);
      } else {
        // Publish THIS assertion as one Knowledge Asset (Design B, any entity
        // count) via per-assertion vm/publish — NOT the legacy single-root
        // shared-memory publish (which also wrongly published every SWM root).
        await knowledgeAssetPublish(contextGraphId, assertion.name, assertion.subGraph ? { subGraphName: assertion.subGraph } : {});
        setResult(`Published ${assertion.name} to Verifiable Memory`);
      }
      refresh();
      onComplete();
    } catch (err: any) {
      const typed = describePromoteError(assertion.name, err);
      setError(typed ? typed.message : (err?.message ?? 'Action failed'));
    } finally {
      setBusy(null);
    }
  }, [contextGraphId, layer, refresh, onComplete]);

  const handlePromoteAll = useCallback(async () => {
    if (!assertions?.length) return;
    setBusy('__all__');
    setResult(null);
    setError(null);
    // Issue #864 (Codex review on #874) — track the in-flight
    // assertion so mid-loop failures surface "<name>: …" instead of
    // "selected assertion …".
    let currentAssertion: string | null = null;
    try {
      await ensureContextGraphOnChain(contextGraphId);
      if (layer === 'wm') {
        let total = 0;
        let noopCount = 0;
        for (const a of assertions) {
          currentAssertion = a.name;
          try {
            await knowledgeAssetFinalize(contextGraphId, a.name, a.subGraph ? { subGraphName: a.subGraph } : {});
          } catch (e: any) {
            const m = String(e?.message ?? '');
            if (!/already|finaliz|sealed|promoted|no quads|reserved/i.test(m)) throw e;
          }
          // PR #710 — see comment on the single-row handler above.
          const res = await promoteAssertion(contextGraphId, a.name, 'all', a.subGraph);
          total += res.promotedCount;
          if (res.promotedCount === 0) noopCount += 1;
        }
        // Issue #864 — distinguish "some moved, some no-ops" from
        // "literally nothing moved" so the user gets the truth.
        if (total > 0) {
          const tail = noopCount > 0 ? ` (${noopCount} had nothing to promote)` : '';
          setResult(`Promoted ${total} triples across ${assertions.length} assertion${assertions.length !== 1 ? 's' : ''}${tail}`);
        } else {
          setResult('No triples were promoted — every assertion was already in Shared Memory or its content is still being committed.');
        }
      } else {
        // Publish each shared assertion as its own Knowledge Asset (Design B).
        let published = 0;
        let lastErr: string | null = null;
        for (const a of assertions) {
          currentAssertion = a.name;
          try {
            await knowledgeAssetPublish(contextGraphId, a.name, a.subGraph ? { subGraphName: a.subGraph } : {});
            published += 1;
          } catch (e: any) {
            lastErr = e?.message ?? 'publish failed';
          }
        }
        if (published > 0) {
          const tail = lastErr ? ' (some could not be published)' : '';
          setResult(`Published ${published} knowledge asset${published !== 1 ? 's' : ''} to Verifiable Memory${tail}`);
        } else {
          throw new Error(lastErr ?? 'Publish failed');
        }
      }
      refresh();
      onComplete();
    } catch (err: any) {
      const typed = describePromoteError(currentAssertion ?? 'selected assertion', err);
      setError(typed ? typed.message : (err?.message ?? 'Action failed'));
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
            {ualMap?.[a.name] && (
              <div
                className="v10-item-ual"
                style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-tertiary)', opacity: 0.7, wordBreak: 'break-all', marginTop: 1 }}
                title={ualMap[a.name]}
              >
                {ualMap[a.name]}
              </div>
            )}
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
