// Compose, confirm, then a key: funding an epoch's subscription from the
// buyer wallet or an account, and saving the plan that renews it. Changing
// the plan while an epoch runs saves the plan alone; its next renewal funds
// it. The node sends the funding from its buyer wallet: no browser wallet,
// and nothing goes to a seller directly.
import React, { useState } from 'react';
import { copy } from '../copy.generated.js';
import { marketplaceApi } from '../api/client.js';
import type { CatalogAnswer, FundedAnswer, Funding } from '../api/types.js';
import { fmtHex, fmtTrac } from '../amounts.js';
import { Composer, PreviewLine, fundingRequestOf, servicesOf, usePreview, type Draft } from './Composer.js';
import { ConfirmGate } from './ConfirmGate.js';
import { KeyStep } from './KeyStep.js';
import { ProgressSteps } from './ProgressSteps.js';

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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [funded, setFunded] = useState<FundedAnswer | null>(null);
  const { preview, err: previewErr, busy: previewBusy } = usePreview(draft, catalog, fundsEpoch);
  const services = servicesOf(draft, catalog);
  const renewUntil = Number(draft.renewUntil);
  const renewOk = !draft.renew || (Number.isInteger(renewUntil) && renewUntil >= catalog.epoch);
  const continueKey = !services ? 'composer.empty' : !renewOk ? 'composer.renew.invalid' : fundsEpoch && preview?.refusal ? 'composer.refused' : null;

  const confirm = async () => {
    if (!services || busy) return;
    setBusy(true); setErr(null);
    try {
      if (fundsEpoch) setFunded(await marketplaceApi.fund(fundingRequestOf(draft, services)));
      await marketplaceApi.savePlan({ services, source: draft.source, renew: draft.renew, ...(draft.renew ? { renewUntilEpoch: renewUntil } : {}) });
      if (fundsEpoch && onboarding) setPhase('done');
      else onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const step = phase === 'done' ? 3 : 2;
  return (
    <div className="mkt-flow" data-testid="mkt-fund-flow" data-phase={phase}>
      {onboarding && <ProgressSteps step={step} sub={phase === 'confirm' ? (busy ? 'sending' : 'confirm') : null} />}
      {phase === 'compose' && (
        <>
          <Composer catalog={catalog} funding={funding} draft={draft} onChange={setDraft} fundsEpoch={fundsEpoch} endsAt={endsAt} />
          <div className="mkt-card" data-testid="mkt-compose-actions">
            {fundsEpoch && <PreviewLine preview={preview} err={previewErr} busy={previewBusy} />}
            <div className="mkt-fork">
              {onCancel && <button type="button" className="mkt-btn" data-copy="gate.cancel" onClick={onCancel}>{copy('gate.cancel')}</button>}
              <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-compose-continue" data-copy="composer.continue"
                disabled={!!continueKey || (fundsEpoch && !preview)} title={continueKey ? copy(continueKey) : undefined} onClick={() => setPhase('confirm')}>{copy('composer.continue')}</button>
              {continueKey && <span className="mkt-muted mkt-xs" data-copy={continueKey}>{copy(continueKey)}</span>}
            </div>
          </div>
        </>
      )}
      {phase === 'confirm' && services && (
        <ConfirmGate catalog={catalog} funding={funding} preview={preview} services={services} fundsEpoch={fundsEpoch}
          renew={draft.renew} renewUntil={draft.renew ? renewUntil : null} busy={busy} err={err}
          onConfirm={() => { void confirm(); }} onCancel={() => { setErr(null); setPhase('compose'); }} />
      )}
      {phase === 'done' && (
        <>
          <div className="mkt-notice" role="status" data-testid="mkt-funded">
            <strong data-copy="flow.funded">{copy('flow.funded', { n: funded?.subscription?.epoch ?? preview?.epoch ?? catalog.epoch, trac: fmtTrac(funded?.subscription?.value ?? preview?.value ?? '0') })}</strong>{' '}
            {funded && <span className="mkt-muted mkt-xs mkt-mono" data-copy="flow.tx">{copy('flow.tx', { tx: fmtHex(funded.txHash), block: funded.blockNumber })}</span>}
          </div>
          <KeyStep budgetTrac={fmtTrac(funded?.subscription?.value ?? preview?.value ?? '0')} onPlans={onDone} />
        </>
      )}
    </div>
  );
}
