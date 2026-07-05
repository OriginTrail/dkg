// Pure reducer/runner unit coverage for the extracted approve-publishing-wallets
// batch machine (#1350). The DOM integration lives in pca-approve-modal.test.ts;
// this pins the financial-correctness invariants directly on approveBatch.ts —
// no React, no DOM — so a regression in the sequential loop / error taxonomy /
// #9 accounting is caught in isolation:
//   #9 confirmed≠submitted · owner-gate(403) abort · cap abort · cooperative stop
//   finalization · N5-conflict (conflict only on positive registered===false) ·
//   stranded honesty · sponsor vs dead-sponsor · mid-batch error CONTINUES ·
//   onApproved fires after BATCH_DONE · sequential ordering.

import { describe, expect, it, vi } from 'vitest';
import {
  approveBatchReducer,
  initialApproveBatchState,
  selectApprovedWallets,
  selectCounts,
  runApproveBatch,
  type ApproveBatchDeps,
  type ApproveBatchInput,
} from '../src/ui/pca/approveBatch.js';
import { HttpError } from '../src/ui/api.js';
import { WalletReceiptWaitError } from '../src/ui/web3/walletTxError.js';
import { WalletOwnerActionAbortError } from '../src/ui/web3/walletOwnerActionSubmitter.js';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const C = '0x' + 'c'.repeat(40);

// ---- reducer ----
describe('approveBatchReducer', () => {
  it('BATCH_START seeds every address pending + running; walletBatchSigning stays false until planning resolves', () => {
    const s = approveBatchReducer(initialApproveBatchState, { type: 'BATCH_START', order: [A, B] });
    expect(s.order).toEqual([A, B]);
    expect(s.rows[A]).toEqual({ address: A, status: 'pending' });
    expect(s.running).toBe(true);
    expect(s.done).toBe(false);
    // BATCH_START never sets the signing lock — that is flipped post-planning by
    // SET_WALLET_BATCH_SIGNING so BATCH_START can fire synchronously on click.
    expect(s.walletBatchSigning).toBe(false);
    expect(approveBatchReducer(s, { type: 'SET_WALLET_BATCH_SIGNING', signing: true }).walletBatchSigning).toBe(true);
    expect(approveBatchReducer(s, { type: 'SET_WALLET_BATCH_SIGNING', signing: false }).walletBatchSigning).toBe(false);
  });

  it('MARK_REMAINING sets current + sweeps ONLY still-pending rows (never downgrades a terminal row)', () => {
    let s = approveBatchReducer(initialApproveBatchState, { type: 'BATCH_START', order: [A, B, C] });
    s = approveBatchReducer(s, { type: 'ROW_SET', address: A, row: { address: A, status: 'conflict', message: 'x' } }); // terminal
    s = approveBatchReducer(s, { type: 'MARK_REMAINING', current: { address: B, status: 'cap' }, status: 'cap', message: 'cap' });
    expect(s.rows[A].status).toBe('conflict'); // terminal NOT downgraded
    expect(s.rows[B].status).toBe('cap'); // current
    expect(s.rows[C]).toEqual({ address: C, status: 'cap', message: 'cap' }); // swept pending
  });

  it('device-prompt transitions + BATCH_DONE finalize', () => {
    let s = approveBatchReducer(initialApproveBatchState, { type: 'DEVICE_PROMPT_START', id: '1-x', label: 'x', indexLabel: 'Confirm (1 of 1)' });
    expect(s.deviceSteps[0]).toMatchObject({ id: '1-x', state: 'active' });
    expect(s.deviceLabel).toBe('Confirm (1 of 1)');
    s = approveBatchReducer(s, { type: 'DEVICE_PROMPT_SUBMITTED', id: '1-x', txHash: '0xh' });
    expect(s.deviceSteps[0]).toMatchObject({ state: 'submitted', txHash: '0xh' });
    s = approveBatchReducer({ ...s, running: true }, { type: 'BATCH_DONE' });
    expect(s).toMatchObject({ running: false, done: true, walletBatchSigning: false });
  });
});

// ---- selectors (#9) ----
describe('selectCounts / selectApprovedWallets (#9)', () => {
  it('keeps confirmed (approved) SEPARATE from submitted; never folds them', () => {
    const s = {
      ...initialApproveBatchState,
      order: [A, B, C],
      rows: {
        [A]: { address: A, status: 'approved' as const },
        [B]: { address: B, status: 'submitted' as const },
        [C]: { address: C, status: 'cap' as const },
      },
    };
    const c = selectCounts(s);
    expect(c.confirmed).toBe(1);
    expect(c.submitted).toBe(1);
    expect(c.error).toBe(1); // cap folds into error tally only
    expect(selectApprovedWallets(s)).toEqual([A, B]); // approved + submitted, in order
  });
});

// ---- runner ----
const makeDeps = (over: Partial<ApproveBatchDeps> = {}): ApproveBatchDeps => ({
  registerAgent: vi.fn(async () => ({ registered: true, txHash: '0xreg' })) as any,
  deregisterRenew: vi.fn(async () => ({ txHash: '0xd' })),
  deregisterSelf: vi.fn(async () => ({ txHash: '0xd' })),
  resolveWalletBinding: vi.fn(async () => ({ signerKind: 'daemon' })) as any,
  planSelfCoverage: vi.fn(() => ({ kind: 'register' })) as any,
  signerKindForAccount: vi.fn(async () => 'daemon' as const),
  probePca: vi.fn(async () => ({})),
  describePcaError: vi.fn(() => null),
  describeWalletPcaRevert: vi.fn(() => null),
  onApproved: vi.fn(),
  ...over,
});

async function runBatch(
  inputOver: Partial<ApproveBatchInput>,
  depsOver: Partial<ApproveBatchDeps> = {},
  shouldStop: () => boolean = () => false,
) {
  let state = { ...initialApproveBatchState };
  const actions: any[] = [];
  const dispatch = (a: any) => { actions.push(a); state = approveBatchReducer(state, a); };
  const deps = makeDeps(depsOver);
  const input: ApproveBatchInput = {
    addresses: [A, B], accountId: '7', mode: 'sponsor', targetWalletManaged: false, signableOwners: [], ...inputOver,
  };
  await runApproveBatch(input, deps, dispatch, shouldStop);
  return { state, actions, deps, counts: selectCounts(state) };
}

describe('runApproveBatch — sequential loop + taxonomy', () => {
  it('dispatches BATCH_START (running=true, pending rows) SYNCHRONOUSLY before the planning awaits — the double-submit re-entrancy guard', async () => {
    // Gate the pre-loop planning (signerKindForAccount is always awaited) so we can observe
    // the state BETWEEN the synchronous BATCH_START and the network-bound planning phase.
    let releasePlanning: () => void = () => {};
    const gate = new Promise<void>((res) => { releasePlanning = res; });
    const signerKindForAccount = vi.fn(async () => { await gate; return 'daemon' as const; });
    let state = { ...initialApproveBatchState };
    const actions: any[] = [];
    const dispatch = (a: any) => { actions.push(a); state = approveBatchReducer(state, a); };
    const deps = makeDeps({ signerKindForAccount: signerKindForAccount as any });
    const input: ApproveBatchInput = {
      addresses: [A, B], accountId: '7', mode: 'sponsor', targetWalletManaged: false, signableOwners: [],
    };
    const p = runApproveBatch(input, deps, dispatch, () => false);
    // BEFORE releasing planning: BATCH_START must ALREADY have flipped running=true + seeded
    // pending rows. The modal footer renders the Approve/Retry trigger only while `!running`,
    // so this synchronous flip (same click tick) is the sole guard against a second concurrent
    // runApproveBatch — i.e. a duplicate on-chain deregister/register double-submit.
    expect(actions[0]?.type).toBe('BATCH_START');
    expect(state.running).toBe(true);
    expect(state.rows[A]).toEqual({ address: A, status: 'pending' });
    expect(state.rows[B]).toEqual({ address: B, status: 'pending' });
    // The signing lock is flipped only AFTER planning resolves, never by BATCH_START.
    expect(actions.some((x) => x.type === 'SET_WALLET_BATCH_SIGNING')).toBe(false);
    releasePlanning();
    await p;
    expect(state.done).toBe(true);
    const startIdx = actions.findIndex((x) => x.type === 'BATCH_START');
    const signIdx = actions.findIndex((x) => x.type === 'SET_WALLET_BATCH_SIGNING');
    expect(startIdx).toBe(0);
    expect(signIdx).toBeGreaterThan(startIdx); // planning-gated, strictly after BATCH_START
  });

  it('happy path: registered→approved, unconfirmed(200)→submitted (#9), onApproved after BATCH_DONE', async () => {
    const registerAgent = vi.fn()
      .mockResolvedValueOnce({ registered: true, txHash: '0x1' })
      .mockResolvedValueOnce({ registered: false, txHash: '0x2' });
    const { state, counts, actions, deps } = await runBatch({}, { registerAgent: registerAgent as any });
    expect(state.rows[A].status).toBe('approved');
    expect(state.rows[B].status).toBe('submitted');
    expect(counts).toMatchObject({ confirmed: 1, submitted: 1 });
    expect(state.done).toBe(true);
    // onApproved fires AFTER BATCH_DONE
    const doneIdx = actions.findIndex((a) => a.type === 'BATCH_DONE');
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    expect(deps.onApproved).toHaveBeenCalledTimes(1);
    // sequential order preserved
    expect(registerAgent.mock.calls.map((c) => c[1])).toEqual([A, B]);
  });

  it('cooperative stop: rows after the stop point become error/stopped; batch still finalizes', async () => {
    let calls = 0;
    const shouldStop = () => (++calls > 1); // false for A (1st check), true for B
    const registerAgent = vi.fn(async () => ({ registered: true, txHash: '0x' }));
    const { state } = await runBatch({ addresses: [A, B] }, { registerAgent: registerAgent as any }, shouldStop);
    expect(state.rows[A].status).toBe('approved');
    expect(state.rows[B]).toEqual({ address: B, status: 'error', message: 'stopped' });
    expect(registerAgent).toHaveBeenCalledTimes(1); // B never written
    expect(state.done).toBe(true);
  });

  it('owner-gate 403 ABORTS the whole batch (current error, remaining aborted, break)', async () => {
    const registerAgent = vi.fn(async () => { throw new HttpError(403, 'x', { error: 'NotAccountOwner' }); });
    const { state } = await runBatch({ addresses: [A, B] }, { registerAgent: registerAgent as any });
    expect(state.aborted).toMatch(/isn.t the owner/i);
    expect(state.rows[A]).toMatchObject({ status: 'error', message: 'owner-only' });
    // 403 sweeps the remaining rows to 'error' (message 'aborted') — distinct from the
    // wallet-abort/receipt-wait branches, which sweep to status 'aborted'.
    expect(state.rows[B]).toMatchObject({ status: 'error', message: 'aborted' });
    expect(registerAgent).toHaveBeenCalledTimes(1); // broke after A
  });

  it('AgentCapReached marks current + remaining cap and breaks', async () => {
    const registerAgent = vi.fn(async () => { throw new Error('cap'); });
    const describePcaError = vi.fn(() => ({ code: 'AgentCapReached', status: 400, message: 'cap reached' }));
    const { state } = await runBatch({ addresses: [A, B] }, { registerAgent: registerAgent as any, describePcaError: describePcaError as any });
    expect(state.rows[A].status).toBe('cap');
    expect(state.rows[B].status).toBe('cap');
    expect(registerAgent).toHaveBeenCalledTimes(1);
  });

  it('a mid-batch server error marks that row error but CONTINUES to the next (no abort)', async () => {
    const registerAgent = vi.fn()
      .mockImplementationOnce(async () => { throw new Error('boom'); })
      .mockResolvedValueOnce({ registered: true, txHash: '0x2' });
    const describePcaError = vi.fn(() => ({ code: 'ServerError', status: 500, message: 'boom' }));
    const { state } = await runBatch({ addresses: [A, B] }, { registerAgent: registerAgent as any, describePcaError: describePcaError as any });
    expect(state.rows[A].status).toBe('error');
    expect(state.rows[B].status).toBe('approved'); // continued
    expect(registerAgent).toHaveBeenCalledTimes(2);
  });

  it('N5: AgentAlreadyRegistered → conflict ONLY on positive registered===false; null probe/adapter-gap → unverified; registered true → skipped', async () => {
    const already = () => { throw new Error('already'); };
    const describePcaError = vi.fn(() => ({ code: 'AgentAlreadyRegistered', status: 400, message: 'on another PCA' }));
    // registered===false + adapter ok → conflict
    let r = await runBatch({ addresses: [A] }, { registerAgent: vi.fn(already) as any, describePcaError: describePcaError as any, probePca: vi.fn(async () => ({ probedKey: { key: A, registered: false, adapterSupported: true } })) as any });
    expect(r.state.rows[A].status).toBe('conflict');
    // probe FAILS (null) → unverified (never a false conflict)
    r = await runBatch({ addresses: [A] }, { registerAgent: vi.fn(already) as any, describePcaError: describePcaError as any, probePca: vi.fn(async () => { throw new Error('probe down'); }) as any });
    expect(r.state.rows[A].status).toBe('unverified');
    // adapterSupported===false → unverified (capability gap, not a conflict)
    r = await runBatch({ addresses: [A] }, { registerAgent: vi.fn(already) as any, describePcaError: describePcaError as any, probePca: vi.fn(async () => ({ probedKey: { key: A, registered: false, adapterSupported: false } })) as any });
    expect(r.state.rows[A].status).toBe('unverified');
    // registered===true → benign skipped
    r = await runBatch({ addresses: [A] }, { registerAgent: vi.fn(already) as any, describePcaError: describePcaError as any, probePca: vi.fn(async () => ({ probedKey: { key: A, registered: true, adapterSupported: true } })) as any });
    expect(r.state.rows[A].status).toBe('skipped');
  });

  it('stranded honesty: a SUCCESSFUL renew-deregister then a register failure reads stranded, not error', async () => {
    const deregisterRenew = vi.fn(async () => ({ txHash: '0xd' })); // succeeds → strandedFrom set
    const registerAgent = vi.fn(async () => { throw new Error('boom'); });
    const describePcaError = vi.fn(() => ({ code: 'ServerError', status: 500, message: 'boom' }));
    const { state } = await runBatch(
      { addresses: [A], deregisterFrom: '9' },
      { deregisterRenew: deregisterRenew as any, registerAgent: registerAgent as any, describePcaError: describePcaError as any },
    );
    expect(deregisterRenew).toHaveBeenCalledWith('9', A);
    expect(state.rows[A].status).toBe('stranded');
    expect(state.rows[A].message).toMatch(/retry to finish/i);
  });

  it('self-coverage: a LIVE sponsor → sponsored (no register burned); a DEAD sponsor → conflict', async () => {
    const registerAgent = vi.fn(async () => ({ registered: true, txHash: '0x' }));
    // skipSponsored
    let r = await runBatch(
      { addresses: [A], mode: 'self', selfCoverage: true },
      { registerAgent: registerAgent as any, planSelfCoverage: vi.fn(() => ({ kind: 'skipSponsored', prevAccountId: '5' })) as any },
    );
    expect(r.state.rows[A].status).toBe('sponsored');
    expect(registerAgent).not.toHaveBeenCalled();
    // conflictSponsorDead
    r = await runBatch(
      { addresses: [A], mode: 'self', selfCoverage: true },
      { registerAgent: registerAgent as any, planSelfCoverage: vi.fn(() => ({ kind: 'conflictSponsorDead', prevAccountId: '5' })) as any },
    );
    expect(r.state.rows[A].status).toBe('conflict');
    expect(registerAgent).not.toHaveBeenCalled();
  });

  it('a wallet-signed abort (user rejected) aborts the batch before the next prompt', async () => {
    const registerAgent = vi.fn(async () => { throw new WalletOwnerActionAbortError('Wallet account changed before the signature prompt.'); });
    const { state } = await runBatch({ addresses: [A, B], targetWalletManaged: true }, { registerAgent: registerAgent as any });
    expect(state.aborted).toMatch(/account changed/i);
    expect(state.rows[B].status).toBe('aborted');
    expect(registerAgent).toHaveBeenCalledTimes(1);
  });

  it('a broadcast receipt-wait (txHash) marks the row submitted + aborts remaining (verify first)', async () => {
    const registerAgent = vi.fn(async () => { throw new WalletReceiptWaitError('0xbroadcast', undefined, 'action'); });
    const { state } = await runBatch({ addresses: [A, B], targetWalletManaged: true }, { registerAgent: registerAgent as any });
    expect(state.rows[A]).toMatchObject({ status: 'submitted', txHash: '0xbroadcast' });
    expect(state.rows[B].status).toBe('aborted');
    expect(state.verificationDelayed).toMatch(/verification failed|recheck/i);
  });
});
