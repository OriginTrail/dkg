import React, { useId, useMemo, useState, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import { listAssertions, promoteAssertion, describePromoteError, knowledgeAssetFinalize, publishAssertionsToVm, partialPublishWarning, type ConvictionCostCovered } from '../../../api.js';
import type { MemoryEntity } from '../../../hooks/useMemoryEntities.js';
import { useProjectProfileContext } from '../../../hooks/useProjectProfile.js';
import { LAYER_CONFIG, entityMeta, layerNoun } from '../helpers.js';
import { EmptyState, StatStrip, toneForLayer } from '../../../components/ContextGraphPrimitives.js';
import { PublishEligibilityChip } from '../../../pages/conviction/PublishEligibilityChip.js';
import { usePublishEligibility } from '../../../hooks/usePublishEligibility.js';
import { DiscountAppliedBadge } from '../../../components/Pca/index.js';

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


export function LayerActionsWidget({ layer, count, contextGraphId, onComplete, onResult }: {
  layer: 'wm' | 'swm';
  count: number;
  contextGraphId: string;
  entities: MemoryEntity[];
  onComplete: () => void;
  /** Lift the latest outcome to the parent strip so it survives this widget
   * unmounting when the promoted/published layer empties (entityCount → 0). */
  onResult?: (r: { ok: boolean; text: string } | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // B8 — the CONFIRMED post-publish discount from the VM publish response's sample.
  const [costCovered, setCostCovered] = useState<ConvictionCostCovered | null>(null);
  const isWm = layer === 'wm';
  // S5/#1382 — hard-gate the SWM→VM publish CTA on a DANGER verdict: 'fallthrough-no-funds'
  // means NO signing wallet can fund the publish, so it would fail on-chain. Polls at the
  // chip's 30s cadence so the gate self-corrects once a wallet is funded. Gate ONLY this
  // terminal case — 'eligible'/'fallthrough' (has TRAC) stay enabled, and 'unknown' (probe
  // inconclusive) fails OPEN (never block on what we can't confirm, #9). The hook no-ops
  // when no PCA is tracked, so non-conviction nodes never probe or gate.
  const { verdict } = usePublishEligibility(contextGraphId, 30_000);
  const publishBlocked = !isWm && verdict === 'fallthrough-no-funds';
  // S5 — the PCA eligibility verdict the publish button is aria-describedby'd to,
  // so a screen-reader user activating Publish hears the direct-cost/fail state.
  const verdictId = useId();
  // Mirror the outcome up to the strip; it persists past this widget's unmount.
  useEffect(() => {
    if (result) onResult?.({ ok: true, text: result });
    else if (error) onResult?.({ ok: false, text: error });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, error]);

  const handleAction = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setCostCovered(null);
    // Issue #864 (Codex review on #874) — track the in-flight
    // assertion so mid-loop failures surface "<name>: …" instead of
    // the generic "an assertion …".
    let currentAssertion: string | null = null;
    try {
      if (isWm) {
        // Seal each draft before sharing — promote moves content OUT of Working
        // Memory, after which it can no longer be finalized, and a later vm/publish
        // requires a finalized assertion. The seal is CG-independent (#1116: finalize
        // works on an unregistered CG with no chain write) and promote is off-chain, so
        // no client-side CG pre-registration is needed — /vm/publish registers the CG
        // later, only after publish preconditions pass. (See OT-RFC-44 Design B.)
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
        // NOT the legacy single-root shared-memory publish. We go through the
        // shared knowledgeAssetPublishWithSeal wrapper so this CTA gets the same
        // seal-in-SWM retry + 207 partial-publish handling as the other publish
        // surfaces. No pre-register: the daemon's /vm/publish runs preconditions
        // first and only auto-registers (with the stored policy) on its
        // CG_NOT_REGISTERED retry, so a doomed publish never burns gas.
        const assertions = await listAssertions(contextGraphId, 'swm');
        // Shared batch loop (api.ts publishAssertionsToVm) — uniform partial/error
        // accounting with the other batch-publish CTAs (carries the partial detail).
        const r = await publishAssertionsToVm(contextGraphId, assertions);
        if (r.published > 0) {
          const tail = r.failures.length ? ` (${r.failures.length} assertion${r.failures.length === 1 ? '' : 's'} could not be published)` : '';
          const partialTail = r.partial > 0 ? ` — ⚠ ${r.partial}: ${partialPublishWarning(r.partialError)}` : '';
          setResult(`Published ${r.published} knowledge asset${r.published !== 1 ? 's' : ''} to Verifiable Memory${tail}${partialTail}`);
          // B8 (#1365 r3) — the CONFIRMED discount aggregated across the BATCH (not off the
          // headline sample, which is picked for cleanliness not discount). Absent → hidden.
          setCostCovered(r.convictionCostCovered ?? null);
        } else if (assertions.length === 0) {
          setResult('Nothing to publish — promote assertions to Shared Memory first.');
        } else {
          throw new Error(r.failures[0] ? `${r.failures[0].name}: ${r.failures[0].error}` : 'Publish failed');
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
      {result && <div data-testid="layer-action-result" style={{ fontSize: 11, color: 'var(--text-success)', marginBottom: 8 }}>✓ {result}</div>}
      {error && <div data-testid="layer-action-result" style={{ fontSize: 11, color: 'var(--text-danger)', marginBottom: 8 }}>✕ {error}</div>}
      {/* B8 — the CONFIRMED post-publish discount (from the on-chain CostCovered event);
          renders nothing unless this publish drew on a PCA (#9). Distinct from the S5
          predictive chip below. */}
      {!isWm && <DiscountAppliedBadge convictionCostCovered={costCovered} />}
      {/* S5 — PCA fall-through guard at the moment of spend (VM publish only). */}
      {!isWm && <PublishEligibilityChip contextGraphId={contextGraphId} id={verdictId} />}
      <div className="v10-decision-actions">
        <button
          data-testid={isWm ? 'widget-promote-all-btn' : 'widget-publish-vm-btn'}
          className={isWm ? 'v10-decision-btn approve' : 'v10-decision-btn primary-cta publish-vm'}
          style={isWm
            ? { borderColor: `${color}50`, color: 'var(--text-warning)', background: `${color}15`, opacity: busy ? 0.5 : 1 }
            : { opacity: busy || publishBlocked ? 0.5 : 1 }}
          disabled={busy || publishBlocked}
          title={publishBlocked ? 'Publish will fail — no wallet can cover the cost.' : undefined}
          aria-describedby={!isWm ? verdictId : undefined}
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
  // Latest promote/publish outcome, lifted from LayerActionsWidget so the "✓ Promoted
  // N triples" feedback survives that widget unmounting the instant the acted-on layer
  // empties (entityCount → 0) and the strip swaps to the empty state.
  const [lastAction, setLastAction] = useState<{ ok: boolean; text: string } | null>(null);
  const actionResult = lastAction && (
    <div
      data-testid="layer-action-result"
      style={{ fontSize: 11, color: lastAction.ok ? 'var(--text-success)' : 'var(--text-danger)', marginBottom: 8 }}
    >
      {lastAction.ok ? '✓' : '✕'} {lastAction.text}
    </div>
  );
  if (entityCount === 0) {
    return (
      <div className="v10-layer-widgets-strip empty">
        {actionResult}
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
          <LayerActionsWidget layer={layer} count={entityCount} entities={entities} contextGraphId={contextGraphId} onComplete={onComplete} onResult={setLastAction} />
        </div>
      )}
    </div>
  );
}
