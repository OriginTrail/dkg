import { describe, expect, it } from 'vitest';
import {
  executionPolicyFromCoverage,
  executionPolicyFromDepositPolicy,
  resolveContextGraphCreateDispatch,
  type ContextGraphFacadeCapability,
  type ContextGraphLegacyCreateArgs,
} from '../src/context-graph-registration-dispatch.js';

describe('Context Graph registration-deposit dispatch', () => {
  const legacyArgs: ContextGraphLegacyCreateArgs = [
    ['participant'],
    42n,
    0,
    1,
    'authority',
    7n,
    'nameHash',
  ];
  const facade = (state: ContextGraphFacadeCapability['state']) => async () => ({
    state,
    version: state === 'supported' ? '10.0.5' : '10.0.4',
  }) as ContextGraphFacadeCapability;

  it('derives one execution policy for every direct public policy', () => {
    expect(executionPolicyFromDepositPolicy()).toEqual({ mode: 'legacy' });
    expect(executionPolicyFromDepositPolicy({ mode: 'legacy' })).toEqual({ mode: 'legacy' });
    expect(executionPolicyFromDepositPolicy({ mode: 'paid' })).toEqual({
      mode: 'paid',
      unsupportedFacade: 'reject',
    });
    expect(executionPolicyFromDepositPolicy({ mode: 'pca', accountId: 19n })).toEqual({
      mode: 'pca',
      accountId: 19n,
      selector: 'additive',
      unsupportedFacade: 'reject',
    });
  });

  it('derives explicit and automatic prepared coverage with distinct old-facade dispositions', () => {
    expect(executionPolicyFromCoverage({ source: 'none' })).toEqual({ mode: 'legacy' });
    expect(executionPolicyFromCoverage({ source: 'explicit', accountId: 19n })).toEqual({
      mode: 'pca',
      accountId: 19n,
      selector: 'legacy-when-authority',
      unsupportedFacade: 'reject',
    });
    for (const source of ['owned', 'agent'] as const) {
      expect(executionPolicyFromCoverage({ source, accountId: 19n })).toEqual({
        mode: 'pca',
        accountId: 19n,
        selector: 'legacy-when-authority',
        unsupportedFacade: 'paid-legacy-fallback',
      });
    }
  });

  it('preserves legacy omission without reading facade capability', async () => {
    let reads = 0;
    const resolved = await resolveContextGraphCreateDispatch(
      legacyArgs,
      0n,
      executionPolicyFromDepositPolicy(),
      async () => { reads += 1; return facade('supported')(); },
    );

    expect(resolved).toEqual({
      state: 'resolved',
      dispatch: { method: 'createContextGraph', args: [...legacyArgs] },
    });
    expect(reads).toBe(0);
  });

  it('dispatches direct PCA additively even when graph authority has the same account', async () => {
    await expect(resolveContextGraphCreateDispatch(
      legacyArgs,
      19n,
      executionPolicyFromDepositPolicy({ mode: 'pca', accountId: 19n }),
      facade('supported'),
    )).resolves.toEqual({
      state: 'resolved',
      dispatch: {
        method: 'createContextGraphWithPcaCoverage',
        args: [...legacyArgs, 19n],
      },
    });
  });

  it('dispatches direct paid registration through additive zero coverage', async () => {
    await expect(resolveContextGraphCreateDispatch(
      legacyArgs,
      0n,
      executionPolicyFromDepositPolicy({ mode: 'paid' }),
      facade('supported'),
    )).resolves.toEqual({
      state: 'resolved',
      dispatch: {
        method: 'createContextGraphWithPcaCoverage',
        args: [...legacyArgs, 0n],
      },
    });
  });

  it('keeps authority-compatible prepared coverage on the legacy selector without a facade read', async () => {
    let reads = 0;
    const resolved = await resolveContextGraphCreateDispatch(
      legacyArgs,
      19n,
      executionPolicyFromCoverage({ source: 'explicit', accountId: 19n }),
      async () => { reads += 1; return facade('unsupported')(); },
    );

    expect(resolved).toEqual({
      state: 'resolved',
      dispatch: { method: 'createContextGraph', args: [...legacyArgs] },
    });
    expect(reads).toBe(0);
  });

  it('rejects explicit PCA and paid policies on an unsupported facade', async () => {
    const policies = [
      executionPolicyFromDepositPolicy({ mode: 'pca', accountId: 19n }),
      executionPolicyFromCoverage({ source: 'explicit', accountId: 19n }),
      executionPolicyFromDepositPolicy({ mode: 'paid' }),
    ];
    for (const policy of policies) {
      await expect(resolveContextGraphCreateDispatch(
        legacyArgs,
        0n,
        policy,
        facade('unsupported'),
      )).resolves.toMatchObject({
        state: 'unsupported',
        facadeVersion: '10.0.4',
      });
    }
  });

  it('falls automatic PCA coverage back to paid legacy on an unsupported facade', async () => {
    await expect(resolveContextGraphCreateDispatch(
      legacyArgs,
      0n,
      executionPolicyFromCoverage({ source: 'owned', accountId: 19n }),
      facade('unsupported'),
    )).resolves.toEqual({
      state: 'resolved',
      dispatch: { method: 'createContextGraph', args: [...legacyArgs] },
    });
  });

  it('rejects a PCA policy that collapses into paid semantics', () => {
    expect(() => executionPolicyFromDepositPolicy({ mode: 'pca', accountId: 0n }))
      .toThrow(/positive accountId/);
  });
});
