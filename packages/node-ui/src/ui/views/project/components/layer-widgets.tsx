import React, { useId, useMemo, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { listAssertions, promoteAssertion, describePromoteError, publishAssertionsToVm, partialPublishWarning, type ConvictionCostCovered } from '../../../api.js';
import type { MemoryEntity } from '../../../hooks/useMemoryEntities.js';
import { useProjectProfileContext } from '../../../hooks/useProjectProfile.js';
import { LAYER_CONFIG, entityMeta, layerNoun } from '../helpers.js';
import { EmptyState, StatStrip, toneForLayer } from '../../../components/ContextGraphPrimitives.js';
import { useVmPublishGate } from '../../../pages/conviction/useVmPublishGate.js';
import { PublishEligibilityChipView } from '../../../pages/conviction/PublishEligibilityChip.js';
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


// ─── Shared layer-action scaffolding (promote + publish) ─────────────────────

/**
 * The busy/result/error lifecycle shared by the promote and publish CTAs — STATE only.
 * `run(body, formatError)` clears state, executes the body (which returns the success text,
 * or throws), and — in ONE place — sets result/error AND mirrors the outcome to `onResult`
 * (which the strip lifts into its own state so the "✓ Promoted N" feedback survives this
 * widget unmounting when the layer empties). `onComplete` fires on success. Error COPY is
 * owned by each caller via `formatError` (promote and publish word failures differently —
 * the runner stays generic and never leaks promote wording onto publish).
 */
function useLayerAction(
  onResult?: (r: { ok: boolean; text: string } | null) => void,
  onComplete?: () => void,
) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (body: () => Promise<string>, formatError: (err: unknown) => string) => {
      setBusy(true);
      setError(null);
      setResult(null);
      try {
        const text = await body();
        setResult(text);
        onResult?.({ ok: true, text });
        onComplete?.();
      } catch (err) {
        const text = formatError(err);
        setError(text);
        onResult?.({ ok: false, text });
      } finally {
        setBusy(false);
      }
    },
    [onResult, onComplete],
  );

  return { busy, result, error, run };
}

/** The GenWidget shell shared by the two CTAs: context line + result/error + optional
 *  extras (badge/chip/gate) + the action button(s). */
function LayerActionShell({ title, footnote, context, result, error, extras, children }: {
  title: string;
  footnote: string;
  context: ReactNode;
  result: string | null;
  error: string | null;
  extras?: ReactNode;
  children: ReactNode;
}) {
  return (
    <GenWidget title={title} footnote={footnote}>
      <div className="v10-decision-context" style={{ marginBottom: 10 }}>{context}</div>
      {result && <div data-testid="layer-action-result" style={{ fontSize: 11, color: 'var(--text-success)', marginBottom: 8 }}>✓ {result}</div>}
      {/* #1464 — errors render under a DISTINCT testid so a failed action can't be mistaken for a
          successful result by a testid-agnostic reader (the mask that hid the promote failure). */}
      {error && <div data-testid="layer-action-error" style={{ fontSize: 11, color: 'var(--text-danger)', marginBottom: 8 }}>✕ {error}</div>}
      {extras}
      <div className="v10-decision-actions">{children}</div>
    </GenWidget>
  );
}

interface LayerActionProps {
  count: number;
  contextGraphId: string;
  includeQueryCatalog?: boolean;
  onComplete?: () => void;
  /** Lift the latest outcome to the parent strip so it survives this widget
   * unmounting when the promoted/published layer empties (entityCount → 0). */
  onResult?: (r: { ok: boolean; text: string } | null) => void;
}

/** WM → SWM bulk-promote CTA. Off-chain; never touches the PCA eligibility probe. */
export function PromoteWidget({ count, contextGraphId, includeQueryCatalog = false, onComplete, onResult }: LayerActionProps) {
  const { busy, result, error, run } = useLayerAction(onResult, onComplete);
  const promote = useCallback(() => {
    // Issue #864 — track the in-flight assertion so a mid-loop failure surfaces "<name>: …"
    // via describePromoteError; shared between the body and the promote error formatter.
    let currentAssertion: string | null = null;
    void run(
      async () => {
        // The share route seals and transfers each complete KA atomically. It is
        // off-chain, so no client-side CG pre-registration is needed.
        const assertions = await listAssertions(contextGraphId, 'wm', { includeQueryCatalog });
        let noopCount = 0;
        for (const a of assertions) {
          currentAssertion = a.name;
          // PR #710 — thread `subGraph` so sub-graph-scoped assertions hit the correct
          // daemon lookup key `(cg, name, subGraph)`.
          const res = await promoteAssertion(
            contextGraphId,
            a.name,
            a.subGraph ? { subGraphName: a.subGraph } : {},
          );
          if (res.promotedCount === 0) noopCount += 1;
        }
        // Issue #864 — flag the "nothing was actually moved" case so users on the bulk-promote
        // widget aren't lied to by a "Promoted 0 triples" success toast.
        const sharedCount = assertions.length - noopCount;
        if (sharedCount > 0) {
          const tail = noopCount > 0 ? ` (${noopCount} already shared or still committing)` : '';
          return `Shared ${sharedCount} complete Knowledge Asset${sharedCount !== 1 ? 's' : ''} to Shared Memory${tail}`;
        }
        return 'No Knowledge Assets were newly shared — all were already in Shared Memory or still committing.';
      },
      (err: any) => {
        const typed = describePromoteError(currentAssertion ?? 'an assertion', err);
        return typed ? typed.message : (err?.message ?? 'Action failed');
      },
    );
  }, [contextGraphId, includeQueryCatalog, run]);

  if (count === 0) return null;
  const color = '#f59e0b';
  const noun = layerNoun('wm', count).toLowerCase();

  return (
    <LayerActionShell
      title="Share complete Knowledge Assets"
      footnote="Shares each complete owning Knowledge Asset atomically to Shared Working Memory."
      context={<>The displayed {noun} will be shared through their complete owning Knowledge Assets for collaborative review.</>}
      result={result}
      error={error}
    >
      <button
        data-testid="widget-promote-all-btn"
        className="v10-decision-btn approve"
        style={{ borderColor: `${color}50`, color: 'var(--text-warning)', background: `${color}15`, opacity: busy ? 0.5 : 1 }}
        disabled={busy}
        onClick={promote}
      >
        {busy ? '...' : '✓ Share Complete KAs → Shared'}
      </button>
    </LayerActionShell>
  );
}

/** SWM → VM publish CTA. Consumes the PCA spend-gate (`useVmPublishGate`) for the DANGER
 *  gate + the eligibility chip, and owns the confirmed post-publish discount badge (B8). */
export function PublishVmWidget({ count, contextGraphId, includeQueryCatalog = false, onComplete, onResult }: LayerActionProps) {
  const [costCovered, setCostCovered] = useState<ConvictionCostCovered | null>(null);
  const { busy, result, error, run } = useLayerAction(onResult, onComplete);
  // Pure-policy hook: gate decision + resolved eligibility. ALL presentation lives here.
  const gate = useVmPublishGate(contextGraphId);
  const verdictId = useId();
  const reasonId = useId();
  // aria-describedby references ONLY targets this component actually renders — chip (verdictId)
  // when a PCA is tracked, reason node (reasonId) when blocked — so it's atomic by construction.
  const describedBy =
    [gate.chipVisible ? verdictId : null, gate.blocked ? reasonId : null].filter(Boolean).join(' ') || undefined;

  const publish = useCallback(() => {
    // The policy gate is aria-disabled (button stays focusable/announceable), not natively
    // disabled, so the click still fires — block the action here.
    if (gate.blocked) return;
    void run(
      async () => {
        setCostCovered(null);
        // SWM -> VM: publish each shared assertion as ONE Knowledge Asset (Design B) via the
        // per-assertion vm/publish path. No pre-register: the daemon runs preconditions first
        // and only auto-registers on its CG_NOT_REGISTERED retry, so a doomed publish never
        // burns gas.
        const assertions = await listAssertions(contextGraphId, 'swm', { includeQueryCatalog });
        // Shared batch loop (api.ts publishAssertionsToVm) — uniform partial/error accounting.
        const r = await publishAssertionsToVm(contextGraphId, assertions);
        if (r.published > 0) {
          const tail = r.failures.length ? ` (${r.failures.length} assertion${r.failures.length === 1 ? '' : 's'} could not be published)` : '';
          const partialTail = r.partial > 0 ? ` — ⚠ ${r.partial}: ${partialPublishWarning(r.partialError)}` : '';
          // B8 (#1365 r3) — the CONFIRMED discount aggregated across the BATCH. Absent → hidden.
          setCostCovered(r.convictionCostCovered ?? null);
          return `Published ${r.published} knowledge asset${r.published !== 1 ? 's' : ''} to Verifiable Memory${tail}${partialTail}`;
        }
        if (assertions.length === 0) return 'Nothing to publish — promote assertions to Shared Memory first.';
        throw new Error(r.failures[0] ? `${r.failures[0].name}: ${r.failures[0].error}` : 'Publish failed');
      },
      // Publish-appropriate: the raw message (matches the old catch, which fell through
      // describePromoteError → null for publish errors). Never says "an assertion".
      (err: any) => err?.message ?? 'Action failed',
    );
  }, [contextGraphId, includeQueryCatalog, run, gate.blocked]);

  if (count === 0) return null;
  const noun = layerNoun('swm', count).toLowerCase();

  return (
    <LayerActionShell
      title="Publish"
      footnote={`Moves ${noun} from this layer to Verifiable Memory.`}
      context={<>{count} {noun} in this layer can be published to Verifiable Memory on-chain.</>}
      result={result}
      error={error}
      extras={
        <>
          {/* B8 — the CONFIRMED post-publish discount (from the on-chain CostCovered event);
              renders nothing unless this publish drew on a PCA (#9). Distinct from the S5
              predictive chip. */}
          <DiscountAppliedBadge convictionCostCovered={costCovered} />
          {/* S5 — the PCA fall-through chip, fed STRAIGHT from the gate's single eligibility
              read (no prop re-listing). id=verdictId so the button can reference it. Shown
              only when a PCA is tracked. */}
          {gate.chipVisible && <PublishEligibilityChipView {...gate.eligibility} id={verdictId} />}
          {/* SR-only cause for the policy gate — referenced by aria-describedby so the
              announced reason matches the visual state. */}
          {gate.blocked && <span id={reasonId} className="v10-sr-only">{gate.reason}</span>}
        </>
      }
    >
      <button
        data-testid="widget-publish-vm-btn"
        className="v10-decision-btn primary-cta publish-vm"
        style={{ opacity: busy || gate.blocked ? 0.5 : 1 }}
        // Native `disabled` only for the TRANSIENT busy state; the PERSISTENT policy gate uses
        // aria-disabled so SR/keyboard users keep focus + hear the reason (publish no-ops when
        // blocked). aria-describedby references only rendered targets (describedBy, above).
        disabled={busy}
        aria-disabled={gate.blocked || undefined}
        title={gate.blocked ? gate.reason : undefined}
        aria-describedby={describedBy}
        onClick={publish}
      >
        {busy ? '...' : '◉ Publish to Verifiable Memory'}
      </button>
    </LayerActionShell>
  );
}

// ─── Horizontal widget strip (stats + types + CTA) for the Entities tab ──

export function LayerWidgetStrip({ layer, entities, entityCount, tripleCount, contextGraphId, includeQueryCatalog = false, onComplete }: {
  layer: 'wm' | 'swm' | 'vm';
  entities: MemoryEntity[];
  entityCount: number;
  tripleCount: number;
  contextGraphId?: string;
  includeQueryCatalog?: boolean;
  onComplete?: () => void;
}) {
  // Latest promote/publish outcome, lifted from the action widget so the "✓ Promoted
  // N triples" feedback survives that widget unmounting the instant the acted-on layer
  // empties (entityCount → 0) and the strip swaps to the empty state.
  const [lastAction, setLastAction] = useState<{ ok: boolean; text: string } | null>(null);
  const actionResult = lastAction && (
    <div
      // #1464 — success vs failure must not collide on one testid (see LayerActionShell).
      data-testid={lastAction.ok ? 'layer-action-result' : 'layer-action-error'}
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
                ? 'Seal and share complete Knowledge Assets from Working Memory with the team.'
                : 'Publish complete Knowledge Assets from Shared Working Memory to verify them on-chain.'
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
      {(layer === 'wm' || layer === 'swm') && contextGraphId && (
        <div className="v10-layer-widgets-strip-action">
          {layer === 'wm'
            ? <PromoteWidget count={entityCount} contextGraphId={contextGraphId} includeQueryCatalog={includeQueryCatalog} onComplete={onComplete} onResult={setLastAction} />
            : <PublishVmWidget count={entityCount} contextGraphId={contextGraphId} includeQueryCatalog={includeQueryCatalog} onComplete={onComplete} onResult={setLastAction} />}
        </div>
      )}
    </div>
  );
}
