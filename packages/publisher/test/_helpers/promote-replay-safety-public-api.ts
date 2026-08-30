type PublisherApi = typeof import('../../src/index.js');

type AssertTrue<Value extends true> = Value;
type AssertFalse<Value extends false> = Value;

type ReplaySafeGuardIsPublic = AssertTrue<
  'isPromoteReplaySafeError' extends keyof PublisherApi ? true : false
>;
type ReplaySafeDiagnosticHelperIsPublic = AssertTrue<
  'getPromoteReplaySafeErrorDiagnostic' extends keyof PublisherApi ? true : false
>;
type ReplaySafeUnwrapperIsPublic = AssertTrue<
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

export type {
  ReplaySafeGuardIsPublic,
  ReplaySafeDiagnosticHelperIsPublic,
  ReplaySafeUnwrapperIsPublic,
  ReplaySafeCertifierStaysInternal,
  ReplaySafeConstructorStaysInternal,
  ReplaySafeCodeStaysInternal,
  ReplaySafetyDeepModuleStaysClosed,
};
