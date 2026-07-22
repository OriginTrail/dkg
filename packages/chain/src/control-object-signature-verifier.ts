import {
  assertCanonicalChainId,
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  canonicalizeSignedControlEnvelopeBytes,
  computeControlSignatureVariantDigestHex,
  parseCanonicalSignedControlEnvelope,
  type BlockNumberV1,
  type ChainIdV1,
  type ControlObjectSignatureSuite,
  type Digest32V1,
  type EvmAddressV1,
  type SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import {
  type CurrentFinalizedEvmCallRequestV1,
  type CurrentFinalizedEvmCallResultV1,
  type CurrentFinalizedEvmCallV1,
} from './current-finalized-evm-call-model.js';
import {
  CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1,
  CURRENT_FINALIZED_EVM_READ_CALL_FROM_V1,
  CURRENT_FINALIZED_EVM_READ_ENDPOINT_ATTEMPT_POLICY_V1,
  CURRENT_FINALIZED_EVM_READ_GAS_LIMIT_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_CONCURRENT_PER_CHAIN_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_RPC_RESPONSE_BYTES_V1,
  CURRENT_FINALIZED_EVM_READ_TOTAL_DEADLINE_MS_V1,
  CURRENT_FINALIZED_EVM_CALL_ERROR_CODES_V1,
  CurrentFinalizedEvmCallErrorV1,
  type CurrentFinalizedEvmCallErrorCodeV1,
} from './current-finalized-evm-read-profile.js';

export {
  CURRENT_FINALIZED_EVM_CALL_ERROR_CODES_V1,
  CurrentFinalizedEvmCallErrorV1,
  type CurrentFinalizedEvmCallErrorCodeV1,
} from './current-finalized-evm-read-profile.js';
export {
  type CurrentFinalizedEvmCallRequestV1,
  type CurrentFinalizedEvmCallResultV1,
  type CurrentFinalizedEvmCallV1,
} from './current-finalized-evm-call-model.js';

export const EIP1271_MAGIC_VALUE_V1 = '0x1626ba7e' as const;
export const EIP1271_CANONICAL_ABI_RETURN_V1 =
  `0x${EIP1271_MAGIC_VALUE_V1.slice(2)}${'00'.repeat(28)}` as const;
export const CONTROL_EIP1271_GAS_LIMIT_V1 = CURRENT_FINALIZED_EVM_READ_GAS_LIMIT_V1;
export const CONTROL_EIP1271_MAX_RETURN_BYTES_V1 = 32;
export const CONTROL_EIP1271_MAX_RPC_RESPONSE_BYTES_V1 =
  CURRENT_FINALIZED_EVM_READ_MAX_RPC_RESPONSE_BYTES_V1;
export const CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1 =
  CURRENT_FINALIZED_EVM_READ_ATTEMPT_TIMEOUT_MS_V1;
export const CONTROL_EIP1271_MAX_ATTEMPTS_V1 = CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1;
export const CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1 =
  CURRENT_FINALIZED_EVM_READ_TOTAL_DEADLINE_MS_V1;
export const CONTROL_EIP1271_MAX_CONCURRENT_CALLS_PER_CHAIN_V1 =
  CURRENT_FINALIZED_EVM_READ_MAX_CONCURRENT_PER_CHAIN_V1;
export const CONTROL_EIP1271_ENDPOINT_ATTEMPT_POLICY_V1 =
  CURRENT_FINALIZED_EVM_READ_ENDPOINT_ATTEMPT_POLICY_V1;
export const CONTROL_EIP1271_CALL_FROM_V1 = CURRENT_FINALIZED_EVM_READ_CALL_FROM_V1;

const SECP256K1_N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);
const SECP256K1_HALF_N = BigInt(
  '0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0',
);
const EIP1271_INTERFACE = new ethers.Interface([
  'function isValidSignature(bytes32,bytes) view returns (bytes4)',
]);
declare const VERIFIED_CONTROL_ENVELOPE_ISSUER_SIGNATURE_BRAND_V1: unique symbol;

export const CONTROL_SIGNATURE_VERIFICATION_ERROR_CODES_V1 = Object.freeze([
  'CONTROL_SIGNATURE_ENVELOPE_INVALID',
  'CONTROL_SIGNATURE_EIP191_NON_CANONICAL',
  'CONTROL_SIGNATURE_EIP191_INVALID',
  'CONTROL_SIGNATURE_ISSUER_MISMATCH',
  'CONTROL_SIGNATURE_EIP1271_INVALID',
  'CONTROL_SIGNATURE_EIP1271_RESOURCE_LIMIT',
  'CONTROL_SIGNATURE_CHAIN_UNSUPPORTED',
  'CONTROL_SIGNATURE_CHAIN_MISMATCH',
  'CONTROL_SIGNATURE_FINALIZED_STATE_UNAVAILABLE',
  'CONTROL_SIGNATURE_RPC_UNAVAILABLE',
  'CONTROL_SIGNATURE_RPC_TIMEOUT',
  'CONTROL_SIGNATURE_CONCURRENCY_SATURATED',
  'CONTROL_SIGNATURE_ABORTED',
] as const);

export type ControlSignatureVerificationErrorCodeV1 =
  (typeof CONTROL_SIGNATURE_VERIFICATION_ERROR_CODES_V1)[number];
export type ControlSignatureVerificationDispositionV1 =
  | 'invalid'
  | 'unsupported'
  | 'retryable-unavailable'
  | 'cancelled';
export type ControlSignatureVerificationReasonV1 =
  | 'no-code'
  | 'revert'
  | 'malformed-return'
  | 'wrong-magic';

export class ControlSignatureVerificationErrorV1 extends Error {
  readonly code: ControlSignatureVerificationErrorCodeV1;
  readonly disposition: ControlSignatureVerificationDispositionV1;
  readonly reason?: ControlSignatureVerificationReasonV1;

  constructor(
    code: ControlSignatureVerificationErrorCodeV1,
    disposition: ControlSignatureVerificationDispositionV1,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly reason?: ControlSignatureVerificationReasonV1;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ControlSignatureVerificationErrorV1';
    this.code = code;
    this.disposition = disposition;
    this.reason = options.reason;
  }
}

export interface VerifyControlEnvelopeIssuerSignatureOptionsV1 {
  readonly callEvmAtCurrentFinalized?: CurrentFinalizedEvmCallV1;
  readonly signal?: AbortSignal;
}

export interface VerifiedControlEnvelopeIssuerSignatureV1 {
  readonly [VERIFIED_CONTROL_ENVELOPE_ISSUER_SIGNATURE_BRAND_V1]: true;
}

/** Immutable evidence retained behind the process-local verification token. */
export interface VerifiedControlEnvelopeIssuerSignatureSnapshotV1 {
  readonly objectDigest: Digest32V1;
  readonly signatureVariantDigest: Digest32V1;
  readonly issuer: EvmAddressV1;
  readonly signatureSuite: ControlObjectSignatureSuite;
  readonly verificationEvidence:
    | { readonly kind: 'eip191' }
    | {
        readonly kind: 'eip1271-current-finalized';
        readonly chainId: ChainIdV1;
        readonly contractAddress: EvmAddressV1;
        readonly blockNumber: BlockNumberV1;
        readonly blockHash: Digest32V1;
      };
}

const VERIFIED_CONTROL_ENVELOPE_ISSUER_SIGNATURES_V1 = new WeakMap<
  object,
  VerifiedControlEnvelopeIssuerSignatureSnapshotV1
>();

/**
 * Verify only generic envelope cryptography. A successful result does not prove
 * that the issuer has object-specific owner/admin/catalog/checkpoint authority.
 */
export async function verifyControlEnvelopeIssuerSignatureV1(
  input: SignedControlEnvelopeV1,
  options: VerifyControlEnvelopeIssuerSignatureOptionsV1 = {},
): Promise<VerifiedControlEnvelopeIssuerSignatureV1> {
  const envelope = snapshotEnvelope(input);
  const objectDigest = asDigest32(envelope.objectDigest);
  const signatureVariantDigest = asDigest32(
    computeControlSignatureVariantDigestHex(envelope.objectDigest, envelope.signature),
  );
  const issuer = envelope.issuer as EvmAddressV1;

  if (envelope.signatureSuite === 'eip191-personal-sign-digest-v1') {
    verifyCanonicalEip191(envelope);
    return mintVerifiedControlEnvelopeIssuerSignatureV1({
      objectDigest,
      signatureVariantDigest,
      issuer,
      signatureSuite: envelope.signatureSuite,
      verificationEvidence: Object.freeze({ kind: 'eip191' as const }),
    });
  }

  const call = options.callEvmAtCurrentFinalized;
  if (call === undefined) {
    fail(
      'CONTROL_SIGNATURE_CHAIN_UNSUPPORTED',
      'unsupported',
      'No current-finalized EVM call gateway is configured for EIP-1271 verification',
    );
  }
  if (options.signal?.aborted) {
    fail('CONTROL_SIGNATURE_ABORTED', 'cancelled', 'EIP-1271 verification was aborted');
  }

  const controller = new AbortController();
  let rejectCallerAbort: ((reason: ControlSignatureVerificationErrorV1) => void) | undefined;
  const callerAbort = new Promise<never>((_resolve, reject) => {
    rejectCallerAbort = reject;
  });
  const abortFromCaller = (): void => {
    const error = new ControlSignatureVerificationErrorV1(
      'CONTROL_SIGNATURE_ABORTED',
      'cancelled',
      'EIP-1271 verification was aborted',
    );
    rejectCallerAbort?.(error);
    controller.abort(options.signal?.reason ?? error);
  };
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = Object.freeze({
      chainId: envelope.signatureEvidence.chainId as ChainIdV1,
      to: envelope.signatureEvidence.contractAddress as EvmAddressV1,
      data: EIP1271_INTERFACE.encodeFunctionData('isValidSignature', [
        envelope.objectDigest,
        envelope.signature,
      ]).toLowerCase(),
      maxReturnBytes: CONTROL_EIP1271_MAX_RETURN_BYTES_V1,
      signal: controller.signal,
    } satisfies CurrentFinalizedEvmCallRequestV1);

    // Classify the injected gateway on its own promise branch.  In particular,
    // a gateway must not be able to throw this verifier's public error class and
    // thereby impersonate a locally-created timeout/cancellation or downgrade a
    // transport failure into cryptographic invalidity.
    const callPromise = Promise.resolve()
      .then(() => call(request))
      .catch((cause: unknown) => mapFinalizedCallFailure(cause, options.signal));
    void callPromise.catch(() => undefined);
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new ControlSignatureVerificationErrorV1(
          'CONTROL_SIGNATURE_RPC_TIMEOUT',
          'retryable-unavailable',
          `EIP-1271 verification exceeded ${CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1}ms`,
        );
        reject(error);
        controller.abort(error);
      }, CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1);
    });

    let result: CurrentFinalizedEvmCallResultV1;
    try {
      result = await Promise.race([callPromise, deadline, callerAbort]);
    } catch (cause) {
      if (cause instanceof ControlSignatureVerificationErrorV1) throw cause;
      mapFinalizedCallFailure(cause, options.signal);
    }

    const evidence = validateFinalizedCallResult(result, request.chainId);
    if (evidence.returnData !== EIP1271_CANONICAL_ABI_RETURN_V1) {
      fail(
        'CONTROL_SIGNATURE_EIP1271_INVALID',
        'invalid',
        'Contract wallet returned the wrong EIP-1271 magic value',
        { reason: 'wrong-magic' },
      );
    }

    return mintVerifiedControlEnvelopeIssuerSignatureV1({
      objectDigest,
      signatureVariantDigest,
      issuer,
      signatureSuite: envelope.signatureSuite,
      verificationEvidence: Object.freeze({
        kind: 'eip1271-current-finalized' as const,
        chainId: request.chainId,
        contractAddress: request.to,
        blockNumber: evidence.blockNumber,
        blockHash: evidence.blockHash,
      }),
    });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

/** Reject lookalikes, casts, clones, and serialized copies of verification tokens. */
export function assertVerifiedControlEnvelopeIssuerSignatureV1(
  value: unknown,
): asserts value is VerifiedControlEnvelopeIssuerSignatureV1 {
  if (
    (typeof value !== 'object' && typeof value !== 'function')
    || value === null
    || !VERIFIED_CONTROL_ENVELOPE_ISSUER_SIGNATURES_V1.has(value as object)
  ) {
    throw new TypeError(
      'control-envelope issuer signature token was not minted by this verifier',
    );
  }
}

export function readVerifiedControlEnvelopeIssuerSignatureV1(
  value: unknown,
): VerifiedControlEnvelopeIssuerSignatureSnapshotV1 {
  assertVerifiedControlEnvelopeIssuerSignatureV1(value);
  return VERIFIED_CONTROL_ENVELOPE_ISSUER_SIGNATURES_V1.get(value as object)!;
}

function mintVerifiedControlEnvelopeIssuerSignatureV1(
  snapshot: VerifiedControlEnvelopeIssuerSignatureSnapshotV1,
): VerifiedControlEnvelopeIssuerSignatureV1 {
  const immutable = Object.freeze({
    ...snapshot,
    verificationEvidence: Object.freeze({ ...snapshot.verificationEvidence }),
  }) as VerifiedControlEnvelopeIssuerSignatureSnapshotV1;
  const capability = Object.freeze(
    Object.create(null),
  ) as VerifiedControlEnvelopeIssuerSignatureV1;
  VERIFIED_CONTROL_ENVELOPE_ISSUER_SIGNATURES_V1.set(capability as object, immutable);
  return capability;
}

function snapshotEnvelope(input: SignedControlEnvelopeV1): SignedControlEnvelopeV1 {
  try {
    const bytes = canonicalizeSignedControlEnvelopeBytes(input);
    return deepFreezeJson(parseCanonicalSignedControlEnvelope(bytes)) as SignedControlEnvelopeV1;
  } catch (cause) {
    fail(
      'CONTROL_SIGNATURE_ENVELOPE_INVALID',
      'invalid',
      'Control-object envelope failed canonical structural validation',
      { cause },
    );
  }
}

function verifyCanonicalEip191(envelope: SignedControlEnvelopeV1): void {
  const r = BigInt(`0x${envelope.signature.slice(2, 66)}`);
  const s = BigInt(`0x${envelope.signature.slice(66, 130)}`);
  const v = envelope.signature.slice(130, 132);
  if (
    (v !== '1b' && v !== '1c')
    || r < 1n
    || r >= SECP256K1_N
    || s < 1n
    || s > SECP256K1_HALF_N
  ) {
    fail(
      'CONTROL_SIGNATURE_EIP191_NON_CANONICAL',
      'invalid',
      'EIP-191 signature must use canonical r, low-s, and v=27/28 encoding',
    );
  }

  let recovered: string;
  try {
    const signature = ethers.Signature.from(envelope.signature);
    if (signature.serialized !== envelope.signature) {
      fail(
        'CONTROL_SIGNATURE_EIP191_NON_CANONICAL',
        'invalid',
        'EIP-191 signature encoding is not canonical',
      );
    }
    recovered = ethers.verifyMessage(
      ethers.getBytes(envelope.objectDigest),
      signature,
    ).toLowerCase();
  } catch (cause) {
    if (cause instanceof ControlSignatureVerificationErrorV1) throw cause;
    fail(
      'CONTROL_SIGNATURE_EIP191_INVALID',
      'invalid',
      'EIP-191 signature is unrecoverable',
      { cause },
    );
  }
  if (recovered !== envelope.issuer) {
    fail(
      'CONTROL_SIGNATURE_ISSUER_MISMATCH',
      'invalid',
      'EIP-191 recovered signer does not equal the signed envelope issuer',
    );
  }
}

function validateFinalizedCallResult(
  input: unknown,
  expectedChainId: ChainIdV1,
): CurrentFinalizedEvmCallResultV1 {
  let anchor: Readonly<{
    chainId: ChainIdV1;
    blockNumber: BlockNumberV1;
    blockHash: Digest32V1;
    returnData: unknown;
  }>;
  try {
    if (!isPlainRecord(input)) throw new Error('result is not a plain record');
    assertExactDataKeys(input, ['blockHash', 'blockNumber', 'chainId', 'returnData']);
    const snapshot = {
      chainId: input.chainId,
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
      returnData: input.returnData,
    };
    assertCanonicalChainId(snapshot.chainId, 'current-finalized result chainId');
    assertCanonicalDecimalU64(snapshot.blockNumber, 'current-finalized blockNumber');
    assertCanonicalDigest(snapshot.blockHash, 'current-finalized blockHash');
    anchor = Object.freeze(snapshot) as typeof anchor;
  } catch (cause) {
    fail(
      'CONTROL_SIGNATURE_RPC_UNAVAILABLE',
      'retryable-unavailable',
      'Current-finalized gateway returned malformed anchor evidence',
      { cause },
    );
  }
  if (anchor.chainId !== expectedChainId) {
    fail(
      'CONTROL_SIGNATURE_CHAIN_MISMATCH',
      'retryable-unavailable',
      'Current-finalized gateway returned a different chain than the signed evidence',
    );
  }
  if (
    typeof anchor.returnData !== 'string'
    || !/^0x[0-9a-f]{64}$/.test(anchor.returnData)
  ) {
    fail(
      'CONTROL_SIGNATURE_EIP1271_INVALID',
      'invalid',
      'EIP-1271 current-finalized call returned malformed raw ABI data',
      { reason: 'malformed-return' },
    );
  }
  return Object.freeze({
    chainId: anchor.chainId,
    blockNumber: anchor.blockNumber,
    blockHash: anchor.blockHash,
    returnData: anchor.returnData,
  });
}

function mapFinalizedCallFailure(cause: unknown, signal: AbortSignal | undefined): never {
  if (signal?.aborted) {
    fail('CONTROL_SIGNATURE_ABORTED', 'cancelled', 'EIP-1271 verification was aborted', {
      cause,
    });
  }
  const gatewayFailure = snapshotFinalizedCallFailure(cause);
  if (gatewayFailure === undefined) {
    fail(
      'CONTROL_SIGNATURE_RPC_UNAVAILABLE',
      'retryable-unavailable',
      'Current-finalized EIP-1271 RPC failed closed',
    );
  }
  switch (gatewayFailure.code) {
    case 'unsupported-chain':
      fail('CONTROL_SIGNATURE_CHAIN_UNSUPPORTED', 'unsupported', gatewayFailure.message, { cause });
    case 'chain-mismatch':
      fail(
        'CONTROL_SIGNATURE_CHAIN_MISMATCH',
        'retryable-unavailable',
        gatewayFailure.message,
        { cause },
      );
    case 'finalized-state-unavailable':
      fail(
        'CONTROL_SIGNATURE_FINALIZED_STATE_UNAVAILABLE',
        'retryable-unavailable',
        gatewayFailure.message,
        { cause },
      );
    case 'rpc-unavailable':
      fail('CONTROL_SIGNATURE_RPC_UNAVAILABLE', 'retryable-unavailable', gatewayFailure.message, {
        cause,
      });
    case 'rpc-timeout':
      fail('CONTROL_SIGNATURE_RPC_TIMEOUT', 'retryable-unavailable', gatewayFailure.message, { cause });
    case 'concurrency-saturated':
      fail(
        'CONTROL_SIGNATURE_CONCURRENCY_SATURATED',
        'retryable-unavailable',
        gatewayFailure.message,
        { cause },
      );
    case 'resource-limit':
      fail('CONTROL_SIGNATURE_EIP1271_RESOURCE_LIMIT', 'unsupported', gatewayFailure.message, {
        cause,
      });
    case 'revert':
      fail('CONTROL_SIGNATURE_EIP1271_INVALID', 'invalid', gatewayFailure.message, {
        cause,
        reason: 'revert',
      });
    case 'no-code':
      fail('CONTROL_SIGNATURE_EIP1271_INVALID', 'invalid', gatewayFailure.message, {
        cause,
        reason: 'no-code',
      });
    case 'malformed-return':
      fail('CONTROL_SIGNATURE_EIP1271_INVALID', 'invalid', gatewayFailure.message, {
        cause,
        reason: 'malformed-return',
      });
    default:
      fail(
        'CONTROL_SIGNATURE_RPC_UNAVAILABLE',
        'retryable-unavailable',
        'Current-finalized EVM gateway returned an unknown failure code',
        { cause },
      );
  }
}

function snapshotFinalizedCallFailure(
  cause: unknown,
): Readonly<{ code: CurrentFinalizedEvmCallErrorCodeV1; message: string }> | undefined {
  try {
    if (!(cause instanceof CurrentFinalizedEvmCallErrorV1)) return undefined;
    const code = cause.code;
    const message = cause.message;
    if (
      !CURRENT_FINALIZED_EVM_CALL_ERROR_CODES_V1.includes(code)
      || typeof message !== 'string'
    ) {
      return undefined;
    }
    return Object.freeze({ code, message });
  } catch {
    // A rejected thenable may supply a Proxy whose prototype/property traps
    // throw.  Such foreign data is transport-unavailable, never verifier-owned
    // invalidity or cancellation.
    return undefined;
  }
}

function assertExactDataKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Reflect.ownKeys(record);
  if (
    actual.some((key) => typeof key !== 'string')
    || actual.length !== expected.length
    || (actual as string[]).sort().some((key, index) => key !== expected[index])
  ) {
    throw new Error('current-finalized result has unknown or missing fields');
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error('current-finalized result fields must be enumerable data properties');
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreezeJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item);
    return Object.freeze(value);
  }
  for (const item of Object.values(value)) deepFreezeJson(item);
  return Object.freeze(value);
}

function asDigest32(value: string): Digest32V1 {
  assertCanonicalDigest(value);
  return value;
}

function fail(
  code: ControlSignatureVerificationErrorCodeV1,
  disposition: ControlSignatureVerificationDispositionV1,
  message: string,
  options: {
    readonly cause?: unknown;
    readonly reason?: ControlSignatureVerificationReasonV1;
  } = {},
): never {
  throw new ControlSignatureVerificationErrorV1(code, disposition, message, options);
}
