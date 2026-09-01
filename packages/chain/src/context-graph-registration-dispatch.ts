import type {
  ContextGraphRegistrationCoverage,
  ContextGraphRegistrationDepositPolicy,
} from './chain-adapter.js';

export type ContextGraphLegacyCreateArgs = readonly [
  participantAgents: readonly string[],
  metadataBatchId: bigint,
  accessPolicy: number,
  publishPolicy: number,
  publishAuthority: string,
  publishAuthorityAccountId: bigint,
  nameHash: string,
];

export type ContextGraphCreateDispatch =
  | {
      method: 'createContextGraph';
      args: ContextGraphLegacyCreateArgs;
    }
  | {
      method: 'createContextGraphWithPcaCoverage';
      args: readonly [
        ...ContextGraphLegacyCreateArgs,
        registrationPcaAccountId: bigint,
      ];
    };

type UnsupportedFacadeDisposition = 'reject' | 'paid-legacy-fallback';

/**
 * Internal, sealed registration decision. Call boundaries derive this once;
 * transaction submission never combines public policy with coverage metadata.
 */
export type ContextGraphRegistrationExecutionPolicy =
  | { mode: 'legacy' }
  | { mode: 'paid'; unsupportedFacade: 'reject' }
  | {
      mode: 'pca';
      accountId: bigint;
      selector: 'additive';
      unsupportedFacade: 'reject';
    }
  | {
      mode: 'pca';
      accountId: bigint;
      selector: 'legacy-when-authority';
      unsupportedFacade: UnsupportedFacadeDisposition;
    };

export type ContextGraphFacadeCapability =
  | { state: 'supported'; version: string }
  | { state: 'unsupported'; version: string };

export type ContextGraphCreateDispatchResolution =
  | { state: 'resolved'; dispatch: ContextGraphCreateDispatch }
  | {
      state: 'unsupported';
      registrationMode: 'paid' | 'pca';
      facadeVersion: string;
    };

function legacyDispatch(legacyArgs: ContextGraphLegacyCreateArgs): ContextGraphCreateDispatch {
  return { method: 'createContextGraph', args: legacyArgs };
}

function additiveDispatch(
  legacyArgs: ContextGraphLegacyCreateArgs,
  accountId: bigint,
): ContextGraphCreateDispatch {
  return {
    method: 'createContextGraphWithPcaCoverage',
    args: [...legacyArgs, accountId],
  };
}

function assertPositivePcaAccountId(accountId: bigint): void {
  if (accountId <= 0n) {
    throw new RangeError('PCA registration-deposit policy requires a positive accountId.');
  }
}

export function executionPolicyFromDepositPolicy(
  policy?: ContextGraphRegistrationDepositPolicy,
): ContextGraphRegistrationExecutionPolicy {
  const resolvedPolicy: ContextGraphRegistrationDepositPolicy = policy ?? { mode: 'legacy' };
  switch (resolvedPolicy.mode) {
    case 'legacy':
      return { mode: 'legacy' };
    case 'paid':
      return { mode: 'paid', unsupportedFacade: 'reject' };
    case 'pca':
      assertPositivePcaAccountId(resolvedPolicy.accountId);
      return {
        mode: 'pca',
        accountId: resolvedPolicy.accountId,
        selector: 'additive',
        unsupportedFacade: 'reject',
      };
    default:
      throw new Error('Unsupported Context Graph registration-deposit policy.');
  }
}

export function executionPolicyFromCoverage(
  coverage: Readonly<ContextGraphRegistrationCoverage>,
): ContextGraphRegistrationExecutionPolicy {
  if (coverage.source === 'none') return { mode: 'legacy' };
  assertPositivePcaAccountId(coverage.accountId);
  return {
    mode: 'pca',
    accountId: coverage.accountId,
    selector: 'legacy-when-authority',
    unsupportedFacade: coverage.source === 'explicit'
      ? 'reject'
      : 'paid-legacy-fallback',
  };
}

/**
 * Resolve the sealed policy to one selector. The facade read stays lazy so
 * legacy calls and authority-compatible PCA calls preserve old-facade support.
 */
export async function resolveContextGraphCreateDispatch(
  legacyArgs: ContextGraphLegacyCreateArgs,
  legacyCoverageAccountId: bigint,
  policy: ContextGraphRegistrationExecutionPolicy,
  readFacadeCapability: () => Promise<ContextGraphFacadeCapability>,
): Promise<ContextGraphCreateDispatchResolution> {
  if (policy.mode === 'legacy') {
    return { state: 'resolved', dispatch: legacyDispatch(legacyArgs) };
  }
  if (
    policy.mode === 'pca'
    && policy.selector === 'legacy-when-authority'
    && policy.accountId === legacyCoverageAccountId
  ) {
    return { state: 'resolved', dispatch: legacyDispatch(legacyArgs) };
  }

  const facade = await readFacadeCapability();
  if (facade.state === 'unsupported') {
    if (policy.mode === 'pca' && policy.unsupportedFacade === 'paid-legacy-fallback') {
      return { state: 'resolved', dispatch: legacyDispatch(legacyArgs) };
    }
    return {
      state: 'unsupported',
      registrationMode: policy.mode,
      facadeVersion: facade.version,
    };
  }

  return {
    state: 'resolved',
    dispatch: policy.mode === 'paid'
      ? additiveDispatch(legacyArgs, 0n)
      : additiveDispatch(legacyArgs, policy.accountId),
  };
}
