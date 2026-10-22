// SPDX-License-Identifier: Apache-2.0

/**
 * Conviction Account service spending (OT-RFC-27): the adapter's error types.
 *
 * Both adapters throw the same three types, so a caller classifies a failure
 * by its `kind` alone, whatever the chain:
 *   - `ConvictionServiceRevertError`: a contract refused the call. The custom
 *     error is decoded from the revert data (`enrichEvmError` decodes every
 *     vendored ABI) and classified by `CONVICTION_SERVICE_REVERT_KINDS`, which
 *     lists every error a service-spending call can revert with, nested
 *     reverts of the NFT, the account storage and the Hub included.
 *   - `ConvictionServiceUnavailableError`: the Hub has no service contracts,
 *     or the node cannot sign as the buyer key.
 *   - `ConvictionServiceInputError`: an argument the contracts cannot encode.
 * RPC, transport and signer failures pass through untouched.
 */
import type { ethers } from 'ethers';
import { enrichEvmError, getErrorInterface, isCausedByRemoteSigner } from './evm-adapter-errors.js';
import { HubContractNotFoundError } from './hub-contract-not-found-error.js';

/**
 * How a failure should be answered:
 * `invalid` 400, `forbidden` 403, `not-found` 404, `conflict` 409,
 * `unavailable` 503, `internal` 500.
 */
export type ConvictionServiceErrorKind =
  | 'invalid'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'unavailable'
  | 'internal';

/** Every custom error a service-spending call can revert with, and its kind. */
export const CONVICTION_SERVICE_REVERT_KINDS: Readonly<Record<string, ConvictionServiceErrorKind>> = Object.freeze({
  // The request itself is wrong.
  InvalidAssignmentTerms: 'invalid',
  InvalidFundingRequest: 'invalid',
  ConsentMissing: 'invalid',
  InvalidConsentSignature: 'invalid',
  ZeroServiceValue: 'invalid',
  // The sender may not do this: it does not own the account, or holds no assignment.
  NotAccountOwner: 'forbidden',
  NotAssigned: 'forbidden',
  // No such account: the account storage's and the NFT's refusals.
  UnknownAccount: 'not-found',
  ERC721NonexistentToken: 'not-found',
  // The state of the account, the assignment or the period refuses it.
  ServiceSpendingDisabled: 'conflict',
  ServiceSpendingUnchanged: 'conflict',
  InvalidAssignmentNonce: 'conflict',
  AssignmentRevoked: 'conflict',
  AssignmentExpired: 'conflict',
  CapsUnchanged: 'conflict',
  CapExceeded: 'conflict',
  PeriodAlreadyFunded: 'conflict',
  SubscriptionExists: 'conflict',
  LabelCapacityExceeded: 'conflict',
  InsufficientAllowance: 'conflict',
  AccountExpired: 'conflict',
  // The chain cannot serve service spending now: the schedule cut-over is not
  // set, a protocol treasury is wired, or a deployment is incomplete (a
  // dependency missing from the Hub, `PublishingConviction` not recognising the
  // Hub's `ServiceSubscriptions`, a stale binding the Hub self-heal retry did
  // not clear).
  ExactScheduleFromUnset: 'unavailable',
  ServiceFundingPausedTreasuryWired: 'unavailable',
  OnlyServiceSubscriptions: 'unavailable',
  ContractDoesNotExist: 'unavailable',
  ContractNotRegistered: 'unavailable',
  AddressDoesNotExist: 'unavailable',
  ZeroAddressDependency: 'unavailable',
  UnauthorizedAccess: 'unavailable',
  // An invariant the contracts guard, or a governance-only setter: never the
  // caller's doing.
  DrawMismatch: 'internal',
  TopUpUnderflow: 'internal',
  SafeCastOverflowedUintDowncast: 'internal',
  ZeroLock: 'internal',
  WindowAmountsLengthMismatch: 'internal',
  InvalidTimeRemaining: 'internal',
  ExactScheduleFromAlreadySet: 'internal',
  InvalidParameter: 'internal',
  ZeroAddressHub: 'internal',
});

/** The kind of a revert; a revert outside the table (a panic, say) is `internal`. */
export function convictionServiceRevertKind(revertName: string): ConvictionServiceErrorKind {
  return Object.prototype.hasOwnProperty.call(CONVICTION_SERVICE_REVERT_KINDS, revertName)
    ? CONVICTION_SERVICE_REVERT_KINDS[revertName]!
    : 'internal';
}

export type ConvictionServiceErrorCode = 'CA_REVERT' | 'CA_UNAVAILABLE' | 'CA_INVALID_INPUT';

const CODES: ReadonlySet<string> = new Set<ConvictionServiceErrorCode>(['CA_REVERT', 'CA_UNAVAILABLE', 'CA_INVALID_INPUT']);

/** The base of the three service-spending error types. */
export class ConvictionServiceError extends Error {
  readonly code: ConvictionServiceErrorCode;
  readonly kind: ConvictionServiceErrorKind;

  constructor(code: ConvictionServiceErrorCode, kind: ConvictionServiceErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConvictionServiceError';
    this.code = code;
    this.kind = kind;
  }
}

/** A contract refused a service-spending call with `revertName(args)`. */
export class ConvictionServiceRevertError extends ConvictionServiceError {
  declare readonly code: 'CA_REVERT';
  readonly revertName: string;
  /** The error's arguments by their ABI names; integers are `bigint`. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly selector?: string;

  constructor(revertName: string, args: Record<string, unknown> = {}, options?: { selector?: string; cause?: unknown }) {
    super(
      'CA_REVERT',
      convictionServiceRevertKind(revertName),
      `Conviction Account service call reverted: ${revertName}(${Object.values(args).map(String).join(', ')})`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'ConvictionServiceRevertError';
    this.revertName = revertName;
    this.args = Object.freeze({ ...args });
    if (options?.selector !== undefined) this.selector = options.selector;
  }
}

/** The chain has no service contracts, or the node cannot act as the buyer key. */
export class ConvictionServiceUnavailableError extends ConvictionServiceError {
  declare readonly code: 'CA_UNAVAILABLE';

  constructor(
    message = 'Conviction Account service spending is not deployed on this Hub (no ServiceSubscriptions or ConvictionServiceStorage).',
    options?: ErrorOptions,
  ) {
    super('CA_UNAVAILABLE', 'unavailable', message, options);
    this.name = 'ConvictionServiceUnavailableError';
  }
}

/** An argument the contracts cannot take: a malformed address or hex value, an out-of-range integer. */
export class ConvictionServiceInputError extends ConvictionServiceError {
  declare readonly code: 'CA_INVALID_INPUT';

  constructor(message: string) {
    super('CA_INVALID_INPUT', 'invalid', message);
    this.name = 'ConvictionServiceInputError';
  }
}

function hasCode(err: unknown, code?: ConvictionServiceErrorCode): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const value = (err as { code?: unknown }).code;
  return code === undefined ? typeof value === 'string' && CODES.has(value) : value === code;
}

/** Duck-typed, so a copy of the class from another module instance still matches. */
export function isConvictionServiceError(err: unknown): err is ConvictionServiceError {
  return err instanceof ConvictionServiceError
    || (hasCode(err) && typeof (err as { kind?: unknown }).kind === 'string');
}

export function isConvictionServiceRevertError(err: unknown): err is ConvictionServiceRevertError {
  return err instanceof ConvictionServiceRevertError
    || (hasCode(err, 'CA_REVERT') && typeof (err as { revertName?: unknown }).revertName === 'string');
}

export function isConvictionServiceUnavailableError(err: unknown): err is ConvictionServiceUnavailableError {
  return err instanceof ConvictionServiceUnavailableError || hasCode(err, 'CA_UNAVAILABLE');
}

/** The Hub names of the service contracts: without them a chain has no service spending. */
const SERVICE_CONTRACT_NAMES: ReadonlySet<string> = new Set(['ServiceSubscriptions', 'ConvictionServiceStorage']);

/**
 * The typed form of `err`, or `null` when it is no contract refusal: an RPC,
 * transport or signer failure, which the caller rethrows as it is.
 */
export function convictionServiceErrorOf(err: unknown): ConvictionServiceError | null {
  if (isConvictionServiceError(err)) return err;
  if (err instanceof HubContractNotFoundError && SERVICE_CONTRACT_NAMES.has(err.contractName)) {
    return new ConvictionServiceUnavailableError(
      `${err.contractName} is not registered in the Hub at ${err.hubAddress}: this chain has no Conviction Account service spending.`,
      { cause: err },
    );
  }
  if (typeof err !== 'object' || err === null || isCausedByRemoteSigner(err)) return null;
  enrichEvmError(err);
  const revert = (err as { revert?: { name?: unknown; signature?: unknown; selector?: unknown; args?: unknown } }).revert;
  if (!revert || typeof revert.name !== 'string' || revert.name.length === 0) return null;
  const selector = typeof revert.selector === 'string' ? revert.selector : undefined;
  return new ConvictionServiceRevertError(revert.name, namedArgs(revert), { selector, cause: err });
}

/** The revert's arguments under the names its ABI fragment gives them. */
function namedArgs(revert: { name?: unknown; signature?: unknown; selector?: unknown; args?: unknown }): Record<string, unknown> {
  const values = revert.args == null ? [] : Array.from(revert.args as ArrayLike<unknown>);
  let fragment: ethers.ErrorFragment | null = null;
  for (const key of [revert.selector, revert.signature]) {
    if (typeof key !== 'string' || fragment) continue;
    try {
      fragment = getErrorInterface().getError(key);
    } catch {
      fragment = null;
    }
  }
  const out: Record<string, unknown> = {};
  values.forEach((value, i) => {
    out[fragment?.inputs[i]?.name || `arg${i}`] = value;
  });
  return out;
}
