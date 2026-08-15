import { describe, expect, it } from 'vitest';
import { SelectedSwmBootstrapAdmission } from '../src/sync/selected-swm-bootstrap-admission.js';

const PEER = '12D3KooWScopeAwareSelectedSwmProvider';

function completeScope(
  admission: SelectedSwmBootstrapAdmission,
  contextGraphIds: readonly string[],
  freshAtMs = 1_000,
): void {
  const owner = admission.beginTransfer(PEER, contextGraphIds);
  expect(admission.markTransferTerminal(owner, freshAtMs)).toBe(true);
}

describe('SelectedSwmBootstrapAdmission', () => {
  it('suppresses only an exact terminal peer and graph scope', () => {
    const admission = new SelectedSwmBootstrapAdmission();

    expect(admission.request(PEER, ['cg-b', 'cg-a', 'cg-a'])).toBe(true);
    completeScope(admission, ['cg-a', 'cg-b']);

    expect(admission.request(PEER, ['cg-b', 'cg-a'])).toBe(false);
    expect(admission.snapshot(PEER)).toEqual({
      contextGraphIds: ['cg-a', 'cg-b'],
      phase: 'terminal',
      freshAtMs: 1_000,
    });
  });

  it('admits a provider again when the selected graph scope grows', () => {
    const admission = new SelectedSwmBootstrapAdmission();

    expect(admission.request(PEER, ['cg-a'])).toBe(true);
    completeScope(admission, ['cg-a']);
    expect(admission.request(PEER, ['cg-a', 'cg-b'])).toBe(true);

    expect(admission.snapshot(PEER)).toEqual({
      contextGraphIds: ['cg-a', 'cg-b'],
      phase: 'retry-required',
      freshAtMs: null,
    });
  });

  it('does not let an older in-flight completion suppress a newer scope', () => {
    const admission = new SelectedSwmBootstrapAdmission();

    const first = admission.beginTransfer(PEER, ['cg-a']);
    expect(admission.request(PEER, ['cg-a', 'cg-b'])).toBe(true);
    expect(admission.markTransferTerminal(first)).toBe(false);

    expect(admission.snapshot(PEER)).toEqual({
      contextGraphIds: ['cg-a', 'cg-b'],
      phase: 'retry-required',
      freshAtMs: null,
    });
  });

  it('lets only the newest queued transfer mark one unchanged scope terminal', () => {
    const admission = new SelectedSwmBootstrapAdmission();
    const first = admission.beginTransfer(PEER, ['cg-a']);
    const second = admission.beginTransfer(PEER, ['cg-a']);

    expect(admission.markTransferTerminal(first)).toBe(false);
    expect(admission.isRetryRequired(PEER)).toBe(true);
    expect(admission.markTransferTerminal(second)).toBe(true);
    expect(admission.isRetryRequired(PEER)).toBe(false);
  });

  it('treats an empty selected scope as terminal no-work', () => {
    const admission = new SelectedSwmBootstrapAdmission();

    expect(admission.request(PEER, [])).toBe(false);
    expect(admission.snapshot(PEER)).toEqual({
      contextGraphIds: [],
      phase: 'terminal',
      freshAtMs: null,
    });
  });

  it('plans refreshes from peer, scope, completion, and disconnect freshness', () => {
    const admission = new SelectedSwmBootstrapAdmission();
    const now = 20_000;
    const options = { now, disconnectBoundary: 0, staleAfterMs: 5_000 };

    expect(admission.shouldRefresh(PEER, ['cg-a'], options)).toBe(true);
    completeScope(admission, ['cg-a'], 18_000);
    expect(admission.shouldRefresh(PEER, ['cg-a'], options)).toBe(false);
    expect(admission.shouldRefresh(PEER, ['cg-b'], options)).toBe(true);
    expect(admission.shouldRefresh(PEER, ['cg-a'], {
      ...options,
      disconnectBoundary: 19_000,
    })).toBe(true);
    expect(admission.shouldRefresh(PEER, ['cg-a'], {
      ...options,
      now: 23_000,
    })).toBe(true);
  });

  it('reopens a stale terminal scope without lifecycle-owned timestamp state', () => {
    const admission = new SelectedSwmBootstrapAdmission();
    completeScope(admission, ['cg-a'], 1_000);

    expect(admission.requestRefresh(PEER, ['cg-a'])).toBe(true);
    expect(admission.snapshot(PEER)).toEqual({
      contextGraphIds: ['cg-a'],
      phase: 'retry-required',
      freshAtMs: null,
    });
  });
});
