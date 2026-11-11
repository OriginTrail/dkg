import { afterEach, describe, expect, it, vi } from 'vitest';
import { metrics } from '@opentelemetry/api';

describe('recordViewSemanticsDelta', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('counts each sampled query by kind on one counter of the node meter', async () => {
    const add = vi.fn();
    const createCounter = vi.fn(() => ({ add }));
    const getMeter = vi.spyOn(metrics, 'getMeter').mockReturnValue({ createCounter } as never);
    const { recordViewSemanticsDelta } = await import('../src/view-semantics-delta-metric.js');
    recordViewSemanticsDelta('rows-added');
    recordViewSemanticsDelta('none');
    expect(getMeter).toHaveBeenCalledWith('@origintrail-official/dkg');
    expect(createCounter).toHaveBeenCalledTimes(1);
    expect(createCounter).toHaveBeenCalledWith('dkg.query.view_semantics_delta', expect.objectContaining({ description: expect.any(String) }));
    expect(add.mock.calls).toEqual([[1, { kind: 'rows-added' }], [1, { kind: 'none' }]]);
  });

  it('records into the no-op meter while no provider is registered', async () => {
    const { recordViewSemanticsDelta } = await import('../src/view-semantics-delta-metric.js');
    expect(() => recordViewSemanticsDelta('none')).not.toThrow();
  });
});
