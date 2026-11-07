// "One confirmation": every number on this card is the node's frozen terms:
// per-seller amount and revenue wallet, transfers, chain and TRAC contract,
// the connected purchase wallet, balances and gas estimate (with their source
// and time), each offering's frozen ask and guaranteed units, the no-refund
// line, then Cancel / Confirm.
import React from 'react';
import { copy } from '../copy.generated.js';
import type { ChainInfo, PurchaseIntent } from '../types.js';
import { IdentityStrip } from './IdentityStrip.js';
import { ErrorCard, ethFromWei, fmtClock, fmtUnits, shortAddr, tracFromMicro, unitWord, usdFromMicro, MICRO } from './shared.js';

export function ConfirmGate({ intent, chain, opsWallet, walletChainId, fx, busy, err, onConfirm, onCancel, onRetry, onSwitchNetwork, onRefreshTerms, cancelDisabledKey }: {
  intent: PurchaseIntent;
  chain: ChainInfo | null;
  opsWallet: string | null;
  walletChainId: number | null;
  fx: number;
  busy: boolean;
  err: unknown | null;
  onConfirm: () => void;
  onCancel: () => void;
  onRetry?: () => void;
  onSwitchNetwork: () => void;
  onRefreshTerms: () => void;
  cancelDisabledKey?: string | null;
}): React.ReactElement {
  const f = intent.frozen;
  const sellers = f ? Object.entries(f.sellers) : [];
  const totalMicro = sellers.reduce((s, [, v]) => s + v.amountMicroTrac, 0);   // display sum of node amounts
  const wrongNet = !!f && walletChainId != null && walletChainId !== f.chainId;
  const chainName = chain?.name ?? (f?.chainId === 8453 ? 'Base' : f ? `chain-${f.chainId}` : '—');

  return (
    <div className="mkt-card mkt-gate" data-testid="mkt-confirm-gate">
      <h2 data-copy="onboard.consent.title">{copy('onboard.consent.title')}</h2>
      {!f && <div className="mkt-muted" data-copy="purchase.terms.missing">{copy('purchase.terms.missing')}</div>}

      {f && (
        <>
          <IdentityStrip opsWallet={opsWallet} buyer={intent.buyer}
            sellers={sellers.map(([seller, v]) => ({ seller, revenueWallet: v.revenueWallet }))}
            chainLabel={copy('purchase.chain.line', { chainId: f.chainId, name: chainName, contract: shortAddr(f.tracContract) })} />

          <div className="mkt-paylines" data-testid="mkt-pay-lines">
            {sellers.map(([seller, v]) => (
              <div key={seller} className="mkt-payline">
                <span className="mkt-mono" data-copy="purchase.pay.line">
                  {copy('purchase.pay.line', { amount: tracFromMicro(v.amountMicroTrac), seller: shortAddr(seller) })}
                </span>
                <span className="mkt-muted mkt-xs mkt-mono" title={v.revenueWallet} data-copy="_data">→ {shortAddr(v.revenueWallet)}</span>
                <span className="mkt-sec mkt-sm" data-copy="_data">{usdFromMicro(v.amountMicroTrac, fx)}</span>
                <ul className="mkt-frozenlines">
                  {v.lines.map((l) => (
                    <li key={l.offeringId} className="mkt-xs mkt-sec" data-copy="purchase.frozen.line">
                      {copy('purchase.frozen.line', { offering: l.offeringId, ask: l.askMicroPerUnit, unit: unitWord(l.unit), units: fmtUnits(l.guaranteedUnits) })}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="mkt-mhead">
            <strong data-copy="onboard.consent.total">
              {copy('onboard.consent.total', { n: sellers.length, trac: tracFromMicro(totalMicro), usd: ((totalMicro / MICRO) * fx).toFixed(2) })}
            </strong>
            <span className="mkt-muted mkt-xs" data-copy={sellers.length > 1 ? 'purchase.transfers' : 'purchase.transfer.one'}>
              {sellers.length > 1 ? copy('purchase.transfers', { n: sellers.length }) : copy('purchase.transfer.one')}
            </span>
          </div>

          <div className="mkt-balances" data-testid="mkt-balances">
            <span data-copy="purchase.balances">{copy('purchase.balances')}</span>{' '}
            {f.balances ? (
              <>
                <span className="mkt-mono" data-copy="purchase.balances.trac">{copy('purchase.balances.trac', { trac: tracFromMicro(f.balances.tracMicro) })}</span>{' · '}
                <span className="mkt-mono" data-copy="purchase.balances.gas">{copy('purchase.balances.gas', { eth: ethFromWei(f.balances.ethWei), est: ethFromWei(f.balances.gasEstimateWei) })}</span>{' '}
                <span className="mkt-muted mkt-xs" data-copy="purchase.balances.source">{copy('purchase.balances.source', { t: fmtClock(f.balances.checkedAt) })}</span>
              </>
            ) : <span className="mkt-muted mkt-xs" data-copy="purchase.balances.none">{copy('purchase.balances.none')}</span>}
          </div>
          <div className="mkt-muted mkt-xs" data-copy="purchase.valid.until">{copy('purchase.valid.until', { t: fmtClock(f.validUntil) })}</div>

          {wrongNet && (
            <div className="mkt-notice" role="status">
              <span data-copy="wallet.wrong-network">{copy('wallet.wrong-network', { have: walletChainId ?? '—', want: f.chainId })}</span>{' '}
              <button type="button" className="mkt-btn" data-testid="mkt-switch-network" data-copy="wallet.switch" onClick={onSwitchNetwork} disabled={busy}>{copy('wallet.switch')}</button>
            </div>
          )}
        </>
      )}

      {intent.error?.code === 'E_TERMS_STALE' && (
        <div className="mkt-notice" role="status" data-testid="mkt-terms-stale">
          <span data-copy="purchase.terms.stale">{copy('purchase.terms.stale')}</span>{' '}
          <button type="button" className="mkt-btn" data-copy="purchase.terms.again" onClick={onRefreshTerms} disabled={busy}>{copy('purchase.terms.again')}</button>
        </div>
      )}
      {err ? <ErrorCard err={err} onRetry={onRetry} /> : null}

      <p className="mkt-muted mkt-sm" data-copy="onboard.pay.norefund">{copy('onboard.pay.norefund')}</p>
      <div className="mkt-fork mkt-gate-actions">
        <button type="button" className="mkt-btn" data-testid="mkt-cancel" data-copy="gate.cancel" onClick={onCancel}
          disabled={!!cancelDisabledKey || busy} title={cancelDisabledKey ? copy(cancelDisabledKey) : undefined}>{copy('gate.cancel')}</button>
        {cancelDisabledKey && <span className="mkt-muted mkt-xs" data-copy={cancelDisabledKey}>{copy(cancelDisabledKey)}</span>}
        <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-confirm" data-copy="gate.confirm"
          onClick={onConfirm} disabled={busy || !f || !intent.bindingStatement || !intent.buyer}
          title={!f || !intent.bindingStatement ? copy('purchase.terms.missing') : !intent.buyer ? copy('wallet.none') : undefined}>
          {busy ? copy('state.working') : copy('gate.confirm')}
        </button>
      </div>
    </div>
  );
}
