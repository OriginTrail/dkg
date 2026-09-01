import { describe, expect, it } from 'vitest';
import { SelectedSwmBootstrapAdmission } from '../src/sync/selected-swm-bootstrap-admission.js';

const PEER = '12D3KooWScopeAwareSelectedSwmProvider';

function completeScope(
  admission: SelectedSwmBootstrapAdmission,
  contextGraphIds: readonly string[],
): void {
  const owner = admission.beginTransfer(PEER, contextGraphIds);
  expect(admission.markTransferTerminal(owner)).toBe(true);
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
    });
  });

  it('reopens an unchanged terminal scope only after its freshness window', () => {
    const admission = new SelectedSwmBootstrapAdmission();
    const owner = admission.beginTransfer(PEER, ['cg-a']);
    expect(admission.markTransferTerminal(owner, 1_000)).toBe(true);

    expect(admission.requestRefresh(PEER, ['cg-a'], 10_000, 10_999)).toBe(false);
    expect(admission.snapshot(PEER)?.phase).toBe('terminal');
    expect(admission.requestRefresh(PEER, ['cg-a'], 10_000, 11_000)).toBe(true);
    expect(admission.snapshot(PEER)).toEqual({
      contextGraphIds: ['cg-a'],
      phase: 'retry-required',
    });
    expect(admission.markTransferTerminal(owner, 11_001)).toBe(false);
  });

  it('does not let an older in-flight completion suppress a newer scope', () => {
    const admission = new SelectedSwmBootstrapAdmission();

    const first = admission.beginTransfer(PEER, ['cg-a']);
    expect(admission.request(PEER, ['cg-a', 'cg-b'])).toBe(true);
    expect(admission.markTransferTerminal(first)).toBe(false);

    expect(admission.snapshot(PEER)).toEqual({
      contextGraphIds: ['cg-a', 'cg-b'],
      phase: 'retry-required',
    });
  });

  it('invalidates one graph while preserving the provider remaining scope', () => {
    const admission = new SelectedSwmBootstrapAdmission();
    const staleOwner = admission.beginTransfer(PEER, ['cg-a', 'cg-b']);
    expect(admission.markTransferTerminal(staleOwner, 1_000)).toBe(true);

    expect(admission.invalidateContextGraph(PEER, 'cg-a')).toBe(true);
    expect(admission.snapshot(PEER)).toEqual({
      contextGraphIds: ['cg-b'],
      phase: 'terminal',
    });
    expect(admission.markTransferTerminal(staleOwner, 2_000)).toBe(false);
    expect(admission.requestRefresh(PEER, ['cg-a', 'cg-b'], 10_000, 2_001)).toBe(true);
    expect(admission.snapshot(PEER)).toEqual({
      contextGraphIds: ['cg-a', 'cg-b'],
      phase: 'retry-required',
    });
  });

  it('removes a sole selected graph so an immediate re-selection is admitted', () => {
    const admission = new SelectedSwmBootstrapAdmission();
    completeScope(admission, ['cg-a']);

    expect(admission.invalidateContextGraph(PEER, 'cg-a')).toBe(true);
    expect(admission.snapshot(PEER)).toBeNull();
    expect(admission.requestRefresh(PEER, ['cg-a'], 60_000)).toBe(true);
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
    });
  });

  it('summarizes one graph without returning provider identities', () => {
    const admission = new SelectedSwmBootstrapAdmission();
    const otherPeer = `${PEER}-other`;
    const stalePeer = `${PEER}-stale`;

    admission.request(PEER, ['cg-a', 'cg-b']);
    completeScope(admission, ['cg-a', 'cg-b']);
    admission.request(otherPeer, ['cg-a']);
    admission.request(stalePeer, ['cg-a']);

    expect(admission.summarizeContextGraph('cg-a', [PEER, otherPeer])).toEqual({
      retryRequiredProviders: 1,
      terminalProviders: 1,
    });
    expect(admission.summarizeContextGraph('cg-b', [PEER, otherPeer])).toEqual({
      retryRequiredProviders: 0,
      terminalProviders: 1,
    });
  });
});
