import React, { useState, useCallback } from 'react';
import { useFetch } from '../../../hooks.js';
import { LayerGlyph } from '../../../components/ds/Badge.js';
import { listAssertionsPage, fetchAssertionPageCounts } from '../../../assertions-page.js';
import {
  invalidateQueryCache, listAssertions, promoteAssertion, describePromoteResult,
  describePromoteError, knowledgeAssetPublish, publishAssertionsToVm,
  partialPublishWarning, type AssertionInfo,
} from '../../../api.js';
import { useMemoryGraphEvents } from '../../../hooks/useNodeEvents.js';
import { truncateMiddle } from '../../../lib/truncate.js';
import { EmptyState, toneForLayer } from '../../../components/ContextGraphPrimitives.js';
import { FileText, RefreshCw } from 'lucide-react';
import { StatusGlyph } from '../../../components/ds/Badge.js';
import { failed, outcomeColor, succeeded, succeededWithWarning, type ActionOutcome } from '../../../lib/actionOutcome.js';
import { publishOutcome } from '../../../lib/publishOutcome.js';

export function AssertionsList({ contextGraphId, layer, includeQueryCatalog = false, onComplete, scrollKey }: {
  contextGraphId: string;
  layer: 'wm' | 'swm';
  includeQueryCatalog?: boolean;
  onComplete: () => void;
  scrollKey?: string;
}) {
  const scope = JSON.stringify([contextGraphId, layer, includeQueryCatalog]);
  const [paging, setPaging] = useState<{ scope: string; cursors: Array<string | undefined>; index: number }>({ scope, cursors: [undefined], index: 0 });
  const cursors = paging.scope === scope ? paging.cursors : [undefined];
  const pageIndex = paging.scope === scope ? paging.index : 0;
  const cursor = cursors[pageIndex];
  const { data: page, loading, error: loadError, refresh: loadPage } = useFetch(
    () => listAssertionsPage(contextGraphId, layer, { includeQueryCatalog, cursor, includeCounts: false }),
    [contextGraphId, layer, includeQueryCatalog, cursor],
    0, { scope: JSON.stringify([scope, cursor]), retention: 'scope' },
  );
  const assertions = page?.items ?? [];
  const countKey = JSON.stringify([scope, assertions.map(item => item.graphUri)]);
  const pageCounts = useFetch<Record<string, number>>(() => layer === 'wm' ? fetchAssertionPageCounts(contextGraphId, assertions) : Promise.resolve({}),
    [countKey, page], 0, { scope: countKey, retention: 'scope' });
  const counts = pageCounts.data ?? {};
  const refresh = useCallback(() => { invalidateQueryCache(contextGraphId); loadPage(); }, [contextGraphId, loadPage]);
  useMemoryGraphEvents(contextGraphId, loadPage, { layers: [layer] });
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);

  const handlePromote = useCallback(async (assertion: AssertionInfo) => {
    // PR #710 Fix D — busy / React keys must use `graphUri`, not
    // `name`. A root + sub-graph pair can share a name and would
    // otherwise both highlight as busy on a single click. `graphUri`
    // is produced by the daemon and uniquely identifies the row.
    setBusy(assertion.graphUri);
    setOutcome(null);
    try {
      // No client-side CG pre-registration: atomic WM→SWM sharing is off-chain,
      // and /vm/publish owns register-then-mint (it registers ONLY after
      // publish preconditions pass, so a doomed publish never burns registration gas).
      if (layer === 'wm') {
        // The share route seals and transfers the complete KA atomically.
        // PR #710 Fix A — sub-graph slug threads into the daemon's
        // `(cg, name, subGraph)` lookup so a row clicked from a
        // sub-graph partition resolves to that partition's
        // assertion, not a same-named root one.
        const res = await promoteAssertion(
          contextGraphId,
          assertion.name,
          assertion.subGraph ? { subGraphName: assertion.subGraph } : {},
        );
        // Issue #864 — fan the promote response through the central
        // describe helper so 0-count returns get an actionable hint
        // instead of the misleading "Promoted 0 triples" toast.
        setOutcome(succeeded(describePromoteResult(assertion.name, res).message));
      } else {
        // Publish THIS assertion as one Knowledge Asset (Design B, any entity
        // count) via the direct canonical publish API, preserving 207 partial handling.
        const res = await knowledgeAssetPublish(contextGraphId, assertion.name, assertion.subGraph ? { subGraphName: assertion.subGraph } : {});
        setOutcome(succeededWithWarning(
          res.contextGraphError
            ? `Published ${assertion.name} on-chain — ${partialPublishWarning(res.contextGraphError)}`
            : `Published ${assertion.name} to Verifiable Memory`,
          Boolean(res.contextGraphError),
        ));
      }
      refresh();
      onComplete();
    } catch (err: any) {
      const typed = describePromoteError(assertion.name, err);
      setOutcome(failed(typed ? typed.message : (err?.message ?? 'Action failed')));
    } finally {
      setBusy(null);
    }
  }, [contextGraphId, layer, refresh, onComplete]);

  const handlePromoteAll = useCallback(async () => {
    setBusy('__all__');
    setOutcome(null);
    // Issue #864 (Codex review on #874) — track the in-flight
    // assertion so mid-loop failures surface "<name>: …" instead of
    // "selected assertion …".
    let currentAssertion: string | null = null;
    try {
      // Bulk scope is intentionally independent from the display list. When
      // query-catalog visibility is enabled, catalog assertions remain
      // explicit row actions and are not silently admitted to this batch.
      const bulkAssertions = await listAssertions(contextGraphId, layer, { includeCounts: false });
      if (bulkAssertions.length === 0) {
        setOutcome(succeeded(layer === 'wm'
          ? 'No user Knowledge Assets are ready to share.'
          : 'No user Knowledge Assets are ready to publish.'));
        return;
      }
      // No client-side CG pre-registration (see handleAction): atomic sharing is
      // off-chain, and /vm/publish registers-then-
      // mints only after preconditions pass.
      if (layer === 'wm') {
        let noopCount = 0;
        for (const a of bulkAssertions) {
          currentAssertion = a.name;
          // PR #710 — see comment on the single-row handler above.
          const res = await promoteAssertion(
            contextGraphId,
            a.name,
            a.subGraph ? { subGraphName: a.subGraph } : {},
          );
          if (res.promotedCount === 0) noopCount += 1;
        }
        // Issue #864 — distinguish "some moved, some no-ops" from
        // "literally nothing moved" so the user gets the truth.
        const sharedCount = bulkAssertions.length - noopCount;
        if (sharedCount > 0) {
          const tail = noopCount > 0 ? ` (${noopCount} already shared or still committing)` : '';
          setOutcome(succeeded(`Shared ${sharedCount} complete Knowledge Asset${sharedCount !== 1 ? 's' : ''}${tail}`));
        } else {
          setOutcome(succeeded('No Knowledge Assets were newly shared — all were already in Shared Memory or still committing.'));
        }
      } else {
        // Publish each shared assertion as its own Knowledge Asset (Design B) via the
        // shared batch loop (api.ts publishAssertionsToVm) — fail-closed direct publish + 207 partial
        // handling, uniform with the other batch-publish CTAs (carries the partial detail).
        const r = await publishAssertionsToVm(contextGraphId, bulkAssertions);
        setOutcome(publishOutcome(r));
      }
      refresh();
      onComplete();
    } catch (err: any) {
      const typed = describePromoteError(currentAssertion ?? 'selected assertion', err);
      setOutcome(failed(typed ? typed.message : (err?.message ?? 'Action failed')));
    } finally {
      setBusy(null);
    }
  }, [contextGraphId, layer, refresh, onComplete]);

  const scrollRootStyle = { flex: 1, overflow: 'auto' } as const;

  if (loading) {
    return (
      <div className="v10-layer-empty-shell" style={scrollRootStyle} data-cg-scroll-key={scrollKey}>
        <EmptyState
          busy
          compact
          tone={toneForLayer(layer)}
          title="Loading assertions…"
        />
      </div>
    );
  }

  if (loadError) return <div role="alert" style={scrollRootStyle}>Could not load assertions: {loadError} <button onClick={refresh}><RefreshCw size={12} />Retry</button></div>;

  if (!assertions.length && !page?.nextCursor && pageIndex === 0) {
    return (
      <div className="v10-layer-empty-shell" style={scrollRootStyle} data-cg-scroll-key={scrollKey}>
        <EmptyState
          tone={toneForLayer(layer)}
          icon={<LayerGlyph layer={layer} />}
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

  const actionLabel = layer === 'wm' ? 'Share complete Knowledge Asset' : 'Publish to Verifiable Memory';
  const actionAllLabel = layer === 'wm' ? 'Share all complete Knowledge Assets' : 'Publish all to Verifiable Memory';
  const bulkVisibleAssertionCount = assertions.filter(
    assertion => assertion.subGraph !== 'meta' || !assertion.name.startsWith('query-catalog-'),
  ).length;

  return (
    <div style={scrollRootStyle} data-cg-scroll-key={scrollKey}>
      <div style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ fontSize: 'var(--fs-label)', color: 'var(--text-tertiary)' }}>Page {pageIndex + 1} · {assertions.length} assertion{assertions.length !== 1 ? 's' : ''}</span>
        {bulkVisibleAssertionCount > 0 && (
          <button
            className={`v10-layer-expand-footer-btn ds-btn ds-sm ${layer === 'wm' ? 'promote ds-swm' : 'publish ds-vm'}`}
            title="Applies to all assertions in this layer across every page. Query catalog assertions are excluded."
            disabled={busy !== null}
            onClick={handlePromoteAll}
            style={{ opacity: busy === '__all__' ? 0.5 : 1 }}
          >
            {busy === '__all__' ? '...' : actionAllLabel}
          </button>
        )}
      </div>
      {outcome && (
        <div
          data-testid={layer === 'wm' ? 'assertion-promote-result' : 'assertion-publish-result'}
          data-tone={outcome.tone}
          style={{ padding: '6px 16px', fontSize: 'var(--fs-label)', color: outcomeColor(outcome.tone) }}
        >
          <StatusGlyph tone={outcome.tone} /> {outcome.text}
        </div>
      )}
      {assertions.map(a => (
        <div key={a.graphUri} className="v10-item-row" data-testid="assertion-list-row">
          <span className="v10-item-icon"><FileText size={14} /></span>
          <div className="v10-item-info">
            <div className="v10-item-name" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-label)' }}>{a.name}</div>
            {a.reservedUal && (
              <div
                className="v10-item-ual"
                style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-micro)', color: 'var(--text-tertiary)', opacity: 0.7, wordBreak: 'break-all', marginTop: 1 }}
                title={a.reservedUal}
              >
                {a.reservedUal}
              </div>
            )}
            <div className="v10-item-meta-row">
              {(a.tripleCount ?? counts[a.graphUri]) != null && <span className="v10-item-count">{a.tripleCount ?? counts[a.graphUri]} triples</span>}
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
            data-testid="assertion-row-action"
            className={`v10-layer-expand-footer-btn ds-btn ds-sm ${layer === 'wm' ? 'promote ds-swm' : 'publish ds-vm'}`}
            disabled={busy !== null}
            onClick={ev => { ev.stopPropagation(); handlePromote(a); }}
            style={{ opacity: busy === a.graphUri ? 0.5 : 1, flexShrink: 0 }}
          >
            {busy === a.graphUri ? '...' : actionLabel}
          </button>
        </div>
      ))}
      <nav aria-label="Assertion pages" style={{ display: 'flex', gap: 12, padding: 16 }}>
        <button disabled={pageIndex === 0 || busy !== null} onClick={() => setPaging({ scope, cursors, index: pageIndex - 1 })}>Previous assertions</button>
        <button disabled={!page?.nextCursor || busy !== null} onClick={() => {
          setPaging({ scope, cursors: [...cursors.slice(0, pageIndex + 1), page!.nextCursor], index: pageIndex + 1 });
        }}>Next assertions</button>
        <button disabled={busy !== null} onClick={refresh}><RefreshCw size={12} />Refresh assertions</button>
      </nav>
    </div>
  );
}

// ─── Full Layer Detail View (WM / SWM / VM) ─────────────────
