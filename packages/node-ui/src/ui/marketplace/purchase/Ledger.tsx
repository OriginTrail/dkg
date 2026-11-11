// What happened to the value: the reconciliation of an epoch (per budget and
// seller, the receipts this node holds against those landed and counted,
// with the batch transactions; final once the epoch has ended), and the
// gateway's recent calls, by key.
import React, { useState } from 'react';
import { copy } from '../copy.generated.js';
import { marketplaceApi, needsNodeAdmin } from '../api/client.js';
import type { Call, CatalogAnswer, ReconciliationAnswer } from '../api/types.js';
import { fmtCount, fmtHex, fmtTime, fmtTrac, modelName } from '../amounts.js';
import { ErrorCard, sellerName, useLoad } from '../shared.js';

export function Reconciliation({ catalog, epoch }: { catalog: CatalogAnswer; epoch: number }): React.ReactElement {
  const [asked, setAsked] = useState(epoch);
  return (
    <div className="ds-card mkt-card" data-testid="mkt-reconciliation" data-epoch={asked}>
      <div className="mkt-mhead">
        <h2 data-copy="recon.title">{copy('recon.title', { n: asked })}</h2>
        <span className="mkt-fchips">
          {[epoch, epoch - 1].map((e) => (
            <button key={e} type="button" className={asked === e ? 'ds-filter active' : 'ds-filter'} data-testid={`mkt-recon-${e}`} data-copy={e === epoch ? 'recon.this' : 'recon.last'} onClick={() => setAsked(e)}>
              {copy(e === epoch ? 'recon.this' : 'recon.last')}
            </button>
          ))}
        </span>
      </div>
      <ReconciledRows key={asked} catalog={catalog} epoch={asked} />
      <div className="mkt-muted mkt-xs" data-copy="recon.note">{copy('recon.note')}</div>
    </div>
  );
}

/** One epoch's reconciliation, loaded afresh for each epoch asked. */
function ReconciledRows({ catalog, epoch }: { catalog: CatalogAnswer; epoch: number }): React.ReactElement {
  const r = useLoad<ReconciliationAnswer>(() => marketplaceApi.reconciliation(epoch));
  const label = (id: string) => modelName(catalog.services.find((x) => x.serviceId === id)?.label ?? id);
  const rows = r.data?.rows ?? [];
  const held = rows.reduce((s, x) => s + x.held.count, 0);
  const landed = rows.reduce((s, x) => s + x.landed.count, 0);
  const matched = rows.reduce((s, x) => s + x.landed.matched, 0);
  return (
    <div data-testid="mkt-recon-body" data-final={r.data?.final ?? false}>
      {r.err && !r.data ? <ErrorCard err={r.err} onRetry={r.reload} /> : null}
      {r.data && (
        <div className={r.data.final ? 'mkt-stmtline' : 'mkt-muted mkt-xs'} data-copy={r.data.final ? 'recon.line.final' : 'recon.line.open'}>
          {copy(r.data.final ? 'recon.line.final' : 'recon.line.open', { held: fmtCount(held), landed: fmtCount(landed), matched: fmtCount(matched) })}
        </div>
      )}
      {r.data && rows.length === 0 && <div className="mkt-muted mkt-xs" data-copy="recon.none">{copy('recon.none')}</div>}
      {rows.length > 0 && (
        <div className="ds-table-scroll">
        <table className="mkt-act" data-testid="mkt-recon-rows">
          <tbody>
            {rows.map((x) => (
              <tr key={`${x.subscriptionId}:${x.budgetIndex}:${x.seller}`}>
                <td data-copy="_data">{label(x.serviceId)}</td>
                <td className="mkt-muted" data-copy="_data">{sellerName(x.seller)}</td>
                <td data-copy="recon.held">{copy('recon.held', { n: fmtCount(x.held.count), trac: fmtTrac(x.held.value) })}</td>
                <td data-copy="recon.landed">{copy('recon.landed', { n: fmtCount(x.landed.count), matched: fmtCount(x.landed.matched), trac: fmtTrac(x.landed.counted) })}</td>
                <td className="mkt-mono mkt-muted" data-copy="_data">{x.landed.txs.map(fmtHex).join(' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

export function Activity({ catalog, calls, err }: { catalog: CatalogAnswer; calls: Call[] | null; err: unknown }): React.ReactElement {
  const [keyFilter, setKeyFilter] = useState<string | null>(null);
  const label = (id: string) => modelName(catalog.services.find((x) => x.serviceId === id)?.label ?? id);
  const all = calls ?? [];
  const keys = [...new Set(all.map((c) => c.keyId))];
  const shown = all.filter((c) => !keyFilter || c.keyId === keyFilter);
  return (
    <div className="ds-card mkt-card" data-testid="mkt-activity">
      <div className="mkt-mhead">
        <h2 data-copy="activity.title">{copy('activity.title')}</h2>
        <span className="mkt-fchips">
          <button type="button" className={keyFilter === null ? 'ds-filter active' : 'ds-filter'} data-copy="activity.filter.all" onClick={() => setKeyFilter(null)}>{copy('activity.filter.all')}</button>
          {keys.map((k) => <button type="button" key={k} className={keyFilter === k ? 'ds-filter active' : 'ds-filter'} data-copy="_data" onClick={() => setKeyFilter(k)}>{k}</button>)}
        </span>
      </div>
      {needsNodeAdmin(err) ? <div className="mkt-muted mkt-xs" data-copy="activity.admin">{copy('activity.admin')}</div> : err ? <ErrorCard err={err} /> : null}
      <div className="ds-table-scroll">
      <table className="mkt-act">
        <tbody>
          {shown.slice(0, 20).map((c) => (
            <tr key={c.callId} data-state={c.state}>
              <td className="mkt-mono" data-copy="_data">{fmtTime(c.at)}</td>
              <td data-copy="_data">{label(c.serviceId)}</td>
              <td className="mkt-muted" data-copy="_data">{sellerName(c.seller)}</td>
              <td data-copy="activity.units">{copy('activity.units', { n: c.units.toLocaleString('en-US'), trac: fmtTrac(c.value) })}</td>
              <td data-copy={`activity.state.${c.state}`}><span className={c.state === 'missed' ? 'ds-badge ds-tone-danger' : c.state === 'held' ? 'ds-badge ds-tone-warning' : 'ds-badge ds-tone-success'}>{copy(`activity.state.${c.state}`)}</span></td>
              <td className="mkt-muted mkt-mono" data-copy="_data">{c.keyId}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {calls && shown.length === 0 && <div className="mkt-muted mkt-xs" data-copy="empty.activity">{copy('empty.activity')}</div>}
      <div className="mkt-muted mkt-xs" data-copy="activity.note">{copy('activity.note')}</div>
    </div>
  );
}
