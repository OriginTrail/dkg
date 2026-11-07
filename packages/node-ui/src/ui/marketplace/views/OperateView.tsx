// Operate (seller): the ask editor (takes effect next cycle), subscribers,
// the statement queue, the dedicated revenue wallet shown apart from the
// operations wallet, and the calibration export. An unconfigured seller role
// is an explicit card. Queueing an ask and exporting do nothing yet: fixture
// data in this step.
import React, { useEffect, useRef, useState } from 'react';
import { copy } from '../copy.generated.js';
import { marketplaceData, noAction } from '../data.js';
import type { OperateStatus } from '../types.js';
import { ErrorCard, fmtClock, shortAddr } from '../purchase/shared.js';

export function OperateView(): React.ReactElement {
  const [st, setSt] = useState<OperateStatus | null>(null);
  const [err, setErr] = useState<unknown | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [askErr, setAskErr] = useState<{ id: string; err: unknown } | null>(null);
  const [exportErr, setExportErr] = useState<unknown | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [opsWallet, setOpsWallet] = useState<string | null>(null);
  const inflight = useRef(false);

  const load = () => {
    if (inflight.current) return;
    inflight.current = true;
    marketplaceData.operateStatus().then((s) => { setSt(s); setErr(null); }).catch((e) => setErr(e)).finally(() => { inflight.current = false; });
  };
  useEffect(() => { load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { marketplaceData.operationsWallet().then(setOpsWallet).catch(() => setOpsWallet(null)); }, []);

  const cycle = st?.cycle ?? null;

  // Queueing an ask and exporting calibration data need the node; no-ops here.
  const submitAsk = (offeringId: string, unit: 'tokens' | 'query-units') => {
    const v = Number(edits[offeringId]);
    if (!(v > 0) || cycle == null || busy) return;
    noAction({ offeringId, unit, askMicroPerUnit: v, effectiveFromCycle: cycle + 1 });
  };
  const exportCalibration = () => { if (!busy) noAction(); };
  void setAskErr; void setExportErr; void setBusy;

  if (err && !st) {
    return (
      <div className="mkt-frame" data-testid="mkt-operate" data-state="error">
        <div className="mkt-card"><div data-copy="operate.error">{copy('operate.error')}</div><ErrorCard err={err} onRetry={load} /></div>
      </div>
    );
  }
  if (!st) return <div className="mkt-frame" data-testid="mkt-operate" data-state="loading"><div className="mkt-card mkt-muted" data-copy="state.loading">{copy('state.loading')}</div></div>;

  if (!st.sellerActive) {
    return (
      <div className="mkt-frame" data-testid="mkt-operate" data-state="inactive">
        <div className="mkt-card mkt-seatcard" data-testid="mkt-operate-inactive">
          <h2 data-copy="operate.inactive.title">{copy('operate.inactive.title')}</h2>
          <p className="mkt-sec mkt-sm" data-copy="operate.inactive.body">{copy('operate.inactive.body')}</p>
          <ul className="mkt-xs mkt-sec">
            <li data-copy="operate.inactive.item.provider">{copy('operate.inactive.item.provider')}</li>
            <li data-copy="operate.inactive.item.offerings">{copy('operate.inactive.item.offerings')}</li>
            <li data-copy="operate.inactive.item.revenue">{copy('operate.inactive.item.revenue')}</li>
          </ul>
          {err ? <ErrorCard err={err} onRetry={load} /> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="mkt-frame" data-testid="mkt-operate" data-state="active">
      {err ? <ErrorCard err={err} onRetry={load} /> : null}
      <div className="mkt-card">
        <h2 data-copy="op.ask.editor">{copy('op.ask.editor')}</h2>
        <div className="mkt-muted mkt-xs" data-copy="operate.ask.cycle" data-testid="mkt-ask-cycle">
          {cycle == null ? copy('operate.ask.cycle.unknown') : copy('operate.ask.cycle', { n: cycle, next: cycle + 1 })}
        </div>
        {st.offerings.length === 0 && <div className="mkt-muted mkt-xs" data-copy="operate.offerings.none">{copy('operate.offerings.none')}</div>}
        {st.offerings.map((o) => {
          const v = Number(edits[o.id]);
          const valid = v > 0;
          const disabledKey = cycle == null ? 'operate.ask.cycle.unknown' : !valid ? 'operate.ask.invalid' : null;
          return (
            <div key={o.id} className="mkt-mhead mkt-prow" data-testid={`mkt-ask-${o.id}`}>
              <span>
                <strong data-copy="_data">{o.id}</strong>{' '}
                {o.offeringUal ? <span className="mkt-yours" data-copy="operate.ka">{copy('operate.ka')}</span> : <span className="mkt-muted mkt-xs" data-copy="operate.ka.none">{copy('operate.ka.none')}</span>}
                <div className="mkt-muted mkt-xs" data-copy={o.queuedAsk ? 'operate.ask.queued' : 'operate.ask.none'}>
                  {o.queuedAsk ? copy('operate.ask.queued', { n: o.queuedAsk.effectiveFromCycle ?? (cycle != null ? cycle + 1 : '—'), ask: o.queuedAsk.askMicroPerUnit }) : copy('operate.ask.none')}
                </div>
                {askErr?.id === o.id ? <ErrorCard err={askErr.err} onRetry={() => submitAsk(o.id, o.ask?.unit ?? 'tokens')}><span className="mkt-muted mkt-xs" data-copy="operate.ask.error">{copy('operate.ask.error')}</span></ErrorCard> : null}
              </span>
              <span className="mkt-mono mkt-sec mkt-askedit">
                <span data-copy="catalog.price.micro">{o.ask ? copy('catalog.price.micro', { micro: o.ask.askMicroPerUnit, unit: o.ask.unit === 'query-units' ? 'unit' : 'tok' }) : '—'}</span>
                {' → '}
                <input className="mkt-input mkt-input--short" inputMode="decimal" data-testid={`mkt-ask-input-${o.id}`} value={edits[o.id] ?? ''} placeholder={o.queuedAsk ? String(o.queuedAsk.askMicroPerUnit) : '…'}
                  aria-label={copy('operate.ask.cta')} onChange={(e) => setEdits((x) => ({ ...x, [o.id]: e.target.value }))} />
                <button type="button" className="mkt-btn" data-testid={`mkt-ask-queue-${o.id}`} data-copy="operate.ask.cta" onClick={() => submitAsk(o.id, o.ask?.unit ?? 'tokens')}
                  disabled={!!disabledKey || busy === o.id} title={disabledKey ? copy(disabledKey) : undefined}>{busy === o.id ? copy('state.working') : copy('operate.ask.cta')}</button>
              </span>
            </div>
          );
        })}
        <p className="mkt-muted mkt-xs" data-copy="operate.ask.frozen.note">{copy('operate.ask.frozen.note')}</p>
      </div>

      <div className="mkt-card">
        <h2 data-copy="op.subscribers">{copy('op.subscribers', { n: st.subscribers.length })}</h2>
        {st.subscribers.length === 0 && <div className="mkt-muted mkt-xs" data-copy="operate.subscribers.none">{copy('operate.subscribers.none')}</div>}
        {st.subscribers.map((s) => (
          <div key={s.paymentIdentity} className="mkt-mhead mkt-prow">
            <span className="mkt-mono" title={s.buyer} data-copy="_data">{shortAddr(s.buyer)}</span>
            <span className="mkt-sec mkt-sm" data-copy="operate.subscriber.line">{copy('operate.subscriber.line', { offerings: s.offerings.join(' · '), t: fmtClock(s.expiresAt) })}</span>
          </div>
        ))}
        {st.checkpointChains.map((c) => (
          <div key={c.pair} className="mkt-muted mkt-xs" data-copy={c.freshness.agree ? 'stmt.freshness' : 'operate.checkpoints.none'}>
            {copy('operate.checkpoints', { n: c.length })} · {c.freshness.agree
              ? copy('stmt.freshness', { t: `${Math.max(1, Math.round((c.freshness.checkedAgoMs ?? 0) / 60_000))} min` })
              : copy('operate.checkpoints.none')}
          </div>
        ))}
        {st.statements.length > 0 && (
          <div className="mkt-xs mkt-sec" data-copy="op.stmt.queue">{copy('op.stmt.queue', { n: st.statements.filter((x) => x.resolution !== 'agreed').length })}</div>
        )}
      </div>

      <div className="mkt-card">
        <h2 data-copy="op.wallets">{copy('op.wallets')}</h2>
        <div className="mkt-wallet rev" data-testid="mkt-revenue-wallet">
          <strong data-copy="op.revenue.wallet">{copy('op.revenue.wallet')}</strong><br />
          <span className="mkt-mono" data-copy="_data">{st.revenueWallet ?? copy('operate.revenue.none')}</span><br />
          <span className="mkt-muted mkt-xs" data-copy="op.revenue.note">{copy('op.revenue.note')}</span>
        </div>
        <div className="mkt-wallet" data-testid="mkt-ops-wallet">
          <strong data-copy="operate.ops.wallet">{copy('operate.ops.wallet')}</strong><br />
          <span className="mkt-mono" data-copy="_data">{opsWallet ?? '—'}</span><br />
          <span className="mkt-muted mkt-xs" data-copy="operate.ops.wallet.note">{copy('operate.ops.wallet.note')}</span>
        </div>
        {exportErr ? <ErrorCard err={exportErr} onRetry={exportCalibration}><span className="mkt-muted mkt-xs" data-copy="operate.export.error">{copy('operate.export.error')}</span></ErrorCard> : null}
        <div className="mkt-mhead">
          <span className="mkt-muted mkt-xs" data-copy="operate.archive">{copy('operate.archive')}</span>
          <button type="button" className="mkt-btn" data-testid="mkt-export" data-copy="op.calibration" onClick={exportCalibration} disabled={busy === 'export'}>{busy === 'export' ? copy('state.working') : copy('op.calibration')}</button>
        </div>
      </div>
    </div>
  );
}
