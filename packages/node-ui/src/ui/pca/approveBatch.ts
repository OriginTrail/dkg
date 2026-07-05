// Approve-publishing-wallets BATCH MACHINE (extracted from ApproveWalletsModal).
//
// Three seams, all financial-correctness-critical (see the #9 / N5 / stranded /
// sponsor-vs-dead-sponsor invariants below):
//  (A) `approveBatchReducer` — the pure display-state transitions (replaces the
//      9 batch useStates the modal used to hold).
//  (B) `selectCounts` / `selectApprovedWallets` — pure selectors over {order,rows}.
//      #9 lives here: `confirmed` (chain re-read) is kept SEPARATE from `submitted`.
//  (C) `runApproveBatch` — the sequential per-row write loop + the ordered error
//      taxonomy, pure of React: it awaits each write in order, checks `shouldStop`
//      only at the loop top, and emits reducer actions via the injected `dispatch`.
//
// The modal now only owns input selection + render; it assembles `deps` from the
// owner-action submitters and awaits `runApproveBatch`.

import { HttpError } from '../http.js';
import type { PcaAddAgentResult, PcaErrorInfo, PcaProbedKey } from '../pca-api.js';
import {
  describeWalletTxError,
  WalletReceiptRevertedError,
  WalletReceiptWaitError,
  WalletTxStepError,
} from '../web3/walletTxError.js';
import {
  WalletOwnerActionAbortError,
  WalletOwnerActionUnavailableError,
} from '../web3/walletOwnerActionSubmitter.js';
import type { DeviceConfirmStep, WalletRowTone } from '../components/Pca/index.js';
import type {
  SelfCoverageAction,
  SignableOwner,
  SignableOwnerKind,
  WalletBinding,
} from './walletBinding.js';

export type RowStatus =
  | 'pending' | 'approved' | 'submitted' | 'skipped' | 'sponsored' | 'stranded'
  | 'conflict' | 'cap' | 'error' | 'aborted' | 'unverified';
export interface Row {
  address: string;
  status: RowStatus;
  message?: string;
  txHash?: string;
}

export const ROW_LABEL: Record<RowStatus, string> = {
  pending: 'approving…',
  approved: 'approved on-chain',
  submitted: 'submitted — verify',
  skipped: 'already approved here (skipped)',
  // Self-coverage — bound to a sponsor's PCA; intentionally left there (already discounted
  // free), NOT moved. Distinct from 'skipped' (= already approved HERE).
  sponsored: 'left on another PCA (already discounted)',
  // Deregistered from the old PCA but the re-register failed: currently uncovered, recoverable.
  stranded: 'removed from the old PCA, not yet on the new one — retry to finish',
  conflict: 'on another PCA',
  cap: 'cap reached',
  error: 'failed',
  aborted: 'aborted',
  // N5/#9 — couldn't confirm whether the AgentAlreadyRegistered is on THIS account
  // (transient probe failure or adapter capability gap). Neutral, not a false conflict.
  unverified: 'already approved somewhere — couldn’t verify; retry',
};
export const ROW_TONE: Record<RowStatus, WalletRowTone> = {
  pending: 'neutral',
  approved: 'success',
  submitted: 'neutral',
  skipped: 'neutral',
  sponsored: 'neutral',
  stranded: 'warn',
  conflict: 'danger',
  cap: 'warn',
  error: 'danger',
  aborted: 'neutral',
  unverified: 'neutral',
};

function walletBatchAbortMessage(err: unknown): string | null {
  if (
    err instanceof WalletOwnerActionAbortError ||
    err instanceof WalletOwnerActionUnavailableError
  ) {
    return err.message;
  }
  if (err instanceof WalletReceiptWaitError) {
    return `${describeWalletTxError(err, err.txStep ?? 'action').message} Stop here and verify before continuing.`;
  }
  if (err instanceof WalletReceiptRevertedError) {
    return describeWalletTxError(err, 'action').message;
  }
  const info = describeWalletTxError(
    err,
    err instanceof WalletTxStepError ? err.txStep : 'action',
  );
  if (
    info.kind === 'rejected' ||
    info.kind === 'insufficient_funds' ||
    info.kind === 'rpc_timeout' ||
    info.kind === 'unknown'
  ) {
    return info.message;
  }
  return null;
}

export function walletActionAbortMessage(err: unknown): string | null {
  if (
    err instanceof WalletOwnerActionAbortError ||
    err instanceof WalletOwnerActionUnavailableError ||
    err instanceof WalletReceiptWaitError ||
    err instanceof WalletReceiptRevertedError ||
    err instanceof WalletTxStepError
  ) {
    return walletBatchAbortMessage(err);
  }
  return null;
}

export function describeWalletPcaRevert(err: unknown, accountId: string): PcaErrorInfo | null {
  const info = describeWalletTxError(
    err,
    err instanceof WalletTxStepError ? err.txStep : 'action',
  );
  if (info.kind !== 'revert') return null;
  switch (info.revertName) {
    case 'AgentAlreadyRegistered':
      return {
        code: 'AgentAlreadyRegistered',
        status: 400,
        message: 'This operational wallet is already approved on another PCA - deregister it there first.',
      };
    case 'AgentCapReached':
      return {
        code: 'AgentCapReached',
        status: 400,
        message: `PCA #${accountId} already has the maximum 100 approved publishing wallets.`,
      };
    case 'NotAccountOwner':
      return {
        code: 'NotAccountOwner',
        status: 403,
        message: `This wallet is not the owner of PCA #${accountId}, so it cannot manage it.`,
      };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// (A) REDUCER — pure display-state transitions.
// ---------------------------------------------------------------------------

export interface ApproveBatchState {
  order: string[];
  rows: Record<string, Row>;
  running: boolean;
  done: boolean;
  aborted: string | null;
  verificationDelayed: string | null;
  deviceSteps: DeviceConfirmStep[];
  deviceLabel?: string;
  walletBatchSigning: boolean;
}

export const initialApproveBatchState: ApproveBatchState = {
  order: [],
  rows: {},
  running: false,
  done: false,
  aborted: null,
  verificationDelayed: null,
  deviceSteps: [],
  deviceLabel: undefined,
  walletBatchSigning: false,
};

export type ApproveBatchAction =
  | { type: 'BATCH_START'; order: string[] }
  | { type: 'SET_WALLET_BATCH_SIGNING'; signing: boolean }
  | { type: 'ROW_SET'; address: string; row: Row }
  | { type: 'MARK_REMAINING'; current: Row; status: RowStatus; message?: string }
  | { type: 'SET_ABORTED'; message: string }
  | { type: 'SET_VERIFICATION_DELAYED'; message: string }
  | { type: 'DEVICE_PROMPT_START'; id: string; label: string; indexLabel: string }
  | { type: 'DEVICE_PROMPT_CONFIRMED'; id: string; txHash?: string }
  | { type: 'DEVICE_PROMPT_SUBMITTED'; id: string; txHash?: string }
  | { type: 'DEVICE_PROMPT_FAILED'; id: string; error: string }
  | { type: 'BATCH_DONE' };

export function approveBatchReducer(
  state: ApproveBatchState,
  action: ApproveBatchAction,
): ApproveBatchState {
  switch (action.type) {
    case 'BATCH_START':
      return {
        ...state,
        order: action.order,
        rows: Object.fromEntries(
          action.order.map((a) => [a, { address: a, status: 'pending' as RowStatus }]),
        ),
        running: true,
        done: false,
        aborted: null,
        verificationDelayed: null,
        deviceSteps: [],
        deviceLabel: undefined,
        // Stays false here; flipped post-planning by SET_WALLET_BATCH_SIGNING so
        // BATCH_START can fire SYNCHRONOUSLY on click (see the runner).
        walletBatchSigning: false,
      };
    case 'SET_WALLET_BATCH_SIGNING':
      // Mirrors the original setWalletBatchSigning(deviceTotal > 0) that ran AFTER the
      // pre-loop planning awaits — kept separate from BATCH_START so the reset/running
      // transition is not deferred behind those network round-trips.
      return { ...state, walletBatchSigning: action.signing };
    case 'ROW_SET':
      return { ...state, rows: { ...state.rows, [action.address]: action.row } };
    case 'MARK_REMAINING': {
      // Set `current` AND sweep every still-'pending' (not-yet-processed) row to
      // `status`, so a fatal break never leaves later rows on "approving…".
      const next: Record<string, Row> = { ...state.rows, [action.current.address]: action.current };
      for (const a of state.order) {
        if (next[a]?.status === 'pending') next[a] = { address: a, status: action.status, message: action.message };
      }
      return { ...state, rows: next };
    }
    case 'SET_ABORTED':
      return { ...state, aborted: action.message };
    case 'SET_VERIFICATION_DELAYED':
      return { ...state, verificationDelayed: action.message };
    case 'DEVICE_PROMPT_START':
      return {
        ...state,
        deviceLabel: action.indexLabel,
        deviceSteps: [...state.deviceSteps, { id: action.id, label: action.label, state: 'active' }],
      };
    case 'DEVICE_PROMPT_CONFIRMED':
      return {
        ...state,
        deviceSteps: state.deviceSteps.map((step) =>
          step.id === action.id ? { ...step, state: 'confirmed', txHash: action.txHash } : step,
        ),
      };
    case 'DEVICE_PROMPT_SUBMITTED':
      return {
        ...state,
        deviceSteps: state.deviceSteps.map((step) =>
          step.id === action.id
            ? { ...step, state: 'submitted', txHash: action.txHash, error: 'confirmation delayed - recheck on-chain' }
            : step,
        ),
      };
    case 'DEVICE_PROMPT_FAILED':
      return {
        ...state,
        deviceSteps: state.deviceSteps.map((step) =>
          step.id === action.id ? { ...step, state: 'failed', error: action.error } : step,
        ),
      };
    case 'BATCH_DONE':
      return { ...state, running: false, walletBatchSigning: false, done: true };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// (B) SELECTORS — pure, over {order,rows}.
// ---------------------------------------------------------------------------

export function selectCounts(state: ApproveBatchState) {
  const list = state.order.map((a) => state.rows[a]).filter(Boolean) as Row[];
  return {
    // #9 — confirmed (chain re-read) vs submitted (verify) kept separate so the
    // roll-up never overstates on-chain confirmation.
    confirmed: list.filter((r) => r.status === 'approved').length,
    submitted: list.filter((r) => r.status === 'submitted').length,
    skipped: list.filter((r) => r.status === 'skipped').length,
    sponsored: list.filter((r) => r.status === 'sponsored').length,
    stranded: list.filter((r) => r.status === 'stranded').length,
    conflict: list.filter((r) => r.status === 'conflict').length,
    error: list.filter((r) => r.status === 'error' || r.status === 'cap').length,
    aborted: list.filter((r) => r.status === 'aborted').length,
    unverified: list.filter((r) => r.status === 'unverified').length,
  };
}

export function selectApprovedWallets(state: ApproveBatchState): string[] {
  return state.order.filter((a) => {
    const s = state.rows[a]?.status;
    return s === 'approved' || s === 'submitted';
  });
}

// ---------------------------------------------------------------------------
// (C) RUNNER — the sequential loop + error taxonomy, pure of React.
// ---------------------------------------------------------------------------

export interface ApproveBatchInput {
  addresses: string[];
  accountId: string;
  mode: 'self' | 'sponsor';
  selfCoverage?: boolean;
  deregisterFrom?: string;
  targetWalletManaged: boolean;
  signableOwners: SignableOwner[];
}

export interface ApproveBatchDeps {
  registerAgent: (accountId: string, address: string) => Promise<PcaAddAgentResult>;
  /** Renew (deregister-first) — free the wallet from the single OLD account. */
  deregisterRenew: (accountId: string, address: string) => Promise<{ txHash?: string }>;
  /** Self-coverage — free the wallet from its per-wallet OWN-bound account. */
  deregisterSelf: (accountId: string, address: string) => Promise<{ txHash?: string }>;
  resolveWalletBinding: (wallet: string, owners: SignableOwner[]) => Promise<WalletBinding>;
  planSelfCoverage: (binding: WalletBinding) => SelfCoverageAction;
  signerKindForAccount: (id?: string) => Promise<'daemon' | 'wallet' | undefined>;
  probePca: (accountId: string, address: string) => Promise<{ probedKey?: PcaProbedKey }>;
  describePcaError: (err: unknown, opts: { accountId?: string }) => PcaErrorInfo | null;
  // `describeWalletPcaRevert` is NOT a dep — it is defined in this module (see above), so
  // the runner calls it directly rather than having the modal pass our own export back in.
  onApproved?: () => void;
}

/**
 * Run the sequential approve-publishing-wallets batch. One address at a time,
 * awaiting each write in order; `shouldStop` is consulted ONLY at the loop top
 * (an in-flight tx always completes before a stop takes effect). Emits reducer
 * actions via `dispatch`; fires `deps.onApproved()` AFTER `BATCH_DONE`.
 */
export async function runApproveBatch(
  input: ApproveBatchInput,
  deps: ApproveBatchDeps,
  dispatch: (action: ApproveBatchAction) => void,
  shouldStop: () => boolean,
): Promise<void> {
  const {
    addresses, accountId, mode, selfCoverage, deregisterFrom, targetWalletManaged, signableOwners,
  } = input;

  // Reset + seed pending rows + running=true SYNCHRONOUSLY, BEFORE the planning awaits
  // below. runApproveBatch runs to its first `await` in the same click tick, so this
  // dispatch flushes running=true before any second click can land — and the modal footer
  // renders the Approve/Retry trigger only while `!running`. That synchronous flip is the
  // SOLE re-entrancy guard: deferring it behind the network-bound planning would reopen a
  // concurrent double-submit (duplicate on-chain deregister/register + double device prompts).
  dispatch({ type: 'BATCH_START', order: addresses });

  // Pre-loop planning: resolve each self-coverage wallet's binding ONCE, resolve the
  // renew old-account's signer branch, then compute the "i of N" device-prompt total.
  const plannedSelfCoverage = new Map<string, {
    action: SelfCoverageAction;
    signerKind?: SignableOwnerKind;
  }>();
  if (selfCoverage && mode === 'self') {
    for (const addr of addresses) {
      const binding = await deps.resolveWalletBinding(addr, signableOwners);
      plannedSelfCoverage.set(addr, {
        action: deps.planSelfCoverage(binding),
        signerKind: binding.signerKind,
      });
    }
  }
  const deregisterFromSignerKind = await deps.signerKindForAccount(deregisterFrom);
  const deviceTotal = addresses.reduce((total, addr) => {
    if (deregisterFrom) {
      return total + (deregisterFromSignerKind === 'wallet' ? 1 : 0) + (targetWalletManaged ? 1 : 0);
    }
    if (selfCoverage && mode === 'self') {
      const plan = plannedSelfCoverage.get(addr);
      if (plan?.action.kind === 'skipSponsored' || plan?.action.kind === 'conflictSponsorDead') return total;
      const deregisterPrompt = plan?.action.kind === 'deregisterThenRegister' && plan.signerKind === 'wallet' ? 1 : 0;
      return total + deregisterPrompt + (targetWalletManaged ? 1 : 0);
    }
    return total + (targetWalletManaged ? 1 : 0);
  }, 0);

  // Post-planning: flip the wallet-batch signing lock (dismiss/cancel guard) exactly as the
  // original setWalletBatchSigning(deviceTotal > 0) did after the planning phase.
  dispatch({ type: 'SET_WALLET_BATCH_SIGNING', signing: deviceTotal > 0 });

  // Device-progress wrapper: for wallet-signed writes, push an "active" step +
  // "Confirm on your device (i of N)" label, then confirm / submit / fail it.
  // Counters are runner-local (not React refs) — read/written only here.
  let devicePromptIndex = 0;
  const runOwnerWrite = async <T extends { txHash?: string }>(
    label: string,
    write: () => Promise<T>,
    walletSigned = false,
  ): Promise<T> => {
    if (!walletSigned) return write();
    const index = devicePromptIndex + 1;
    devicePromptIndex = index;
    const total = Math.max(deviceTotal, index);
    const id = `${index}-${label}`;
    dispatch({ type: 'DEVICE_PROMPT_START', id, label, indexLabel: `Confirm on your device (${index} of ${total})` });
    try {
      const result = await write();
      dispatch({ type: 'DEVICE_PROMPT_CONFIRMED', id, txHash: result.txHash });
      return result;
    } catch (err) {
      if (err instanceof WalletReceiptWaitError && !!err.txHash) {
        dispatch({ type: 'DEVICE_PROMPT_SUBMITTED', id, txHash: err.txHash });
      } else {
        dispatch({ type: 'DEVICE_PROMPT_FAILED', id, error: (err as Error)?.message ?? 'Action failed.' });
      }
      throw err;
    }
  };

  for (const addr of addresses) {
    if (shouldStop()) {
      dispatch({ type: 'ROW_SET', address: addr, row: { address: addr, status: 'error', message: 'stopped' } });
      continue;
    }
    // The old PCA we DEREGISTERED this wallet from (set only on a SUCCESSFUL deregister),
    // so a subsequent register failure can be flagged "stranded" (off old, not on new) for retry.
    let strandedFrom: string | null = null;
    try {
      // Renew (deregister-first, #1344): expiry doesn't clear `agentToAccountId`, so a seeded
      // old-PCA wallet is still bound there and registerAgent(newId) would revert
      // AgentAlreadyRegistered. Free it from the OLD account FIRST. Daemon/transient failures
      // still fall through to register for the old recovery path, but wallet-signing aborts/rejects
      // stop the batch immediately so the UI never opens another prompt after the user declined.
      if (deregisterFrom) {
        try {
          await runOwnerWrite(
            `Deregister ${addr} from PCA #${deregisterFrom}`,
            () => deps.deregisterRenew(deregisterFrom, addr),
            deregisterFromSignerKind === 'wallet',
          );
          strandedFrom = deregisterFrom;
        } catch (err) {
          if (deregisterFromSignerKind === 'wallet' && walletActionAbortMessage(err)) throw err;
        }
      } else if (selfCoverage && mode === 'self') {
        // Honesty/safety gate on mode==='self': the mode radios stay enabled, so running this
        // self-coverage logic on THIRD-PARTY (sponsor-mode) addresses would mis-classify them.
        // The per-wallet classification lives in the planner (walletBinding.ts); this loop just
        // EXECUTES the plan. (Old account varies per wallet, unlike renew's deregisterFrom.)
        let planned = plannedSelfCoverage.get(addr);
        if (!planned) {
          const binding = await deps.resolveWalletBinding(addr, signableOwners);
          planned = { action: deps.planSelfCoverage(binding), signerKind: binding.signerKind };
        }
        const plan = planned.action;
        if (plan.kind === 'skipSponsored') {
          // Bound to a LIVE sponsor PCA → already discounted free; don't burn a register/conflict.
          dispatch({
            type: 'ROW_SET',
            address: addr,
            row: { address: addr, status: 'sponsored', message: `Stays on PCA #${plan.prevAccountId} - already discounted.` },
          });
          continue;
        }
        if (plan.kind === 'conflictSponsorDead') {
          // Bound to an EXPIRED/swept sponsor PCA: NOT covering, and this node can't free it (not
          // the owner). A distinct conflict — NEVER the benign "already discounted free" skip.
          dispatch({
            type: 'ROW_SET',
            address: addr,
            row: { address: addr, status: 'conflict', message: `Approved on PCA #${plan.prevAccountId}, but it’s expired/swept (not covering) — ask its owner to deregister you; this node can’t free it.` },
          });
          continue;
        }
        if (plan.kind === 'deregisterThenRegister') {
          // Record a SUCCESSFUL deregister so a later register failure reads as "stranded"
          // (off old, not on new) with a retry, not a generic error. A FAILED deregister leaves
          // the wallet on old → register conflicts → the AgentAlreadyRegistered handling below
          // recovers it.
          try {
            await runOwnerWrite(
              `Deregister ${addr} from PCA #${plan.prevAccountId}`,
              () => deps.deregisterSelf(plan.prevAccountId, addr),
              planned.signerKind === 'wallet',
            );
            strandedFrom = plan.prevAccountId;
          }
          catch (err) {
            if (planned.signerKind === 'wallet' && walletActionAbortMessage(err)) throw err;
            /* still bound to old — not stranded; register's conflict path recovers */
          }
        }
        // plan.kind === 'register' (unbound / inconclusive) → fall through to register.
      }
      const res = await runOwnerWrite(
        `Approve ${addr} on PCA #${accountId}`,
        () => deps.registerAgent(accountId, addr),
        targetWalletManaged,
      );
      dispatch({
        type: 'ROW_SET',
        address: addr,
        row: { address: addr, status: res.registered ? 'approved' : 'submitted', txHash: res.txHash },
      });
    } catch (err) {
      // If we'd already deregistered this wallet off its old PCA, a register failure leaves
      // it off old + not on new (stranded). Tag it so the row offers "retry to finish" instead of
      // a dead-end error. (NOT used for AgentAlreadyRegistered, which means it's still bound.)
      const strandRow = (): Row => ({
        address: addr,
        status: 'stranded',
        message: `Removed from PCA #${strandedFrom}, not yet on #${accountId} — retry to finish.`,
      });
      const walletAbort = walletActionAbortMessage(err);
      if (err instanceof WalletReceiptWaitError && err.txHash && (err.txStep ?? 'action') === 'action') {
        dispatch({
          type: 'SET_VERIFICATION_DELAYED',
          message: `Transaction ${err.txHash} was broadcast, but receipt verification failed. Recheck on-chain before retrying.`,
        });
        dispatch({
          type: 'MARK_REMAINING',
          current: {
            address: addr,
            status: 'submitted',
            txHash: err.txHash,
            message: 'Broadcast; verify on-chain before retrying.',
          },
          status: 'aborted',
          message: 'not run - verify the previous transaction first',
        });
        break;
      }
      if (walletAbort) {
        dispatch({ type: 'SET_ABORTED', message: walletAbort });
        dispatch({
          type: 'MARK_REMAINING',
          current: strandedFrom ? strandRow() : { address: addr, status: 'error', message: walletAbort },
          status: 'aborted',
          message: 'aborted',
        });
        break;
      }
      // 403 → owner-gate failure: abort the WHOLE operation. W1 — sweep the later
      // not-yet-processed rows too, else they stay stuck on "approving…".
      if (err instanceof HttpError && err.status === 403) {
        dispatch({ type: 'SET_ABORTED', message: `This node isn’t the owner of PCA #${accountId} — approval aborted.` });
        dispatch({
          type: 'MARK_REMAINING',
          current: strandedFrom ? strandRow() : { address: addr, status: 'error', message: 'owner-only' },
          status: 'error',
          message: 'aborted',
        });
        break;
      }
      const info = deps.describePcaError(err, { accountId }) ?? describeWalletPcaRevert(err, accountId);
      if (info?.code === 'AgentCapReached') {
        // U1 — mark the current row AND every NOT-YET-processed row 'cap' before the
        // break, else the later rows would stay stuck on 'pending' ("approving…").
        dispatch({ type: 'MARK_REMAINING', current: { address: addr, status: 'cap', message: info.message }, status: 'cap' });
        break;
      }
      if (info?.code === 'AgentAlreadyRegistered') {
        // Resolve the ambiguity: already approved HERE, bound ELSEWHERE, or
        // UNVERIFIABLE? N5/#9 — only assert a cross-account CONFLICT (danger,
        // "deregister there first") when the probe POSITIVELY says not-registered
        // -here with a working adapter. A transient probe failure (null) or a
        // capability gap (adapterSupported===false) is "couldn't verify" — neutral,
        // never a false DANGER pointing at the wrong fix. (A real conflict is still
        // NEVER downgraded to a benign skip.)
        const probe = await deps.probePca(accountId, addr).catch(() => null);
        const pk = probe?.probedKey;
        if (pk?.registered === true) {
          dispatch({
            type: 'ROW_SET',
            address: addr,
            row: { address: addr, status: 'skipped', message: 'Already an approved publishing wallet here.' },
          });
        } else if (pk?.registered === false && pk.adapterSupported !== false) {
          // Cross-account conflict — NEVER a benign skip.
          dispatch({ type: 'ROW_SET', address: addr, row: { address: addr, status: 'conflict', message: info.message } });
        } else {
          dispatch({ type: 'ROW_SET', address: addr, row: { address: addr, status: 'unverified' } });
        }
      } else {
        dispatch({
          type: 'ROW_SET',
          address: addr,
          row: strandedFrom ? strandRow() : { address: addr, status: 'error', message: info?.message ?? (err as Error)?.message },
        });
      }
    }
  }
  dispatch({ type: 'BATCH_DONE' });
  deps.onApproved?.();
}
