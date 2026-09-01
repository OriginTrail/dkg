import { describe, expect, it } from 'vitest';
import { resolveContextGraphCreateDispatch } from '../src/context-graph-registration-dispatch.js';

describe('Context Graph registration-deposit dispatch', () => {
  const legacyArgs = ['participants', 42n, 0, 1, 'authority', 7n, 'nameHash'] as const;

  it('preserves legacy selector compatibility for omission and explicit legacy policy', () => {
    const omitted = resolveContextGraphCreateDispatch(legacyArgs);
    const explicit = resolveContextGraphCreateDispatch(legacyArgs, { mode: 'legacy' });

    expect(omitted).toEqual({ method: 'createContextGraph', args: [...legacyArgs] });
    expect(explicit).toEqual(omitted);
  });

  it('dispatches explicit PCA coverage through the additive selector', () => {
    expect(resolveContextGraphCreateDispatch(legacyArgs, { mode: 'pca', accountId: 19n }))
      .toEqual({
        method: 'createContextGraphWithPcaCoverage',
        args: [...legacyArgs, 19n],
      });
  });

  it('dispatches explicit paid registration through additive zero coverage', () => {
    expect(resolveContextGraphCreateDispatch(legacyArgs, { mode: 'paid' })).toEqual({
      method: 'createContextGraphWithPcaCoverage',
      args: [...legacyArgs, 0n],
    });
  });

  it('rejects a PCA policy that collapses into paid semantics', () => {
    expect(() => resolveContextGraphCreateDispatch(legacyArgs, { mode: 'pca', accountId: 0n }))
      .toThrow(/positive accountId/);
  });
});
