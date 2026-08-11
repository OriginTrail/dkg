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
});
