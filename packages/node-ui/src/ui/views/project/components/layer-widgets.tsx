import React, { useMemo, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { listAssertions, promoteAssertion, describePromoteError, ensureContextGraphOnChain, knowledgeAssetFinalize, knowledgeAssetPublish } from '../../../api.js';
import type { MemoryEntity } from '../../../hooks/useMemoryEntities.js';
import { useProjectProfileContext } from '../../../hooks/useProjectProfile.js';
import { LAYER_CONFIG, entityMeta, layerNoun } from '../helpers.js';
import { EmptyState, StatStrip, toneForLayer } from '../../../components/ContextGraphPrimitives.js';

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
  entities: MemoryEntity[];
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
    // Issue #864 (Codex review on #874) — track the in-flight
    // assertion so mid-loop failures surface "<name>: …" instead of
    // the generic "an assertion …".
    let currentAssertion: string | null = null;
    try {
      if (isWm) {
        // Verifiable Memory is the on-chain layer and `finalize` (the seal that
        // a later VM publish requires) needs the CG registered on-chain. Promote
        // moves content OUT of Working Memory, after which it can no longer be
        // finalized — so we auto-register + finalize HERE, before sharing, so the
        // shared assertions are publishable to VM later. (See OT-RFC-44 Design B.)
        await ensureContextGraphOnChain(contextGraphId);
        const assertions = await listAssertions(contextGraphId, 'wm');
        let promoted = 0;
        let noopCount = 0;
        for (const a of assertions) {
          currentAssertion = a.name;
          // Seal the draft first; tolerate already-sealed / nothing-to-seal so
          // re-runs and empty drafts don't abort the batch (surface real errors).
          try {
            await knowledgeAssetFinalize(contextGraphId, a.name, a.subGraph ? { subGraphName: a.subGraph } : {});
          } catch (e: any) {
            const m = String(e?.message ?? '');
            if (!/already|finaliz|sealed|promoted|no quads|reserved/i.test(m)) throw e;
          }
          // PR #710 — thread `subGraph` so sub-graph-scoped assertions
          // hit the correct daemon lookup key `(cg, name, subGraph)`.
          const res = await promoteAssertion(contextGraphId, a.name, 'all', a.subGraph);
          promoted += res.promotedCount;
          if (res.promotedCount === 0) noopCount += 1;
        }
        // Issue #864 — flag the "nothing was actually moved" case so
        // users on the bulk-promote widget aren't lied to by a
        // "Promoted 0 triples" success toast.
        if (promoted > 0) {
          const tail = noopCount > 0 ? ` (${noopCount} had nothing to promote)` : '';
          setResult(`Promoted ${promoted} triple${promoted !== 1 ? 's' : ''} to Shared Memory${tail}`);
        } else {
          setResult('No triples were promoted — every assertion was already in Shared Memory or its content is still being committed.');
        }
      } else {
        // SWM -> VM: publish each shared assertion as ONE Knowledge Asset
        // (Design B, any entity count) via the per-assertion vm/publish path —
        // NOT the legacy single-root shared-memory publish. Auto-register first
        // since VM is the on-chain layer.
        await ensureContextGraphOnChain(contextGraphId);
        const assertions = await listAssertions(contextGraphId, 'swm');
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
          const tail = lastErr ? ' (some assertions could not be published)' : '';
          setResult(`Published ${published} knowledge asset${published !== 1 ? 's' : ''} to Verifiable Memory${tail}`);
        } else if (assertions.length === 0) {
          setResult('Nothing to publish — promote assertions to Shared Memory first.');
        } else {
          throw new Error(lastErr ?? 'Publish failed');
        }
      }
      onComplete?.();
    } catch (err: any) {
      const typed = describePromoteError(currentAssertion ?? 'an assertion', err);
      setError(typed ? typed.message : (err?.message ?? 'Action failed'));
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
          <LayerActionsWidget layer={layer} count={entityCount} entities={entities} contextGraphId={contextGraphId} onComplete={onComplete} />
        </div>
      )}
    </div>
  );
}
