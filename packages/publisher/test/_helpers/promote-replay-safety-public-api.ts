type PublisherApi = typeof import('../../src/index.js');

type AssertTrue<Value extends true> = Value;
type AssertFalse<Value extends false> = Value;

type PromoteFailureDispositionIsPublic = AssertTrue<
  'getPromoteFailureDisposition' extends keyof PublisherApi ? true : false
>;
type ParallelReplaySafeGuardStaysInternal = AssertFalse<
  'isPromoteReplaySafeError' extends keyof PublisherApi ? true : false
>;
type ParallelReplaySafeDiagnosticStaysInternal = AssertFalse<
  'getPromoteReplaySafeErrorDiagnostic' extends keyof PublisherApi ? true : false
>;
type ParallelRetryableGuardStaysInternal = AssertFalse<
  'isPromoteRetryableFailure' extends keyof PublisherApi ? true : false
>;
type RetryableMarkerCodeStaysInternal = AssertFalse<
  'PROMOTE_RETRYABLE_FAILURE_CODE' extends keyof PublisherApi ? true : false
>;
type ReplaySafeUnwrapperStaysAbsent = AssertFalse<
  'unwrapPromoteReplaySafeError' extends keyof PublisherApi ? true : false
>;
type ReplaySafeCertifierStaysInternal = AssertFalse<
  'classifyExactSwmGraphReplaceFailure' extends keyof PublisherApi ? true : false
>;
type ReplaySafeConstructorStaysInternal = AssertFalse<
  'PromoteReplaySafeError' extends keyof PublisherApi ? true : false
>;
type ReplaySafeCodeStaysInternal = AssertFalse<
  'PROMOTE_REPLAY_SAFE_ERROR_CODE' extends keyof PublisherApi ? true : false
>;
// @ts-expect-error Producer certification must not be importable as a package subpath.
type ReplaySafetyDeepModuleStaysClosed = typeof import('@origintrail-official/dkg-publisher/dist/promote-replay-safety.js');
// @ts-expect-error Unlisted implementation modules remain private by default.
type ArbitraryPublisherImplementationStaysClosed = typeof import('@origintrail-official/dkg-publisher/dist/dkg-publisher.js');
type LegacyWorkspaceResolutionSubpathRemainsAvailable =
  typeof import('@origintrail-official/dkg-publisher/dist/workspace-resolution.js');

export type {
  PromoteFailureDispositionIsPublic,
  ParallelReplaySafeGuardStaysInternal,
  ParallelReplaySafeDiagnosticStaysInternal,
  ParallelRetryableGuardStaysInternal,
  RetryableMarkerCodeStaysInternal,
  ReplaySafeUnwrapperStaysAbsent,
  ReplaySafeCertifierStaysInternal,
  ReplaySafeConstructorStaysInternal,
  ReplaySafeCodeStaysInternal,
  ReplaySafetyDeepModuleStaysClosed,
  ArbitraryPublisherImplementationStaysClosed,
  LegacyWorkspaceResolutionSubpathRemainsAvailable,
};
