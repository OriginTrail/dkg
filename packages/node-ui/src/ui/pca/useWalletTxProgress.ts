import { useRef, useState } from 'react';
import type { DeviceConfirmStep } from '../components/Pca/index.js';
import { describeWalletTxError } from '../web3/walletTxError.js';
import type { WalletTxProgressEvent } from '../web3/walletOwnerActionSubmitter.js';

/**
 * The device-confirm progress layer shared by every browser-wallet-signed PCA
 * owner action (Create PCA, top-up, remove wallet). It owns the two output
 * containers fed to `<DeviceConfirmProgress>` — `steps: DeviceConfirmStep[]` and
 * `currentLabel` — plus the single approve -> action -> confirm reducer that
 * transitions them from the submitter's `WalletTxProgressEvent`s.
 *
 * The hook OWNS the step ids (`approve?` / `action` / `confirm`): callers describe
 * the flow with a typed {@link WalletTxFlow} descriptor, not a loose array of
 * `DeviceConfirmStep`s with magic ids — so there is no hidden id convention to get
 * wrong (a missing/mis-named `action` step can't slip past the type checker into a
 * runtime `undefined` deref). The `approve` step is present for allowance-then-action
 * flows (topup / create) and absent for the single-signature remove flow. Labels +
 * the action-step error formatter are injected so each caller keeps its exact copy
 * (asserted verbatim in tests).
 *
 * `variant` (topup/remove/create) is held in a ref, not state, so the reducer
 * closure always reads the latest action without being in a dependency array.
 */

const DEFAULT_APPROVE_STEP_LABEL = 'Approve exact TRAC allowance';
const DEFAULT_CONFIRM_STEP_LABEL = 'Confirm on-chain receipt';

/**
 * A canonical device-confirm flow. The hook renders it to the fixed step ids
 * `approve?` -> `action` -> `confirm`; the caller only names the flow + labels.
 */
export interface WalletTxFlow {
  /** Whether an allowance-approval step precedes the action (topup/create) or not (remove). */
  requiresApproval: boolean;
  /** Approve-step label; defaults to "Approve exact TRAC allowance". */
  approveLabel?: string;
  /** Action-step label — e.g. "Sign top-up" / "Sign remove wallet" / "Sign Create PCA". */
  actionLabel: string;
  /** Confirm-step label; defaults to "Confirm on-chain receipt". */
  confirmLabel?: string;
}

export interface WalletTxProgressLabels<V extends string = string> {
  /** Resting label before the sequence starts (also after `reset`). */
  idle: string;
  /** Approve step active/submitted — "Confirm on your device (1 of 2): approve TRAC". */
  approveActive: string;
  /** Approve step skipped/confirmed — allowance ready, continue to the action. */
  approveReady: string;
  /** Action step active. Constant, or a function of the variant (topup vs remove copy). */
  actionActive: string | ((variant?: V) => string);
  /** Action step submitted — waiting for the on-chain receipt. */
  submitted: string;
  /** Action step confirmed on-chain. */
  confirmed: string;
  /** Any failure (approve or action). */
  failed: string;
}

export interface UseWalletTxProgressOptions<V extends string = string> {
  labels: WalletTxProgressLabels<V>;
  /** The canonical flow for a run; the hook builds the `approve?`/`action`/`confirm` steps + ids. */
  flow: (variant?: V) => WalletTxFlow;
  /** Approve-step failure copy. Defaults to `describeWalletTxError(err, 'approve')`. */
  describeApproveError?: (err: unknown) => string;
  /** Action-step failure copy. Defaults to `describeWalletTxError(err, 'action')`. */
  describeActionError?: (err: unknown, variant?: V) => string;
}

export interface WalletTxProgress<V extends string = string> {
  steps: DeviceConfirmStep[];
  currentLabel: string;
  /** Feed a submitter progress event into the approve -> action -> confirm reducer. */
  onProgress: (event: WalletTxProgressEvent) => void;
  /** Seed the step template + initial label for a wallet-signed run. */
  begin: (variant?: V) => void;
  /** Clear the progress (daemon/hot path renders none). */
  reset: () => void;
  /** The initial all-pending steps for a variant — for a pre-run render fallback. */
  initialSteps: (variant?: V) => DeviceConfirmStep[];
}

/** Render a flow descriptor to the canonical `approve?` -> `action` -> `confirm` steps. */
function buildSteps(flow: WalletTxFlow): DeviceConfirmStep[] {
  const steps: DeviceConfirmStep[] = [];
  if (flow.requiresApproval) {
    steps.push({ id: 'approve', label: flow.approveLabel ?? DEFAULT_APPROVE_STEP_LABEL, state: 'pending' });
  }
  steps.push({ id: 'action', label: flow.actionLabel, state: 'pending' });
  steps.push({ id: 'confirm', label: flow.confirmLabel ?? DEFAULT_CONFIRM_STEP_LABEL, state: 'pending' });
  return steps;
}

export function useWalletTxProgress<V extends string = string>({
  labels,
  flow,
  describeApproveError,
  describeActionError,
}: UseWalletTxProgressOptions<V>): WalletTxProgress<V> {
  const variantRef = useRef<V | undefined>(undefined);
  const [steps, setSteps] = useState<DeviceConfirmStep[]>([]);
  const [currentLabel, setCurrentLabel] = useState<string>(labels.idle);

  const initialSteps = (variant?: V): DeviceConfirmStep[] => buildSteps(flow(variant));
  const approveErrorOf = describeApproveError ?? ((err: unknown) => describeWalletTxError(err, 'approve').message);
  const actionErrorOf =
    describeActionError ?? ((err: unknown) => describeWalletTxError(err, 'action').message);
  const actionActiveLabel = (variant?: V): string =>
    typeof labels.actionActive === 'function' ? labels.actionActive(variant) : labels.actionActive;

  const onProgress = (event: WalletTxProgressEvent) => {
    const variant = variantRef.current;
    setCurrentLabel(() => {
      if (event.step === 'approve') {
        if (event.state === 'skipped' || event.state === 'confirmed') return labels.approveReady;
        if (event.state === 'failed') return labels.failed;
        return labels.approveActive;
      }
      if (event.state === 'active') return actionActiveLabel(variant);
      if (event.state === 'submitted') return labels.submitted;
      if (event.state === 'confirmed') return labels.confirmed;
      return labels.failed;
    });
    setSteps((prev) => {
      const next = (prev.length ? prev : initialSteps(variant)).map((s) => ({ ...s }));
      const approve = next.find((s) => s.id === 'approve');
      const actionStep = next.find((s) => s.id === 'action')!;
      const confirm = next.find((s) => s.id === 'confirm')!;
      if (event.step === 'approve') {
        if (!approve) return next;
        if (event.state === 'skipped') {
          approve.state = 'confirmed';
          approve.label = 'TRAC allowance already sufficient';
        } else if (event.state === 'active' || event.state === 'submitted') {
          approve.state = 'active';
          approve.txHash = event.txHash;
        } else if (event.state === 'confirmed') {
          approve.state = 'confirmed';
          approve.txHash = event.txHash;
        } else if (event.state === 'failed') {
          approve.state = 'failed';
          approve.txHash = event.txHash;
          approve.error = approveErrorOf(event.error);
        }
        return next;
      }
      if (event.state === 'active') {
        if (approve?.state === 'pending') approve.state = 'confirmed';
        actionStep.state = 'active';
      } else if (event.state === 'submitted') {
        if (approve?.state === 'pending') approve.state = 'confirmed';
        actionStep.state = 'confirmed';
        actionStep.txHash = event.txHash;
        confirm.state = 'active';
      } else if (event.state === 'confirmed') {
        if (approve?.state === 'pending') approve.state = 'confirmed';
        actionStep.state = 'confirmed';
        actionStep.txHash = event.txHash;
        confirm.state = 'confirmed';
        confirm.txHash = event.txHash;
      } else if (event.state === 'failed') {
        actionStep.state = 'failed';
        actionStep.txHash = event.txHash;
        actionStep.error = actionErrorOf(event.error, variant);
      }
      return next;
    });
  };

  const begin = (variant?: V) => {
    variantRef.current = variant;
    const initial = initialSteps(variant);
    setSteps(initial);
    const hasApprove = initial.some((s) => s.id === 'approve');
    setCurrentLabel(hasApprove ? labels.approveActive : actionActiveLabel(variant));
  };

  const reset = () => {
    variantRef.current = undefined;
    setSteps([]);
    setCurrentLabel(labels.idle);
  };

  return { steps, currentLabel, onProgress, begin, reset, initialSteps };
}
