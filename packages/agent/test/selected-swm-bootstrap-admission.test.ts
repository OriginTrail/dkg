import { describe, expect, it } from 'vitest';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
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

describe('selected RFC-64 graph sync status', () => {
  const CG = 'cg-selected';
  const PROVIDER = '12D3KooWSelectedProvider';

  function status(options: {
    selected?: boolean;
    providers?: readonly string[];
    phase?: 'waiting' | 'retry-required' | 'terminal';
    sharedMemorySynced?: boolean;
  } = {}) {
    const admission = new SelectedSwmBootstrapAdmission();
    if (options.phase === 'retry-required') admission.request(PROVIDER, [CG]);
    if (options.phase === 'terminal') {
      const owner = admission.beginTransfer(PROVIDER, [CG]);
      admission.markTransferTerminal(owner);
    }
    const agent = {
      config: { syncContextGraphs: options.selected === false ? [] : [CG] },
      resolveRfc64CompleteSwmProviderPeerIdsV1: () => options.providers ?? [PROVIDER],
      selectedSwmBootstrapAdmission: admission,
      subscribedContextGraphs: new Map(options.sharedMemorySynced
        ? [[CG, { sharedMemorySynced: true }]]
        : []),
    };
    return (LifecycleSyncMethods.prototype.getRfc64SelectedSwmGraphSyncStatus as any)
      .call(agent, CG);
  }

  it('distinguishes inactive, waiting, continuing, and converged states', () => {
    expect(status({ selected: false }).state).toBe('inactive');
    expect(status({ providers: [] }).state).toBe('inactive');
    expect(status({ phase: 'waiting' })).toMatchObject({
      state: 'waiting',
      configuredProviderCount: 1,
      retryRequiredProviderCount: 0,
      terminalProviderCount: 0,
    });
    expect(status({ phase: 'retry-required' })).toMatchObject({
      state: 'continuing',
      retryRequiredProviderCount: 1,
    });
    expect(status({ phase: 'terminal' })).toMatchObject({
      state: 'converged',
      terminalProviderCount: 1,
    });
    expect(status({ sharedMemorySynced: true }).state).toBe('converged');
  });
});
