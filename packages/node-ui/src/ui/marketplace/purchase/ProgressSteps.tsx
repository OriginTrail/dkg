// The three-step indicator (Subscribe · Confirm · Copy your key), with the confirm step's sub-steps (sign · pay · confirmations ·
// enroll) named under it so a resumed purchase says exactly where it is.
import React from 'react';
import { copy } from '../copy.generated.js';

export type ConfirmSub = 'confirm' | 'sign' | 'pay' | 'confirming' | 'enroll' | null;

const SUB_KEY: Record<Exclude<ConfirmSub, null>, string> = {
  confirm: 'onboard.consent.title',
  sign: 'purchase.step.sign',
  pay: 'purchase.step.pay',
  confirming: 'purchase.step.confirming',
  enroll: 'purchase.step.enroll',
};

export function ProgressSteps({ step, sub = null }: { step: 1 | 2 | 3; sub?: ConfirmSub }): React.ReactElement {
  const steps: Array<{ n: 1 | 2 | 3; key: string }> = [
    { n: 1, key: 'purchase.step.subscribe' },
    { n: 2, key: 'purchase.step.confirm' },
    { n: 3, key: 'purchase.step.key' },
  ];
  return (
    <ol className="mkt-steps" data-testid="mkt-progress-steps" data-step={step}>
      {steps.map((s) => {
        const state = s.n < step ? 'done' : s.n === step ? 'now' : 'todo';
        return (
          <li key={s.n} className={`mkt-step ${state}`} aria-current={state === 'now' ? 'step' : undefined}>
            <span className="mkt-step-n" aria-hidden>{state === 'done' ? '✓' : s.n}</span>
            <span data-copy={s.key}>{copy(s.key)}</span>
            {s.n === 2 && state === 'now' && sub && (
              <span className="mkt-step-sub mkt-muted mkt-xs" data-copy={SUB_KEY[sub]}>{copy(SUB_KEY[sub])}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
