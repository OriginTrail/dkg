// Surface 01 — Onboarding ("two steps, beating their three").
// Spec: docs/ui-spec/surfaces/01-onboarding.md. Every string from UI-COPY;
// every state real: the card binds to /marketplace/buyer/* and the gateway —
// the browser gates, the node signs.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { copy } from './copy.generated.js';
import { DEFAULT_TRAC_USD, fmtTrac, fmtUsd, microToTrac, fmtHash } from './format.js';
import {
  fetchBuyerWallet, fetchFundStatus, postBuyerFund, mintGatewayKey, gatewayBaseUrl,
  kpiMarkStart, kpiElapsedMmss, type NsmWallet, type NsmFundStatus, type NsmOperateStatus,
} from './api.js';

type Phase =
  | { k: 'loading' }
  | { k: 'offline' }
  | { k: 'disabled' }
  | { k: 'unconfigured' }
  | { k: 'empty-wallet'; wallet: NsmWallet }
  | { k: 'ready'; wallet: NsmWallet }
  | { k: 'funding-pending'; wallet: NsmWallet; fund: NsmFundStatus; amountMicro: number }
  | { k: 'step2'; wallet: NsmWallet }
  | { k: 'done' };

function CopyBtn({ text }: { text: string }): React.ReactElement {
  const [ok, setOk] = useState(false);
  return (
    <button className="btn btn--ghost btn--sm" onClick={() => {
      void navigator.clipboard.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); });
    }}>{ok ? '✓' : copy('ctl.copy')}</button>
  );
}

function Steps({ active }: { active: 1 | 2 }): React.ReactElement {
  return (
    <div className="steps">
      <div className={`step ${active === 1 ? 'is-active' : 'is-done'}`}>
        <span className="n">{active === 1 ? '1' : '✓'}</span> {copy('onboard.fund.title')}
      </div>
      <div className="bar" />
      <div className={`step ${active === 2 ? 'is-active' : 'is-idle'}`}>
        <span className="n">2</span> {copy('onboard.key.title')}
      </div>
    </div>
  );
}

export function OnboardingCard({ status, fxRate = DEFAULT_TRAC_USD, onDone }: {
  status: NsmOperateStatus | null | 'error';
  fxRate?: number;
  onDone?: () => void;
}): React.ReactElement | null {
  const [wallet, setWallet] = useState<NsmWallet | null | 'error'>(null);
  const [fund, setFund] = useState<NsmFundStatus | null>(null);
  const [budgetTrac, setBudgetTrac] = useState('1.0');
  const [gateOpen, setGateOpen] = useState(false);
  const [fundErr, setFundErr] = useState<string | null>(null);
  const [sentAmountMicro, setSentAmountMicro] = useState<number | null>(null);
  // key mint (step 2)
  const [keyName, setKeyName] = useState('my-agent');
  const [keyCapMicro, setKeyCapMicro] = useState('250000');
  const [minted, setMinted] = useState<{ plaintext: string } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const refreshWallet = useCallback(() => {
    fetchBuyerWallet().then(setWallet).catch(() => setWallet('error'));
    fetchFundStatus().then(setFund).catch(() => {});
  }, []);
  useEffect(() => { kpiMarkStart(); refreshWallet(); }, [refreshWallet]);

  // poll while a funding tx is confirming — and also right after a fund
  // attempt whose slow (lane) server call outlived the client request, so a
  // broadcast that succeeded server-side is never lost by the card
  useEffect(() => {
    const active = fund?.state === 'confirming'
      || (sentAmountMicro != null && (!fund || fund.state === 'none'));
    if (!active) return;
    const t = setInterval(() => { fetchFundStatus().then(setFund).catch(() => {}); }, 8000);
    return () => clearInterval(t);
  }, [fund?.state, fund, sentAmountMicro]);

  const phase: Phase = useMemo(() => {
    if (dismissed) return { k: 'done' };
    if (status === 'error') return { k: 'offline' };
    if (status === null || wallet === null) return { k: 'loading' };
    if (!status.enabled) return { k: 'disabled' };
    if (wallet === 'error') return { k: 'offline' };
    if (!wallet.configured) return { k: 'unconfigured' };
    if (fund?.state === 'confirming') return { k: 'funding-pending', wallet, fund, amountMicro: sentAmountMicro ?? 0 };
    if (wallet.tabId || fund?.state === 'funded') return { k: 'step2', wallet };
    if ((wallet.tracMicro ?? 0) <= 0) return { k: 'empty-wallet', wallet };
    return { k: 'ready', wallet };
  }, [dismissed, status, wallet, fund, sentAmountMicro]);

  const budgetMicro = Math.round(Number(budgetTrac || '0') * 1_000_000);
  const budgetUsd = fmtUsd(Number(budgetTrac || '0') * fxRate);

  const doFund = useCallback(() => {
    setGateOpen(false); setFundErr(null); setSentAmountMicro(budgetMicro);
    postBuyerFund(budgetMicro)
      .then((r) => {
        if (r.error) { setFundErr(r.error); return; }
        setFund({ state: 'confirming', txHash: r.txHash });
      })
      .catch((e) => setFundErr(String((e as Error).message)));
  }, [budgetMicro]);

  const doMint = useCallback(() => {
    mintGatewayKey({ label: keyName, budgetMicroTrac: Math.max(1, Math.round(Number(keyCapMicro) || 0)), allowQuery: true, rps: 5 })
      .then((r) => setMinted({ plaintext: r.key }))
      .catch((e) => setFundErr(String((e as Error).message)));
  }, [keyCapMicro]);

  const kpi = kpiElapsedMmss();

  if (phase.k === 'done') {
    return kpi ? (
      <div className="toast" style={{ marginBottom: 'var(--sp-5)' }}>
        <span className="chip chip--verified">✓</span> {copy('onboard.kpi', { 'mm:ss': kpi })}
      </div>
    ) : null;
  }

  if (phase.k === 'loading') {
    return (
      <div className="card card--pad stack" style={{ marginBottom: 'var(--sp-5)' }} aria-hidden>
        <div className="skel" style={{ width: '60%' }}>{copy('onboard.title')}</div>
        <div className="skel" style={{ width: '40%' }}>step indicator</div>
        <div className="skel" style={{ width: '80%' }}>body</div>
      </div>
    );
  }

  if (phase.k === 'offline') {
    return (
      <div className="card card--pad row row--between" style={{ marginBottom: 'var(--sp-5)', flexWrap: 'wrap' }}>
        <span className="sec">{copy('err.offline')}</span>
        <button className="btn" onClick={refreshWallet}>{copy('ctl.retry')}</button>
      </div>
    );
  }

  if (phase.k === 'disabled' || phase.k === 'unconfigured') {
    return (
      <div className="card card--pad" style={{ marginBottom: 'var(--sp-5)' }}>
        <span className="sec">{copy(phase.k === 'disabled' ? 'onboard.disabled' : 'onboard.unconfigured')}</span>
      </div>
    );
  }

  return (
    <div className="card card--pad stack" style={{ marginBottom: 'var(--sp-5)' }}>
      <h1 style={{ fontSize: 'var(--fs-xl)' }}>{copy('onboard.title')}</h1>
      <Steps active={phase.k === 'step2' ? 2 : 1} />

      {phase.k === 'empty-wallet' && (
        <>
          <div className="sec">{copy('onboard.fund.empty', { address: fmtHash(phase.wallet.address ?? '') })}</div>
          <div className="snippet"><span>{phase.wallet.address}</span><CopyBtn text={phase.wallet.address ?? ''} /></div>
          <div className="xs muted">{copy('onboard.fund.watch')}</div>
        </>
      )}

      {phase.k === 'ready' && (
        <>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <label className="sec sm" htmlFor="nsm-budget">{copy('onboard.fund.label')}</label>
            <input id="nsm-budget" className="input mono" size={8} value={budgetTrac}
              onChange={(e) => setBudgetTrac(e.target.value)} />
            <span className="sec">TRAC · ~{budgetUsd}</span>
          </div>
          <div className="sm muted">
            wallet: <span className="mono">{fmtTrac(microToTrac(phase.wallet.tracMicro ?? 0))} TRAC</span>{' '}
            <span className="sec">({fmtUsd(microToTrac(phase.wallet.tracMicro ?? 0) * fxRate)})</span>
          </div>
          <div><button className="btn btn--primary" onClick={() => setGateOpen(true)}
            disabled={budgetMicro <= 0 || budgetMicro > (phase.wallet.tracMicro ?? 0)}>{copy('onboard.fund.cta')}</button></div>
          <div className="sec sm">{copy('onboard.fund.body')}</div>
          {fundErr && <div className="sm" style={{ color: 'var(--state-blocked)' }}>{copy('err.5xx')} <span className="mono xs">({fundErr})</span></div>}

          {gateOpen && (
            <div className="drawer" style={{ maxWidth: 'calc(var(--card-min-w) * 1.5)' }}>
              <div className="sm" style={{ marginBottom: 'var(--sp-3)' }}>{copy('treasury.confirm.title')}</div>
              <div className="drow"><span>{copy('treasury.confirm.amount')}</span><span className="v">{budgetTrac} TRAC (~{budgetUsd})</span></div>
              <div className="drow"><span>{copy('treasury.confirm.from')}</span><span className="v">{fmtHash(phase.wallet.address ?? '')} (this node)</span></div>
              <div className="drow"><span>{copy('treasury.confirm.to')}</span><span className="v">
                {phase.wallet.quoteVerified && phase.wallet.quoteProvider
                  ? fmtHash(phase.wallet.quoteProvider)
                  : copy('model.quote.unverifiable')}
              </span></div>
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 'var(--sp-3)' }}>
                <button className="btn btn--ghost btn--sm" onClick={() => setGateOpen(false)}>{copy('ctl.cancel')}</button>
                <button className="btn btn--primary btn--sm" onClick={doFund}
                  disabled={!phase.wallet.quoteVerified}>{copy('treasury.confirm.cta')}</button>
              </div>
            </div>
          )}
        </>
      )}

      {phase.k === 'funding-pending' && (
        <>
          <div className="row">
            <span className="chip chip--checking">◌ {copy('chain.confirming')}</span>
            {phase.fund.txHash && <span className="sm sec mono">{fmtHash(phase.fund.txHash)}</span>}
          </div>
          <div className="sm muted">{copy('onboard.fund.pending', {
            amount: fmtTrac(microToTrac(phase.amountMicro)), usd: fmtUsd(microToTrac(phase.amountMicro) * fxRate).slice(1),
          })}</div>
        </>
      )}

      {phase.k === 'step2' && (
        <>
          <div className="sec">{copy('onboard.key.body')}</div>
          {!minted ? (
            <>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <label className="sec sm" htmlFor="nsm-kname">{copy('key.name.label')}</label>
                <input id="nsm-kname" className="input mono" size={14} value={keyName} onChange={(e) => setKeyName(e.target.value)} />
                <label className="sec sm" htmlFor="nsm-kcap">{copy('key.cap.label')}</label>
                <input id="nsm-kcap" className="input mono" size={10} value={keyCapMicro} onChange={(e) => setKeyCapMicro(e.target.value)} />
                <span className="xs muted">µ</span>
              </div>
              <div><button className="btn btn--primary" onClick={doMint}>{copy('key.mint')}</button></div>
              {fundErr && <div className="sm" style={{ color: 'var(--state-blocked)' }}>{copy('err.5xx')} <span className="mono xs">({fundErr})</span></div>}
            </>
          ) : (
            <>
              <div className="snippet"><span>OPENAI_BASE_URL={gatewayBaseUrl()}</span><CopyBtn text={`OPENAI_BASE_URL=${gatewayBaseUrl()}`} /></div>
              <div className="snippet"><span>OPENAI_API_KEY={minted.plaintext}</span><CopyBtn text={`OPENAI_API_KEY=${minted.plaintext}`} /></div>
              <div className="warn-once">⚠ {copy('onboard.key.once')}</div>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn--primary btn--sm" onClick={() => { setMinted(null); setDismissed(true); onDone?.(); }}>{copy('ctl.done')}</button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
