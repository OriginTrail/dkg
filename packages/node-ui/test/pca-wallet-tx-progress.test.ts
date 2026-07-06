// @vitest-environment happy-dom
//
// Focused unit coverage for the shared useWalletTxProgress reducer (#1375 item 4).
// The integration tests (detail-view / create-modal) drive it through the DOM, but
// only exercise the first approve prompt — the shared action/submitted/confirmed
// branches (and the no-approve remove flow) were previously unverified. This pins
// the full approve -> action -> confirm transitions, the remove 2-step flow, the
// approve-skipped relabel, and the failure copy, so a regression in the shared
// reducer can't slip past green integration tests.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useWalletTxProgress, type WalletTxProgress } from '../src/ui/pca/useWalletTxProgress.js';

type V = 'topup' | 'remove';

const LABELS = {
  idle: 'Confirm on your device',
  approveActive: 'Confirm on your device (1 of 2): approve TRAC',
  approveReady: 'Allowance ready — continue to the owner action',
  actionActive: (v?: V) =>
    v === 'remove' ? 'Confirm on your device: remove wallet' : 'Confirm on your device (2 of 2): top up',
  submitted: 'Waiting for on-chain confirmation',
  confirmed: 'Transaction confirmed on-chain',
  failed: 'Wallet transaction failed',
};
const flow = (v?: V) =>
  v === 'remove'
    ? { requiresApproval: false, actionLabel: 'Sign remove wallet' }
    : { requiresApproval: true, actionLabel: 'Sign top-up' };
const describeActionError = (err: unknown, v?: V) => `action[${v}]:${(err as Error).message}`;

let api: WalletTxProgress<V> | null = null;
function Harness() {
  api = useWalletTxProgress<V>({ labels: LABELS, flow, describeActionError });
  return null;
}
const stepById = (id: string) => api!.steps.find((s) => s.id === id);

let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(React.createElement(Harness)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  api = null;
});

describe('useWalletTxProgress — shared device-confirm reducer', () => {
  it('begin(topup) seeds approve -> action -> confirm with the exact labels + approveActive', () => {
    act(() => api!.begin('topup'));
    expect(api!.steps.map((s) => [s.id, s.label, s.state])).toEqual([
      ['approve', 'Approve exact TRAC allowance', 'pending'],
      ['action', 'Sign top-up', 'pending'],
      ['confirm', 'Confirm on-chain receipt', 'pending'],
    ]);
    expect(api!.currentLabel).toBe(LABELS.approveActive);
  });

  it('begin(remove) seeds a 2-step no-approve flow with actionActive(remove)', () => {
    act(() => api!.begin('remove'));
    expect(api!.steps.map((s) => s.id)).toEqual(['action', 'confirm']);
    expect(stepById('action')!.label).toBe('Sign remove wallet');
    expect(api!.currentLabel).toBe('Confirm on your device: remove wallet');
  });

  it('drives a full approve -> action -> confirm topup flow (labels + step states at each stage)', () => {
    act(() => api!.begin('topup'));
    act(() => api!.onProgress({ step: 'approve', state: 'confirmed', txHash: '0xapprove' } as any));
    expect(stepById('approve')!.state).toBe('confirmed');
    expect(api!.currentLabel).toBe(LABELS.approveReady);

    act(() => api!.onProgress({ step: 'action', state: 'active' } as any));
    expect(stepById('action')!.state).toBe('active');
    expect(api!.currentLabel).toBe('Confirm on your device (2 of 2): top up');

    act(() => api!.onProgress({ step: 'action', state: 'submitted', txHash: '0xaction' } as any));
    expect(stepById('action')!.state).toBe('confirmed');
    expect(stepById('action')!.txHash).toBe('0xaction');
    expect(stepById('confirm')!.state).toBe('active');
    expect(api!.currentLabel).toBe(LABELS.submitted);

    act(() => api!.onProgress({ step: 'action', state: 'confirmed', txHash: '0xaction' } as any));
    expect(stepById('confirm')!.state).toBe('confirmed');
    expect(api!.currentLabel).toBe(LABELS.confirmed);
  });

  it('relabels the approve step on skipped (allowance already sufficient) + shows approveReady', () => {
    act(() => api!.begin('topup'));
    act(() => api!.onProgress({ step: 'approve', state: 'skipped' } as any));
    expect(stepById('approve')!.state).toBe('confirmed');
    expect(stepById('approve')!.label).toBe('TRAC allowance already sufficient');
    expect(api!.currentLabel).toBe(LABELS.approveReady);
  });

  it('the remove flow (no approve) confirms action then confirm', () => {
    act(() => api!.begin('remove'));
    act(() => api!.onProgress({ step: 'action', state: 'confirmed', txHash: '0xrm' } as any));
    expect(stepById('action')!.state).toBe('confirmed');
    expect(stepById('confirm')!.state).toBe('confirmed');
    expect(api!.steps.some((s) => s.id === 'approve')).toBe(false);
  });

  it('surfaces the injected action-failure copy on a failed action step', () => {
    act(() => api!.begin('topup'));
    act(() => api!.onProgress({ step: 'action', state: 'failed', error: new Error('boom') } as any));
    expect(stepById('action')!.state).toBe('failed');
    expect(stepById('action')!.error).toBe('action[topup]:boom');
    expect(api!.currentLabel).toBe(LABELS.failed);
  });

  it('reset clears the steps + label back to idle', () => {
    act(() => api!.begin('topup'));
    act(() => api!.reset());
    expect(api!.steps).toEqual([]);
    expect(api!.currentLabel).toBe(LABELS.idle);
  });
});
