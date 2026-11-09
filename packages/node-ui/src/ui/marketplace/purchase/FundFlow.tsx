// Compose, confirm, then a key: funding an epoch's subscription from the
// buyer wallet or an account, and saving the plan that renews it. Changing
// the plan while an epoch runs saves the plan alone; its next renewal funds
// it. The node sends the funding from its buyer wallet: no browser wallet,
// and nothing goes to a seller directly.
//
// The contracts fund one subscription per buyer and epoch, so a funding whose
// answer is lost is never simply sent again: a repeat would be refused as
// already funded, and the plan would not be saved. What the epoch's
// subscription shows decides instead. Funded as confirmed, the plan is saved
// and nothing is funded again; not funded, Retry sends the same funding;
// funded on other terms, the flow says so and saves no plan.
//
// A funding's answer can come back after another flow replaced this one: the
// funding is kept, and its plan is still saved, but only in the order of the
// confirmations (planSaves.ts), so it never writes over a plan confirmed
// later. A replaced flow closes nothing: what is on show now is another's.
import React, { useEffect, useRef, useState } from 'react';
import { copy } from '../copy.generated.js';
import { isMarketplaceError, marketplaceApi } from '../api/client.js';
import type { CatalogAnswer, Funding, FundingRequest, PlanRequest, Source, Subscription, Tx } from '../api/types.js';
import { fmtHex, fmtTrac } from '../amounts.js';
import { ErrorCard } from '../shared.js';
import { Composer, PreviewLine, fundingRequestOf, servicesOf, type Draft } from './Composer.js';
import { ConfirmGate } from './ConfirmGate.js';
import { KeyStep } from './KeyStep.js';
import type { Confirming, FundConfirming } from './model.js';
import { confirmationTicket, savePlanFor } from './planSaves.js';
import { ProgressSteps } from './ProgressSteps.js';
import { usePreview } from './usePreview.js';

/** An epoch funded: its subscription, once the node shows it, and the transaction, when the funding's answer came. */
interface Funded { subscription: Subscription | null; tx: Tx | null }

/** What the epoch's subscription shows of a funding whose outcome is unknown. Funded as confirmed, the flow moves on. */
type FundingRead =
  | { state: 'checking' }
  /** No subscription funds the epoch: the funding did not land. */
  | { state: 'absent' }
  /** One does, on other terms than the confirmation's. */
  | { state: 'other'; subscription: Subscription }
  | { state: 'unread'; err: unknown };

/**
 * The flow, one phase at a time. A funding goes out once: once it is `funded`, only the plan save can be sent again.
 * `ticket` is the confirmation's place among plan saves, taken when Confirm was pressed.
 */
type Flow =
  | { phase: 'compose' }
  /** The confirmation, with the failure of the last Confirm, if any. */
  | { phase: 'confirm'; confirming: Confirming; err: unknown }
  /** Confirm sent: the funding and then the plan, or the plan alone. */
  | { phase: 'sending'; confirming: Confirming }
  /** The funding went out, but no answer says whether it landed (`err`): the epoch's subscription is read to tell. */
  | { phase: 'unknown'; confirming: FundConfirming; ticket: number; err: unknown; read: FundingRead }
  /** The epoch is funded. The plan is saved unless `planErr`; `saving` while it is sent again. */
  | { phase: 'funded'; confirming: FundConfirming; ticket: number; funded: Funded; planErr: unknown; saving: boolean }
  /** The plan alone is saved, and the flow is done. */
  | { phase: 'saved' };

/** The refusals the node gives with a 5xx before it sends anything; any other 5xx may come after the funding went out. */
const REFUSED_BEFORE_SENDING = new Set(['MarketplaceOff', 'QueryInferencePaused', 'QueryInferenceNotActive']);

/**
 * Whether a funding that failed may have landed all the same: no answer, a
 * success whose answer cannot be read, or a failure the node does not explain.
 * A refusal (a 4xx, or one of the 5xx above) comes before anything is sent.
 */
function mayHaveLanded(e: unknown): boolean {
  if (!isMarketplaceError(e)) return true;
  if (e.status === 0 || e.code === 'UnreadableAnswer') return true;
  return e.status >= 500 && !REFUSED_BEFORE_SENDING.has(e.code);
}

/**
 * Whether `s` is the subscription `request` funds: its epoch and source, and
 * each budget's service, class, value and cap. A budget whose class the node
 * does not name matches on the rest.
 */
function fundedAsConfirmed(s: Subscription, request: FundConfirming['request']): boolean {
  const asked = request.source;
  if (s.epoch !== request.epoch || s.source.kind !== asked.kind) return false;
  if (s.source.kind === 'account' && asked.kind === 'account' && s.source.accountId !== asked.accountId) return false;
  return s.budgets.length === request.services.length && request.services.every((r) => {
    const b = s.budgets.find((x) => x.serviceId.toLowerCase() === r.serviceId.toLowerCase());
    return !!b && (b.serviceClass === undefined || b.serviceClass === r.serviceClass)
      && BigInt(b.value) === BigInt(r.value) && BigInt(b.maxPricePerUnit) === BigInt(r.maxPricePerUnit);
  });
}

const sourceName = (s: Source) => (s.kind === 'account' ? copy('source.account', { id: s.accountId }) : copy('source.wallet'));

/** A funding whose outcome is unknown: what the epoch's subscription shows, and the one step that allows. */
function FundingUnknown({ flow, onRetry, onReadAgain, onBack, onDone }: {
  flow: Extract<Flow, { phase: 'unknown' }>; onRetry: () => void; onReadAgain: () => void; onBack: () => void; onDone: () => void;
}): React.ReactElement {
  const { read, err } = flow;
  const n = flow.confirming.request.epoch;
  const found = read.state === 'other' ? read.subscription : null;
  return (
    <div className="mkt-card mkt-gate" data-testid="mkt-funding-unknown" data-state={read.state}>
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
            <button type="button" className="mkt-btn" data-copy="gate.cancel" onClick={onBack}>{copy('gate.cancel')}</button>
            <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-funding-retry" data-copy="ctl.retry" onClick={onRetry}>{copy('ctl.retry')}</button>
          </>
        )}
        {read.state === 'unread' && (
          <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-funding-check" data-copy="flow.unknown.again" onClick={onReadAgain}>{copy('flow.unknown.again')}</button>
        )}
        {read.state === 'other' && <button type="button" className="mkt-btn" data-testid="mkt-funding-done" data-copy="ctl.done" onClick={onDone}>{copy('ctl.done')}</button>}
      </div>
    </div>
  );
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

  // Whether this flow is still on show: a funding's answer can come back after another flow replaced it.
  const open = useRef(true);
  useEffect(() => { open.current = true; return () => { open.current = false; }; }, []);
  /** Done, while on show; a replaced flow leaves alone the one that replaced it. */
  const finish = () => { if (open.current) onDone(); };

  /** The epoch is funded: save the plan that renews it, unless a plan confirmed later was saved first. */
  const savePlanAfter = async (confirming: FundConfirming, ticket: number, funded: Funded) => {
    try {
      await savePlanFor(ticket, confirming.plan);
    } catch (e) {
      setFlow({ phase: 'funded', confirming, ticket, funded, planErr: e, saving: false });
      return;
    }
    if (onboarding) setFlow({ phase: 'funded', confirming, ticket, funded, planErr: null, saving: false });
    else finish();
  };

  /** Read the epoch's subscription after a funding whose outcome is unknown, and go on as it says. */
  const settle = async (confirming: FundConfirming, ticket: number, err: unknown) => {
    setFlow({ phase: 'unknown', confirming, ticket, err, read: { state: 'checking' } });
    const { epoch } = confirming.request;
    let read: FundingRead;
    try {
      const subscription = (await marketplaceApi.subscriptions(epoch)).subscriptions.find((s) => s.epoch === epoch) ?? null;
      if (subscription && fundedAsConfirmed(subscription, confirming.request)) {
        // It landed as confirmed: nothing is funded again, and the plan follows.
        setFlow({ phase: 'sending', confirming });
        await savePlanAfter(confirming, ticket, { subscription, tx: null });
        return;
      }
      read = subscription ? { state: 'other', subscription } : { state: 'absent' };
    } catch (e) {
      read = { state: 'unread', err: e };
    }
    setFlow({ phase: 'unknown', confirming, ticket, err, read });
  };

  /** Send the confirmed funding, or, on `retry`, send it again once the epoch's subscription showed it had not landed. */
  const fund = async (confirming: FundConfirming, ticket: number, retry: boolean) => {
    setFlow({ phase: 'sending', confirming });
    let answer;
    try {
      answer = await marketplaceApi.fund(confirming.request);
    } catch (e) {
      // A lost answer, or a repeat refused because the epoch is funded now: whether the funding landed is read, not assumed.
      if (mayHaveLanded(e) || (retry && isMarketplaceError(e) && e.code === 'SubscriptionAlreadyFunded')) await settle(confirming, ticket, e);
      else setFlow({ phase: 'confirm', confirming, err: e });
      return;
    }
    await savePlanAfter(confirming, ticket, { subscription: answer.subscription, tx: { txHash: answer.txHash, blockNumber: answer.blockNumber } });
  };

  const confirm = async () => {
    if (flow.phase !== 'confirm') return;
    const { confirming } = flow;
    const ticket = confirmationTicket();
    if (confirming.kind === 'fund') {
      await fund(confirming, ticket, false);
      return;
    }
    setFlow({ phase: 'sending', confirming });
    try {
      await savePlanFor(ticket, confirming.plan);
    } catch (e) {
      setFlow({ phase: 'confirm', confirming, err: e });
      return;
    }
    setFlow({ phase: 'saved' });
    finish();
  };
  const retryFunding = () => { if (flow.phase === 'unknown' && flow.read.state === 'absent') void fund(flow.confirming, flow.ticket, true); };
  const readAgain = () => { if (flow.phase === 'unknown' && flow.read.state !== 'checking') void settle(flow.confirming, flow.ticket, flow.err); };
  const backToCompose = () => { setFlow({ phase: 'compose' }); setRound((r) => r + 1); };
  // The funding went out: a retry saves the plan alone.
  const retryPlan = () => {
    if (flow.phase !== 'funded' || flow.saving) return;
    const done = flow;
    setFlow({ ...done, saving: true });
    savePlanFor(done.ticket, done.confirming.plan)
      .then(() => setFlow({ ...done, planErr: null, saving: false }), (e: unknown) => setFlow({ ...done, planErr: e, saving: false }));
  };

  const phase = flow.phase === 'compose' || flow.phase === 'unknown' ? flow.phase : flow.phase === 'confirm' || flow.phase === 'sending' ? 'confirm' : 'done';
  return (
    <div className="mkt-flow" data-testid="mkt-fund-flow" data-phase={phase}>
      {onboarding && <ProgressSteps step={phase === 'done' ? 3 : 2} sub={flow.phase === 'sending' || flow.phase === 'unknown' ? 'sending' : flow.phase === 'confirm' ? 'confirm' : null} />}
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
          onConfirm={() => { void confirm(); }} onCancel={backToCompose} />
      )}
      {flow.phase === 'unknown' && <FundingUnknown flow={flow} onRetry={retryFunding} onReadAgain={readAgain} onBack={backToCompose} onDone={onDone} />}
      {flow.phase === 'funded' && (
        <>
          <div className="mkt-notice" role="status" data-testid="mkt-funded">
            <strong data-copy="flow.funded">{copy('flow.funded', { n: flow.funded.subscription?.epoch ?? flow.confirming.preview.epoch, trac: fmtTrac(flow.funded.subscription?.value ?? flow.confirming.preview.value) })}</strong>{' '}
            {flow.funded.tx && <span className="mkt-muted mkt-xs mkt-mono" data-copy="flow.tx">{copy('flow.tx', { tx: fmtHex(flow.funded.tx.txHash), block: flow.funded.tx.blockNumber })}</span>}
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
