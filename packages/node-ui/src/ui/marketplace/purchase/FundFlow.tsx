// Compose, confirm, then a key: funding an epoch's subscription from the
// buyer wallet or an account, and saving the plan that renews it. Changing
// the plan while an epoch runs saves the plan alone; its next renewal funds
// it. The node sends the funding from its buyer wallet: no browser wallet,
// and nothing goes to a seller directly.
import React, { useState } from 'react';
import { copy } from '../copy.generated.js';
import { marketplaceApi } from '../api/client.js';
import type { CatalogAnswer, FundedAnswer, Funding, FundingRequest, Preview } from '../api/types.js';
import { fmtHex, fmtTrac } from '../amounts.js';
import { ErrorCard } from '../shared.js';
import { Composer, PreviewLine, fundingRequestOf, servicesOf, type Draft } from './Composer.js';
import { ConfirmGate } from './ConfirmGate.js';
import { KeyStep } from './KeyStep.js';
import { ProgressSteps } from './ProgressSteps.js';
import { usePreview } from './usePreview.js';

/**
 * What the confirmation shows and what Confirm sends, fixed when Continue is
 * pressed: the request the node's dry run answered, that answer, and how the
 * plan renews.
 */
interface Confirming {
  request: FundingRequest;
  /** The dry run of `request`; null when the flow only saves the plan. */
  preview: Preview | null;
  renew: boolean;
  renewUntil: number | null;
}

export function FundFlow({ catalog, funding, initial, fundsEpoch, onboarding, onDone, onCancel, endsAt }: {
  catalog: CatalogAnswer;
  funding: Funding | null;
  initial: Draft;
  fundsEpoch: boolean;
  onboarding: boolean;
  onDone: () => void;
  onCancel?: () => void;
  endsAt: number | null;
}): React.ReactElement {
  const [draft, setDraft] = useState<Draft>(initial);
  const [phase, setPhase] = useState<'compose' | 'confirm' | 'done'>('compose');
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [funded, setFunded] = useState<FundedAnswer | null>(null);
  const [planErr, setPlanErr] = useState<unknown>(null);
  const services = servicesOf(draft, catalog);
  const request = services ? fundingRequestOf(draft, services) : null;
  // While a changed draft's dry run loads, the last answer stays on show; only the draft's own answer opens Continue.
  const dryRun = usePreview(fundsEpoch ? request : null, (r) => marketplaceApi.preview(r), { retain: 'last' });
  const shown = dryRun.shown?.preview ?? null;
  const renewUntil = Number(draft.renewUntil);
  const renewOk = !draft.renew || (Number.isInteger(renewUntil) && renewUntil >= catalog.epoch);
  const continueKey = !services ? 'composer.empty' : !renewOk ? 'composer.renew.invalid' : fundsEpoch && shown?.refusal ? 'composer.refused' : null;
  const canContinue = !!request && !continueKey && (!fundsEpoch || !!dryRun.current);

  const toConfirm = () => {
    if (!canContinue || !request) return;
    const answered = fundsEpoch ? dryRun.current : null;
    setConfirming({ request: answered?.request ?? request, preview: answered?.preview ?? null, renew: draft.renew, renewUntil: draft.renew ? renewUntil : null });
    setPhase('confirm');
  };

  const savePlan = (c: Confirming) => marketplaceApi.savePlan({
    services: c.request.services, source: c.request.source, renew: c.renew, ...(c.renew && c.renewUntil !== null ? { renewUntilEpoch: c.renewUntil } : {}),
  });

  // Funding goes out once: a retry after it was sent only saves the plan again.
  const confirm = async () => {
    const c = confirming;
    if (!c || busy) return;
    setBusy(true); setErr(null);
    let sent = funded;
    try {
      if (fundsEpoch && !sent) { sent = await marketplaceApi.fund(c.request); setFunded(sent); }
    } catch (e) {
      setErr(e); setBusy(false); return;
    }
    try {
      await savePlan(c);
      setPlanErr(null);
    } catch (e) {
      setBusy(false);
      if (!sent) { setErr(e); return; }
      setPlanErr(e); setPhase('done'); return;
    }
    setBusy(false);
    if (sent && onboarding) setPhase('done');
    else onDone();
  };
  const retryPlan = () => {
    if (busy || !confirming) return;
    setBusy(true);
    savePlan(confirming).then(() => setPlanErr(null)).catch(setPlanErr).finally(() => setBusy(false));
  };

  const step = phase === 'done' ? 3 : 2;
  const confirmed = confirming?.preview ?? null;
  return (
    <div className="mkt-flow" data-testid="mkt-fund-flow" data-phase={phase}>
      {onboarding && <ProgressSteps step={step} sub={phase === 'confirm' ? (busy ? 'sending' : 'confirm') : null} />}
      {phase === 'compose' && (
        <>
          <Composer catalog={catalog} funding={funding} draft={draft} onChange={setDraft} fundsEpoch={fundsEpoch} endsAt={endsAt} />
          <div className="mkt-card" data-testid="mkt-compose-actions">
            {fundsEpoch && <PreviewLine preview={shown} err={dryRun.err} busy={dryRun.busy} />}
            <div className="mkt-fork">
              {onCancel && <button type="button" className="mkt-btn" data-copy="gate.cancel" onClick={onCancel}>{copy('gate.cancel')}</button>}
              <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-compose-continue" data-copy="composer.continue"
                disabled={!canContinue} title={continueKey ? copy(continueKey) : fundsEpoch && dryRun.busy ? copy('composer.preview.updating') : undefined}
                onClick={toConfirm}>{copy('composer.continue')}</button>
              {continueKey && <span className="mkt-muted mkt-xs" data-copy={continueKey}>{copy(continueKey)}</span>}
            </div>
          </div>
        </>
      )}
      {phase === 'confirm' && confirming && (
        <ConfirmGate catalog={catalog} funding={funding} preview={confirmed} services={confirming.request.services} fundsEpoch={fundsEpoch}
          renew={confirming.renew} renewUntil={confirming.renewUntil} busy={busy} err={err}
          onConfirm={() => { void confirm(); }} onCancel={() => { setErr(null); setConfirming(null); setPhase('compose'); }} />
      )}
      {phase === 'done' && (
        <>
          <div className="mkt-notice" role="status" data-testid="mkt-funded">
            <strong data-copy="flow.funded">{copy('flow.funded', { n: funded?.subscription?.epoch ?? confirmed?.epoch ?? catalog.epoch, trac: fmtTrac(funded?.subscription?.value ?? confirmed?.value ?? '0') })}</strong>{' '}
            {funded && <span className="mkt-muted mkt-xs mkt-mono" data-copy="flow.tx">{copy('flow.tx', { tx: fmtHex(funded.txHash), block: funded.blockNumber })}</span>}
          </div>
          {planErr ? (
            <ErrorCard err={planErr}>
              <span className="mkt-xs" data-testid="mkt-plan-unsaved" data-copy="flow.plan.failed">{copy('flow.plan.failed')}</span>
              <button type="button" className="mkt-btn" data-testid="mkt-plan-retry" data-copy="flow.plan.retry" onClick={retryPlan} disabled={busy}>{copy('flow.plan.retry')}</button>
            </ErrorCard>
          ) : null}
          {onboarding
            ? <KeyStep budgetTrac={fmtTrac(funded?.subscription?.value ?? confirmed?.value ?? '0')} onPlans={onDone} />
            : <div className="mkt-fork"><button type="button" className="mkt-btn" data-copy="ctl.done" onClick={onDone}>{copy('ctl.done')}</button></div>}
        </>
      )}
    </div>
  );
}
