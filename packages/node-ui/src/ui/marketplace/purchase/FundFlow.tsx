// Compose, confirm, then a key: funding an epoch's subscription from the
// buyer wallet or an account, and saving the plan that renews it. Changing
// the plan while an epoch runs saves the plan alone; its next renewal funds
// it. The node sends the funding from its buyer wallet: no browser wallet,
// and nothing goes to a seller directly.
import React, { useState } from 'react';
import { copy } from '../copy.generated.js';
import { marketplaceApi } from '../api/client.js';
import type { CatalogAnswer, FundedAnswer, Funding, FundingRequest, PlanRequest } from '../api/types.js';
import { fmtHex, fmtTrac } from '../amounts.js';
import { ErrorCard } from '../shared.js';
import { Composer, PreviewLine, fundingRequestOf, servicesOf, type Draft } from './Composer.js';
import { ConfirmGate } from './ConfirmGate.js';
import { KeyStep } from './KeyStep.js';
import type { Confirming, FundConfirming } from './model.js';
import { ProgressSteps } from './ProgressSteps.js';
import { usePreview } from './usePreview.js';

/** The flow, one phase at a time. A funding goes out once: once it is `funded`, only the plan save can be sent again. */
type Flow =
  | { phase: 'compose' }
  /** The confirmation, with the failure of the last Confirm, if any. */
  | { phase: 'confirm'; confirming: Confirming; err: unknown }
  /** Confirm sent: the funding and then the plan, or the plan alone. */
  | { phase: 'sending'; confirming: Confirming }
  /** The epoch is funded. The plan is saved unless `planErr`; `saving` while it is sent again. */
  | { phase: 'funded'; confirming: FundConfirming; funded: FundedAnswer; planErr: unknown; saving: boolean }
  /** The plan alone is saved, and the flow is done. */
  | { phase: 'saved' };

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
  const [flow, setFlow] = useState<Flow>({ phase: 'compose' });
  // Back from the confirmation, the draft is asked about afresh: an epoch may have ended since its last dry run.
  const [round, setRound] = useState(0);
  const services = servicesOf(draft);
  const request = services ? fundingRequestOf(draft, services) : null;
  // While a changed draft's dry run loads, the last answer stays on show; only the draft's own answer opens Continue.
  const dryRun = usePreview(fundsEpoch ? request : null, (r) => marketplaceApi.preview(r), { retain: 'last', round });
  const shown = dryRun.shown?.preview ?? null;
  const renewUntil = Number(draft.renewUntil);
  const renewOk = !draft.renew || (Number.isInteger(renewUntil) && renewUntil >= catalog.epoch);
  const continueKey = !services ? 'composer.empty' : !renewOk ? 'composer.renew.invalid' : fundsEpoch && shown?.refusal ? 'composer.refused' : null;
  const canContinue = !!request && !continueKey && (!fundsEpoch || !!dryRun.current);

  const planOf = (r: FundingRequest): PlanRequest => ({
    services: r.services, source: r.source, renew: draft.renew, ...(draft.renew ? { renewUntilEpoch: renewUntil } : {}),
  });
  const toConfirm = () => {
    if (!canContinue || !request) return;
    if (!fundsEpoch) {
      setFlow({ phase: 'confirm', confirming: { kind: 'plan', plan: planOf(request) }, err: null });
      return;
    }
    const answered = dryRun.current;
    if (!answered) return;
    // The epoch the dry run answered for, by number: 'current' or 'next' would name a later one after a boundary.
    const funds = { ...answered.request, epoch: answered.preview.epoch };
    setFlow({ phase: 'confirm', confirming: { kind: 'fund', request: funds, preview: answered.preview, plan: planOf(funds) }, err: null });
  };

  const confirm = async () => {
    if (flow.phase !== 'confirm') return;
    const { confirming } = flow;
    setFlow({ phase: 'sending', confirming });
    if (confirming.kind === 'plan') {
      try {
        await marketplaceApi.savePlan(confirming.plan);
      } catch (e) {
        setFlow({ phase: 'confirm', confirming, err: e });
        return;
      }
      setFlow({ phase: 'saved' });
      onDone();
      return;
    }
    let funded: FundedAnswer;
    try {
      funded = await marketplaceApi.fund(confirming.request);
    } catch (e) {
      setFlow({ phase: 'confirm', confirming, err: e });
      return;
    }
    try {
      await marketplaceApi.savePlan(confirming.plan);
    } catch (e) {
      setFlow({ phase: 'funded', confirming, funded, planErr: e, saving: false });
      return;
    }
    if (onboarding) setFlow({ phase: 'funded', confirming, funded, planErr: null, saving: false });
    else onDone();
  };
  // The funding went out: a retry saves the plan alone.
  const retryPlan = () => {
    if (flow.phase !== 'funded' || flow.saving) return;
    const done = flow;
    setFlow({ ...done, saving: true });
    marketplaceApi.savePlan(done.confirming.plan)
      .then(() => setFlow({ ...done, planErr: null, saving: false }), (e: unknown) => setFlow({ ...done, planErr: e, saving: false }));
  };

  const phase = flow.phase === 'compose' ? 'compose' : flow.phase === 'confirm' || flow.phase === 'sending' ? 'confirm' : 'done';
  return (
    <div className="mkt-flow" data-testid="mkt-fund-flow" data-phase={phase}>
      {onboarding && <ProgressSteps step={phase === 'done' ? 3 : 2} sub={flow.phase === 'sending' ? 'sending' : flow.phase === 'confirm' ? 'confirm' : null} />}
      {flow.phase === 'compose' && (
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
      {(flow.phase === 'confirm' || flow.phase === 'sending') && (
        <ConfirmGate catalog={catalog} funding={funding} confirming={flow.confirming}
          busy={flow.phase === 'sending'} err={flow.phase === 'confirm' ? flow.err : null}
          onConfirm={() => { void confirm(); }} onCancel={() => { setFlow({ phase: 'compose' }); setRound((r) => r + 1); }} />
      )}
      {flow.phase === 'funded' && (
        <>
          <div className="mkt-notice" role="status" data-testid="mkt-funded">
            <strong data-copy="flow.funded">{copy('flow.funded', { n: flow.funded.subscription?.epoch ?? flow.confirming.preview.epoch, trac: fmtTrac(flow.funded.subscription?.value ?? flow.confirming.preview.value) })}</strong>{' '}
            <span className="mkt-muted mkt-xs mkt-mono" data-copy="flow.tx">{copy('flow.tx', { tx: fmtHex(flow.funded.txHash), block: flow.funded.blockNumber })}</span>
          </div>
          {flow.planErr ? (
            <ErrorCard err={flow.planErr}>
              <span className="mkt-xs" data-testid="mkt-plan-unsaved" data-copy="flow.plan.failed">{copy('flow.plan.failed')}</span>
              <button type="button" className="mkt-btn" data-testid="mkt-plan-retry" data-copy="flow.plan.retry" onClick={retryPlan} disabled={flow.saving}>{copy('flow.plan.retry')}</button>
            </ErrorCard>
          ) : null}
          {onboarding
            ? <KeyStep budgetTrac={fmtTrac(flow.funded.subscription?.value ?? flow.confirming.preview.value)} onPlans={onDone} />
            : <div className="mkt-fork"><button type="button" className="mkt-btn" data-copy="ctl.done" onClick={onDone}>{copy('ctl.done')}</button></div>}
        </>
      )}
    </div>
  );
}
