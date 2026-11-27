// Compose, confirm, then a key: funding an epoch's subscription from the
// buyer wallet or an account, and saving the plan that renews it. Changing
// the plan while an epoch runs saves the plan alone; its next renewal funds
// it. The node sends the funding from its buyer wallet: no browser wallet,
// and nothing goes to a seller directly.
//
// From Confirm on, the confirmation belongs to the coordinator (fundings.ts):
// it sends the funding, settles one whose answer was lost, and saves the
// plan in confirmation order, whether or not this form is still on show. The
// form keeps its draft and shows what the coordinator holds for the
// confirmation it made.
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { copy } from '../copy.generated.js';
import { marketplaceApi } from '../api/client.js';
import type { CatalogAnswer, Funding, FundingRequest, PlanRequest, Source } from '../api/types.js';
import { fmtHex, fmtTrac } from '../amounts.js';
import { ErrorCard } from '../shared.js';
import { Composer, PreviewLine, fundingRequestOf, servicesOf, type Draft } from './Composer.js';
import { ConfirmGate } from './ConfirmGate.js';
import { fundings, type Confirmed } from './fundings.js';
import { KeyStep } from './KeyStep.js';
import type { Confirming } from './model.js';
import { ProgressSteps } from './ProgressSteps.js';
import { usePreview } from './usePreview.js';

const sourceName = (s: Source) => (s.kind === 'account' ? copy('source.account', { id: s.accountId }) : copy('source.wallet'));

/** A funding whose outcome is unknown: what the epoch's subscription shows, and the one step that allows. */
export function FundingUnknown({ id, held, onBack, onDone }: {
  id: number; held: Extract<Confirmed, { kind: 'unknown' }>; onBack: () => void; onDone: () => void;
}): React.ReactElement {
  const { read, err } = held;
  const n = held.confirming.request.epoch;
  const found = read.state === 'other' ? read.subscription : null;
  return (
    <div className="ds-card mkt-card mkt-gate" data-testid="mkt-funding-unknown" data-state={read.state}>
      <p className="mkt-sec mkt-sm" data-copy="flow.unknown">{copy('flow.unknown', { n })}</p>
      <div className="mkt-notice" role="status">
        <span data-copy={`flow.unknown.${read.state}`}>
          {copy(`flow.unknown.${read.state}`, { n, value: found ? fmtTrac(found.value) : '', source: found ? sourceName(found.source) : '' })}
        </span>
        {read.state === 'unread' && <ErrorCard err={read.err} />}
        {err ? <ErrorCard err={err} /> : null}
      </div>
      <div className="mkt-fork mkt-gate-actions">
        {read.state === 'absent' && (
          <>
            <button type="button" className="ds-btn" data-copy="gate.cancel" onClick={onBack}>{copy('gate.cancel')}</button>
            <button type="button" className="ds-btn ds-primary" data-testid="mkt-funding-retry" data-copy="ctl.retry" onClick={() => fundings.retryFunding(id)}>{copy('ctl.retry')}</button>
          </>
        )}
        {read.state === 'unread' && (
          <button type="button" className="ds-btn ds-primary" data-testid="mkt-funding-check" data-copy="flow.unknown.again" onClick={() => fundings.readAgain(id)}>{copy('flow.unknown.again')}</button>
        )}
        {read.state === 'other' && <button type="button" className="ds-btn" data-testid="mkt-funding-done" data-copy="ctl.done" onClick={onDone}>{copy('ctl.done')}</button>}
      </div>
    </div>
  );
}

/**
 * A confirmation that waits for the user with no form on show for it, as one
 * whose form another flow replaced or that a tab change took away: a funding
 * of unknown outcome, or a plan that was not saved, with Retry, which saves
 * the plan alone.
 */
export function WaitingConfirmation({ id, onDone }: { id: number; onDone: () => void }): React.ReactElement | null {
  const held = useSyncExternalStore(fundings.subscribe, () => fundings.held(id));
  if (held?.kind === 'unknown') return <FundingUnknown id={id} held={held} onBack={() => fundings.dismiss(id)} onDone={() => { fundings.dismiss(id); onDone(); }} />;
  if (held?.kind !== 'plan' || held.save !== 'failed') return null;
  const preview = held.confirming.kind === 'fund' ? held.confirming.preview : null;
  const subscription = held.funded?.subscription ?? null;
  const unsaved = held.funded ? 'flow.plan.failed' : 'flow.plan.unsaved';
  return (
    <div className="ds-card mkt-card" data-testid="mkt-plan-waiting" data-confirmation={id}>
      {held.funded && (
        <strong data-copy="flow.funded">{copy('flow.funded', { n: subscription?.epoch ?? preview?.epoch ?? '—', trac: fmtTrac(subscription?.value ?? preview?.value ?? '0') })}</strong>
      )}
      <ErrorCard err={held.err}>
        <span className="mkt-xs" data-testid="mkt-plan-unsaved" data-copy={unsaved}>{copy(unsaved)}</span>
        <button type="button" className="ds-btn" data-testid="mkt-plan-retry" data-copy="flow.plan.retry" onClick={() => fundings.retryPlan(id)}>{copy('flow.plan.retry')}</button>
      </ErrorCard>
    </div>
  );
}

/** The form's own part: composing, or the confirmation before Confirm; from then on, the coordinator's confirmation, by its id. */
type Phase = { kind: 'compose' } | { kind: 'confirm'; confirming: Confirming } | { kind: 'held'; id: number };

export function FundFlow({ catalog, funding, initial, fundsEpoch, onboarding, onDone, onCancel, onConfirmed, endsAt }: {
  catalog: CatalogAnswer;
  funding: Funding | null;
  initial: Draft;
  fundsEpoch: boolean;
  onboarding: boolean;
  onDone: () => void;
  onCancel?: () => void;
  /** The confirmation this form made, once the coordinator holds it. */
  onConfirmed?: (id: number) => void;
  endsAt: number | null;
}): React.ReactElement {
  const [draft, setDraft] = useState<Draft>(initial);
  const [phase, setPhase] = useState<Phase>({ kind: 'compose' });
  // Back from the confirmation, the draft is asked about afresh: an epoch may have ended since its last dry run.
  const [round, setRound] = useState(0);
  const id = phase.kind === 'held' ? phase.id : null;
  const held = useSyncExternalStore(fundings.subscribe, () => fundings.held(id));
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
      setPhase({ kind: 'confirm', confirming: { kind: 'plan', plan: planOf(request) } });
      return;
    }
    const answered = dryRun.current;
    if (!answered) return;
    // The epoch the dry run answered for, by number: 'current' or 'next' would name a later one after a boundary.
    const funds = { ...answered.request, epoch: answered.preview.epoch };
    setPhase({ kind: 'confirm', confirming: { kind: 'fund', request: funds, preview: answered.preview, plan: planOf(funds) } });
  };

  /** Hand the confirmation to the coordinator; one it refused before is done with. */
  const confirm = (confirming: Confirming) => {
    if (id !== null) fundings.dismiss(id);
    const next = fundings.confirm(confirming);
    setPhase({ kind: 'held', id: next });
    onConfirmed?.(next);
  };
  const backToCompose = () => {
    if (id !== null) fundings.dismiss(id);
    setPhase({ kind: 'compose' });
    setRound((r) => r + 1);
  };

  // Done once the plan is saved, but for an onboarding funding, which stays for its key step.
  const done = useRef(onDone);
  done.current = onDone;
  const saved = held?.kind === 'plan' && held.save === 'saved';
  const staysForKey = onboarding && held?.confirming.kind === 'fund';
  useEffect(() => { if (saved && !staysForKey) done.current(); }, [saved, staysForKey]);

  // The confirmation on show: the form's own before Confirm, then the coordinator's while it is sent, refused, or a plan alone not saved.
  const gate: { confirming: Confirming; busy: boolean; err: unknown } | null = phase.kind === 'confirm' ? { confirming: phase.confirming, busy: false, err: null }
    : held?.kind === 'funding' ? { confirming: held.confirming, busy: true, err: null }
      : held?.kind === 'refused' ? { confirming: held.confirming, busy: false, err: held.err }
        : held?.kind === 'plan' && !held.funded && !saved ? { confirming: held.confirming, busy: held.save === 'saving', err: held.err }
          : null;
  const funded = held?.kind === 'plan' && held.funded ? held : null;
  const preview = funded?.confirming.kind === 'fund' ? funded.confirming.preview : null;
  const composing = phase.kind === 'compose' || (phase.kind === 'held' && !held);
  const view = composing ? 'compose' : held?.kind === 'unknown' ? 'unknown' : gate ? 'confirm' : 'done';
  return (
    <div className="mkt-flow" data-testid="mkt-fund-flow" data-phase={view}>
      {onboarding && <ProgressSteps step={view === 'done' ? 3 : 2} sub={gate?.busy || view === 'unknown' ? 'sending' : gate ? 'confirm' : null} />}
      {composing && (
        <>
          <Composer catalog={catalog} funding={funding} draft={draft} onChange={setDraft} fundsEpoch={fundsEpoch} endsAt={endsAt} />
          <div className="ds-card mkt-card" data-testid="mkt-compose-actions">
            {fundsEpoch && <PreviewLine preview={shown} err={dryRun.err} busy={dryRun.busy} />}
            <div className="mkt-fork">
              {onCancel && <button type="button" className="ds-btn" data-copy="gate.cancel" onClick={onCancel}>{copy('gate.cancel')}</button>}
              <button type="button" className="ds-btn ds-primary" data-testid="mkt-compose-continue" data-copy="composer.continue"
                disabled={!canContinue} title={continueKey ? copy(continueKey) : fundsEpoch && dryRun.busy ? copy('composer.preview.updating') : undefined}
                onClick={toConfirm}>{copy('composer.continue')}</button>
              {continueKey && <span className="mkt-muted mkt-xs" data-copy={continueKey}>{copy(continueKey)}</span>}
            </div>
          </div>
        </>
      )}
      {gate && (
        <ConfirmGate catalog={catalog} funding={funding} confirming={gate.confirming} busy={gate.busy} err={gate.err}
          onConfirm={() => confirm(gate.confirming)} onCancel={backToCompose} />
      )}
      {held?.kind === 'unknown' && id !== null && (
        <FundingUnknown id={id} held={held} onBack={backToCompose} onDone={() => { fundings.dismiss(id); onDone(); }} />
      )}
      {funded && funded.funded && id !== null && (
        <>
          <div className="mkt-notice" role="status" data-testid="mkt-funded">
            <strong data-copy="flow.funded">{copy('flow.funded', { n: funded.funded.subscription?.epoch ?? preview?.epoch ?? '—', trac: fmtTrac(funded.funded.subscription?.value ?? preview?.value ?? '0') })}</strong>{' '}
            {funded.funded.tx && <span className="mkt-muted mkt-xs mkt-mono" data-copy="flow.tx">{copy('flow.tx', { tx: fmtHex(funded.funded.tx.txHash), block: funded.funded.tx.blockNumber })}</span>}
          </div>
          {funded.save === 'failed' ? (
            <ErrorCard err={funded.err}>
              <span className="mkt-xs" data-testid="mkt-plan-unsaved" data-copy="flow.plan.failed">{copy('flow.plan.failed')}</span>
              <button type="button" className="ds-btn" data-testid="mkt-plan-retry" data-copy="flow.plan.retry" onClick={() => fundings.retryPlan(id)}>{copy('flow.plan.retry')}</button>
            </ErrorCard>
          ) : null}
          {onboarding
            ? <KeyStep budgetTrac={fmtTrac(funded.funded.subscription?.value ?? preview?.value ?? '0')} onPlans={onDone} />
            : <div className="mkt-fork"><button type="button" className="ds-btn" data-copy="ctl.done" onClick={onDone}>{copy('ctl.done')}</button></div>}
        </>
      )}
    </div>
  );
}
