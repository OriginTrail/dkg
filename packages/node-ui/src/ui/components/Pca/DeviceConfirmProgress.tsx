import React from 'react';

export type DeviceConfirmStepState = 'pending' | 'active' | 'submitted' | 'confirmed' | 'failed' | 'aborted';

export interface DeviceConfirmStep {
  id: string;
  label: string;
  state: DeviceConfirmStepState;
  txHash?: string;
  error?: string;
}

function glyphFor(state: DeviceConfirmStepState): string {
  if (state === 'confirmed') return 'OK';
  if (state === 'submitted') return 'TX';
  if (state === 'failed') return 'ERR';
  if (state === 'aborted') return 'STOP';
  if (state === 'active') return '...';
  return '-';
}

/**
 * Generic device-confirmation progress rows for client-signed PCA actions.
 * Failure/abort rows are assertive alerts; normal progress is polite status.
 */
export function DeviceConfirmProgress({
  steps,
  currentLabel,
  blockExplorerUrl,
}: {
  steps: DeviceConfirmStep[];
  currentLabel?: string;
  blockExplorerUrl?: string | null;
}) {
  const hasFailure = steps.some((s) => s.state === 'failed' || s.state === 'aborted');
  return (
    <div
      className="v10-pca-device-progress"
      role={hasFailure ? 'alert' : 'status'}
      aria-live={hasFailure ? 'assertive' : 'polite'}
    >
      <p className="v10-pca-device-progress-title">
        {currentLabel ?? 'Confirm on your device'}
      </p>
      <p className="v10-pca-device-progress-note">
        Verify the amount and contract address on the device before approving.
      </p>
      <ol className="v10-pca-device-progress-list">
        {steps.map((step) => {
          const txUrl = step.txHash && blockExplorerUrl
            ? `${blockExplorerUrl.replace(/\/$/, '')}/tx/${step.txHash}`
            : null;
          return (
            <li key={step.id} className="v10-pca-device-progress-row" data-state={step.state}>
              <span className="v10-pca-device-progress-glyph">{glyphFor(step.state)}</span>
              <span>{step.label}</span>
              {step.txHash && (
                txUrl ? (
                  <a href={txUrl} target="_blank" rel="noreferrer" className="v10-pca-device-progress-tx">
                    tx
                  </a>
                ) : (
                  <code className="v10-pca-device-progress-tx">{step.txHash}</code>
                )
              )}
              {step.error && <span className="v10-pca-device-progress-error">{step.error}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
