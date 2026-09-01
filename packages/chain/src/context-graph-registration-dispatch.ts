import type { ContextGraphRegistrationDepositPolicy } from './chain-adapter.js';

export type ContextGraphCreateDispatch = {
  method: 'createContextGraph' | 'createContextGraphWithPcaCoverage';
  args: unknown[];
};

/** Keep selector compatibility at the EVM boundary, not in the shared policy. */
export function resolveContextGraphCreateDispatch(
  legacyArgs: readonly unknown[],
  policy?: ContextGraphRegistrationDepositPolicy,
): ContextGraphCreateDispatch {
  const resolvedPolicy: ContextGraphRegistrationDepositPolicy = policy ?? { mode: 'legacy' };
  switch (resolvedPolicy.mode) {
    case 'legacy':
      return { method: 'createContextGraph', args: [...legacyArgs] };
    case 'paid':
      return {
        method: 'createContextGraphWithPcaCoverage',
        args: [...legacyArgs, 0n],
      };
    case 'pca':
      if (resolvedPolicy.accountId <= 0n) {
        throw new Error('PCA registration-deposit policy requires a positive accountId.');
      }
      return {
        method: 'createContextGraphWithPcaCoverage',
        args: [...legacyArgs, resolvedPolicy.accountId],
      };
    default:
      throw new Error('Unsupported Context Graph registration-deposit policy.');
  }
}
