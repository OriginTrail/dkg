import type { PromoteFailureDisposition } from '@origintrail-official/dkg-publisher';
import type { ClassifiedPromoteError } from '../src/daemon/worker/async-promote-error-classification.js';

type AssertTrue<Value extends true> = Value;
type AssertFalse<Value extends false> = Value;
type RetryDiagnostic = Extract<PromoteFailureDisposition, { retryable: true }>['diagnostic'];
type TerminalDiagnostic = Extract<PromoteFailureDisposition, { retryable: false }>['diagnostic'];

export type PublisherUnionIsPreserved = AssertTrue<
  PromoteFailureDisposition extends ClassifiedPromoteError ? true : false
>;
export type RetryDiagnosticCannotBeFatal = AssertFalse<{
  classification: 'fatal'; retryable: false; diagnostic: RetryDiagnostic;
} extends ClassifiedPromoteError ? true : false>;
export type TerminalDiagnosticCannotRetry = AssertFalse<{
  classification: 'transient'; retryable: true; diagnostic: TerminalDiagnostic;
} extends ClassifiedPromoteError ? true : false>;
export type FallbackHasNoPublisherDiagnostic = AssertFalse<{
  classification: 'cap_exceeded'; retryable: false; diagnostic: RetryDiagnostic;
} extends ClassifiedPromoteError ? true : false>;
export type ProseFallbackRemainsSupported = AssertTrue<{
  classification: 'cap_exceeded'; retryable: false;
} extends ClassifiedPromoteError ? true : false>;
