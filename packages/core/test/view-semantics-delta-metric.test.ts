import { afterEach, describe, expect, it, vi } from 'vitest';
import { metrics, type MeterProvider } from '@opentelemetry/api';

function provider() {
  const add = vi.fn();
  const createCounter = vi.fn(() => ({ add }));
  const getMeter = vi.fn(() => ({ createCounter }));
  return { add, createCounter, getMeter, provider: { getMeter } as unknown as MeterProvider };
}

describe('recordViewSemanticsDelta', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('counts each sampled query by kind on one counter of the node meter', async () => {
    const node = provider();
    vi.spyOn(metrics, 'getMeterProvider').mockReturnValue(node.provider);
    const { recordViewSemanticsDelta } = await import('../src/view-semantics-delta-metric.js');
    recordViewSemanticsDelta('rows-added');
    recordViewSemanticsDelta('none');
    expect(node.getMeter).toHaveBeenCalledWith('@origintrail-official/dkg');
    expect(node.createCounter).toHaveBeenCalledTimes(1);
    expect(node.createCounter).toHaveBeenCalledWith('dkg.query.view_semantics_delta', expect.objectContaining({ description: expect.any(String) }));
    expect(node.add.mock.calls).toEqual([[1, { kind: 'rows-added' }], [1, { kind: 'none' }]]);
  });

  it('records into the provider of the moment when telemetry is switched on, off or on again', async () => {
    const [first, second] = [provider(), provider()];
    const current = vi.spyOn(metrics, 'getMeterProvider').mockReturnValue(first.provider);
    const { recordViewSemanticsDelta } = await import('../src/view-semantics-delta-metric.js');
    recordViewSemanticsDelta('none');
    current.mockReturnValue(second.provider);
    recordViewSemanticsDelta('rows-added');
    recordViewSemanticsDelta('rows-added');
    current.mockReturnValue(first.provider);
    recordViewSemanticsDelta('copies-removed');
    expect(first.add.mock.calls).toEqual([[1, { kind: 'none' }], [1, { kind: 'copies-removed' }]]);
    expect(second.add.mock.calls).toEqual([[1, { kind: 'rows-added' }], [1, { kind: 'rows-added' }]]);
    expect(second.createCounter).toHaveBeenCalledTimes(1);
  });

  it('records into the no-op meter while no provider is registered', async () => {
    const { recordViewSemanticsDelta } = await import('../src/view-semantics-delta-metric.js');
    expect(() => recordViewSemanticsDelta('none')).not.toThrow();
  });
});
