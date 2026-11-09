// One confirmation: every number on this card is the node's dry run of the
// request it lists (its epoch, source, value, cost and discount), beside the
// budgets and caps of that request, the buyer wallet that sends the funding
// and its ETH for gas, and how the plan renews. Cancel, or Confirm, which
// sends that same request.
import React from 'react';
import { copy } from '../copy.generated.js';
import type { CatalogAnswer, Funding, Preview, ServiceRequest } from '../api/types.js';
import { fmtHex, fmtMicro, fmtTrac, modelName, usdOf } from '../amounts.js';
import { ErrorCard, refusalKey, sellerName } from '../shared.js';

export function ConfirmGate({ catalog, funding, preview, services, fundsEpoch, renew, renewUntil, busy, err, onConfirm, onCancel }: {
  catalog: CatalogAnswer;
  funding: Funding | null;
  preview: Preview | null;
  services: ServiceRequest[];
  fundsEpoch: boolean;
  renew: boolean;
  renewUntil: number | null;
  busy: boolean;
  err: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const label = (id: string) => modelName(catalog.services.find((s) => s.serviceId === id)?.label ?? id);
  const refused = fundsEpoch && !!preview?.refusal;
  const source = preview?.source.kind === 'account' ? copy('source.account', { id: preview.source.accountId }) : copy('source.wallet');
  const canConfirm = !busy && (!fundsEpoch || (!!preview && !refused));
  return (
    <div className="mkt-card mkt-gate" data-testid="mkt-confirm-gate">
      <h2 data-copy={fundsEpoch ? 'gate.title' : 'gate.title.plan'}>{copy(fundsEpoch ? 'gate.title' : 'gate.title.plan')}</h2>
      {fundsEpoch && preview && (
        <div className="mkt-wallet" data-testid="mkt-gate-source">
          <strong data-copy="gate.epoch">{copy('gate.epoch', { n: preview.epoch, source })}</strong><br />
          {funding && <span className="mkt-mono mkt-xs" data-copy="_data">{fmtHex(funding.buyerWallet.address)}</span>}{' '}
          {funding && <span className="mkt-muted mkt-xs" data-copy="gate.wallet">{copy('gate.wallet', { eth: funding.buyerWallet.ethEther })}</span>}
        </div>
      )}
      <table className="mkt-act" data-testid="mkt-gate-lines">
        <tbody>
          {services.map((s) => (
            <tr key={s.serviceId}>
              <td data-copy="_data"><strong>{label(s.serviceId)}</strong></td>
              <td className="mkt-mono" data-copy="gate.line.value">{copy('gate.line.value', { trac: fmtTrac(s.value) })}</td>
              <td className="mkt-muted" data-copy="gate.line.cap">{copy('gate.line.cap', { price: fmtMicro(s.maxPricePerUnit) })}</td>
              <td className="mkt-muted" data-copy={s.pinnedSeller !== undefined ? 'gate.line.pinned' : 'gate.line.any'}>
                {s.pinnedSeller !== undefined ? copy('gate.line.pinned', { seller: sellerName(s.pinnedSeller) }) : copy('gate.line.any')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {fundsEpoch && preview && (
        <div className="mkt-sec" data-testid="mkt-gate-total" data-copy="gate.total">
          {copy('gate.total', { value: fmtTrac(preview.value), cost: fmtTrac(preview.cost), usd: usdOf(preview.cost, catalog.fx.tracUsd) ?? '' })}
          {preview.discountBps > 0 && <span className="mkt-muted mkt-xs" data-copy="gate.discount"> · {copy('gate.discount', { pct: preview.discountBps / 100 })}</span>}
        </div>
      )}
      {refused && <div className="mkt-xs mkt-errline" data-copy={refusalKey(preview!.refusal!.code)}>{copy(refusalKey(preview!.refusal!.code))}</div>}
      <div className="mkt-muted mkt-xs" data-copy={renew ? 'gate.renew' : 'gate.renew.off'}>{renew ? copy('gate.renew', { n: renewUntil ?? '—' }) : copy('gate.renew.off')}</div>
      <p className="mkt-muted mkt-xs" data-copy="gate.note">{copy('gate.note')}</p>
      {err ? <ErrorCard err={err} onRetry={onConfirm} /> : null}
      <div className="mkt-fork mkt-gate-actions">
        <button type="button" className="mkt-btn" data-copy="gate.cancel" data-testid="mkt-gate-cancel" onClick={onCancel} disabled={busy}>{copy('gate.cancel')}</button>
        <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-gate-confirm" data-copy={fundsEpoch ? 'gate.confirm' : 'gate.confirm.plan'} onClick={onConfirm} disabled={!canConfirm}>
          {busy ? copy('state.working') : copy(fundsEpoch ? 'gate.confirm' : 'gate.confirm.plan')}
        </button>
      </div>
    </div>
  );
}
