// The three steps to a first answer (fund the buyer wallet or add it to an
// account, compose a plan, mint a key), with the compose step's one
// confirmation named under it while it is open.
import React from 'react';
import { copy, type CopyKey } from '../copy.generated.js';

export type StepSub = 'confirm' | 'sending' | null;

const SUB_KEY: Record<Exclude<StepSub, null>, CopyKey> = {
  confirm: 'steps.sub.confirm',
  sending: 'steps.sub.sending',
};

export function ProgressSteps({ step, sub = null }: { step: 1 | 2 | 3; sub?: StepSub }): React.ReactElement {
  const steps: Array<{ n: 1 | 2 | 3; key: CopyKey }> = [
    { n: 1, key: 'steps.fund' },
    { n: 2, key: 'steps.compose' },
    { n: 3, key: 'steps.key' },
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
