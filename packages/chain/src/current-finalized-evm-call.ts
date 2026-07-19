import {
  assertCanonicalChainId,
  type ChainIdV1,
} from '@origintrail-official/dkg-core';

import {
  CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1,
  CONTROL_EIP1271_CALL_FROM_V1,
  CONTROL_EIP1271_ENDPOINT_ATTEMPT_POLICY_V1,
  CONTROL_EIP1271_GAS_LIMIT_V1,
  CONTROL_EIP1271_MAX_ATTEMPTS_V1,
  CONTROL_EIP1271_MAX_CONCURRENT_CALLS_PER_CHAIN_V1,
  CONTROL_EIP1271_MAX_RPC_RESPONSE_BYTES_V1,
  CONTROL_EIP1271_MAX_RETURN_BYTES_V1,
  CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1,
  CURRENT_FINALIZED_EVM_CALL_ERROR_CODES_V1,
  CurrentFinalizedEvmCallErrorV1,
  type CurrentFinalizedEvmCallRequestV1,
  type CurrentFinalizedEvmCallResultV1,
  type CurrentFinalizedEvmCallV1,
} from './control-object-signature-verifier.js';

const REQUEST_KEYS = Object.freeze([
  'attemptTimeoutMs',
  'ccipReadEnabled',
  'chainId',
  'data',
  'endpointAttemptPolicy',
  'from',
  'gasLimit',
  'maxAttempts',
  'maxConcurrentCallsPerChain',
  'maxReturnBytes',
  'maxRpcResponseBytes',
  'signal',
  'to',
  'totalDeadlineMs',
] as const);
const CANONICAL_NONZERO_EVM_ADDRESS = /^0x(?!0{40}$)[0-9a-f]{40}$/;

/**
 * Per-chain trusted-local adapter seam. A later transport implementation owns
 * configured endpoint selection and the exact current-finalized block lookup.
 */
export interface CurrentFinalizedEvmChainAdapterV1 {
  (request: CurrentFinalizedEvmCallRequestV1): Promise<CurrentFinalizedEvmCallResultV1>;
}

export interface CurrentFinalizedEvmChainAdapterRegistrationV1 {
  readonly chainId: ChainIdV1;
  readonly adapter: CurrentFinalizedEvmChainAdapterV1;
}

/**
 * Build an immutable, non-queueing current-finalized call router.
 *
 * Registrations are snapshotted once. Peer-controlled data can select only a
 * canonical chain ID already present in this local registry; it can never
 * supply an RPC endpoint or block selector.
 */
export function createCurrentFinalizedEvmCallRouterV1(
  registrations: readonly CurrentFinalizedEvmChainAdapterRegistrationV1[],
): CurrentFinalizedEvmCallV1 {
  const adapters = snapshotAdapterRegistry(registrations);
  const inFlightByChain = new Map<ChainIdV1, number>();
  for (const chainId of adapters.keys()) inFlightByChain.set(chainId, 0);

  const route: CurrentFinalizedEvmCallV1 = async (input) => {
    const request = snapshotAndValidateRequest(input);
    const adapter = adapters.get(request.chainId);
    if (adapter === undefined) {
      throw new CurrentFinalizedEvmCallErrorV1(
        'unsupported-chain',
        `No current-finalized EVM adapter is configured for chain ${request.chainId}`,
      );
    }

    const active = inFlightByChain.get(request.chainId) ?? 0;
    if (active >= CONTROL_EIP1271_MAX_CONCURRENT_CALLS_PER_CHAIN_V1) {
      throw new CurrentFinalizedEvmCallErrorV1(
        'concurrency-saturated',
        `Chain ${request.chainId} already has ${active} current-finalized calls in flight`,
      );
    }
    inFlightByChain.set(request.chainId, active + 1);

    // Do not race this operation with request.signal. The verifier may stop
    // awaiting after caller cancellation, but this permit remains held until
    // the actual adapter operation settles (including adapters that ignore
    // abort), so abandoned work cannot evade the four-call ceiling.
    const operation = Promise.resolve()
      .then(() => adapter(request))
      .catch((cause: unknown) => {
        throw snapshotAdapterFailure(cause);
      });

    try {
      return await operation;
    } finally {
      const remaining = (inFlightByChain.get(request.chainId) ?? 1) - 1;
      inFlightByChain.set(request.chainId, Math.max(0, remaining));
    }
  };

  return Object.freeze(route);
}

function snapshotAdapterRegistry(
  input: unknown,
): ReadonlyMap<ChainIdV1, CurrentFinalizedEvmChainAdapterV1> {
  const registrations = snapshotDenseArray(input);
  const adapters = new Map<ChainIdV1, CurrentFinalizedEvmChainAdapterV1>();

  for (const registration of registrations) {
    const snapshot = snapshotRegistration(registration);
    if (adapters.has(snapshot.chainId)) {
      throw new TypeError(`Duplicate current-finalized adapter for chain ${snapshot.chainId}`);
    }
    adapters.set(snapshot.chainId, snapshot.adapter);
  }
  return adapters;
}

function snapshotDenseArray(input: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(input)) throw new Error('not an array');
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
    if (
      lengthDescriptor === undefined
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || typeof lengthDescriptor.value !== 'number'
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) {
      throw new Error('invalid array length');
    }

    const length = lengthDescriptor.value;
    const ownKeys = Reflect.ownKeys(input);
    if (
      ownKeys.length !== length + 1
      || ownKeys.some((key) => (
        typeof key !== 'string'
        || (key !== 'length' && !isCanonicalArrayIndex(key, length))
      ))
    ) {
      throw new Error('registrations must be a dense ordinary array');
    }

    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (
        descriptor === undefined
        || !descriptor.enumerable
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ) {
        throw new Error('registration entry must be an enumerable data property');
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch {
    throw new TypeError('Current-finalized adapter registrations must be a dense data-only array');
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function snapshotRegistration(input: unknown): Readonly<CurrentFinalizedEvmChainAdapterRegistrationV1> {
  let chainId: unknown;
  let adapter: unknown;
  try {
    const record = snapshotExactDataRecord(input, ['adapter', 'chainId']);
    chainId = record.chainId;
    adapter = record.adapter;
  } catch {
    throw new TypeError('Current-finalized adapter registration must be a plain data-only record');
  }

  try {
    assertCanonicalChainId(chainId, 'current-finalized adapter chainId');
  } catch {
    throw new TypeError('Current-finalized adapter chainId must be canonical decimal u256');
  }
  if (typeof adapter !== 'function') {
    throw new TypeError(`Current-finalized adapter for chain ${chainId} must be callable`);
  }
  return Object.freeze({
    chainId,
    adapter: adapter as CurrentFinalizedEvmChainAdapterV1,
  });
}

function snapshotAndValidateRequest(input: unknown): CurrentFinalizedEvmCallRequestV1 {
  try {
    const record = snapshotExactDataRecord(input, REQUEST_KEYS);
    assertCanonicalChainId(record.chainId, 'current-finalized request chainId');
    if (
      typeof record.to !== 'string'
      || !CANONICAL_NONZERO_EVM_ADDRESS.test(record.to)
    ) {
      throw new Error('to is not a canonical nonzero EVM address');
    }
    if (record.from !== CONTROL_EIP1271_CALL_FROM_V1) throw new Error('wrong from');
    if (typeof record.data !== 'string') throw new Error('call data is not a string');
    assertCanonicalEip1271CallData(record.data);
    if (record.gasLimit !== CONTROL_EIP1271_GAS_LIMIT_V1) throw new Error('wrong gas limit');
    if (record.maxReturnBytes !== CONTROL_EIP1271_MAX_RETURN_BYTES_V1) {
      throw new Error('wrong return cap');
    }
    if (record.maxRpcResponseBytes !== CONTROL_EIP1271_MAX_RPC_RESPONSE_BYTES_V1) {
      throw new Error('wrong RPC response cap');
    }
    if (record.attemptTimeoutMs !== CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1) {
      throw new Error('wrong attempt timeout');
    }
    if (record.maxAttempts !== CONTROL_EIP1271_MAX_ATTEMPTS_V1) {
      throw new Error('wrong attempt count');
    }
    if (record.endpointAttemptPolicy !== CONTROL_EIP1271_ENDPOINT_ATTEMPT_POLICY_V1) {
      throw new Error('wrong endpoint policy');
    }
    if (
      record.maxConcurrentCallsPerChain
      !== CONTROL_EIP1271_MAX_CONCURRENT_CALLS_PER_CHAIN_V1
    ) {
      throw new Error('wrong concurrency ceiling');
    }
    if (record.totalDeadlineMs !== CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1) {
      throw new Error('wrong total deadline');
    }
    if (record.ccipReadEnabled !== false) throw new Error('CCIP Read must be disabled');
    if (!isAbortSignal(record.signal)) throw new Error('signal is not an AbortSignal');

    return Object.freeze({
      chainId: record.chainId,
      to: record.to,
      from: record.from,
      data: record.data,
      gasLimit: record.gasLimit,
      maxReturnBytes: record.maxReturnBytes,
      maxRpcResponseBytes: record.maxRpcResponseBytes,
      attemptTimeoutMs: record.attemptTimeoutMs,
      maxAttempts: record.maxAttempts,
      endpointAttemptPolicy: record.endpointAttemptPolicy,
      maxConcurrentCallsPerChain: record.maxConcurrentCallsPerChain,
      totalDeadlineMs: record.totalDeadlineMs,
      ccipReadEnabled: record.ccipReadEnabled,
      signal: record.signal,
    }) as CurrentFinalizedEvmCallRequestV1;
  } catch {
    throw new CurrentFinalizedEvmCallErrorV1(
      'rpc-unavailable',
      'Current-finalized EVM call request failed the fixed local profile',
    );
  }
}

function assertCanonicalEip1271CallData(data: string): void {
  if (!/^0x[0-9a-f]+$/.test(data)) {
    throw new Error('call data is not canonical lowercase hex');
  }
  const bytes = data.slice(2);
  const selectorLength = 8;
  const wordLength = 64;
  const fixedLength = selectorLength + (wordLength * 3);
  if (
    bytes.slice(0, selectorLength) !== '1626ba7e'
    || bytes.length < fixedLength
    || bytes.slice(selectorLength + wordLength, selectorLength + (wordLength * 2))
      !== `${'0'.repeat(62)}40`
  ) {
    throw new Error('call data is not canonical isValidSignature(bytes32,bytes) ABI');
  }

  const signatureLengthWord = bytes.slice(
    selectorLength + (wordLength * 2),
    fixedLength,
  );
  const signatureLength = BigInt(`0x${signatureLengthWord}`);
  if (signatureLength < 1n || signatureLength > 4096n) {
    throw new Error('EIP-1271 signature length is outside 1..4096 bytes');
  }
  const paddedSignatureHexLength = Math.ceil(Number(signatureLength) / 32) * wordLength;
  const tail = bytes.slice(fixedLength);
  if (tail.length !== paddedSignatureHexLength) {
    throw new Error('EIP-1271 signature tail has noncanonical length');
  }
  const signatureHexLength = Number(signatureLength) * 2;
  if (!/^0*$/.test(tail.slice(signatureHexLength))) {
    throw new Error('EIP-1271 signature tail has nonzero ABI padding');
  }
}

function snapshotExactDataRecord(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('not a record');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('not plain');
  const actualKeys = Reflect.ownKeys(input);
  if (
    actualKeys.some((key) => typeof key !== 'string')
    || actualKeys.length !== expectedKeys.length
    || (actualKeys as string[]).sort().some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error('unknown or missing fields');
  }

  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new Error('fields must be enumerable data properties');
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (value === null || typeof value !== 'object') return false;
  try {
    const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
    if (abortedGetter === undefined) return false;
    abortedGetter.call(value);
    return true;
  } catch {
    return false;
  }
}

function snapshotAdapterFailure(cause: unknown): CurrentFinalizedEvmCallErrorV1 {
  try {
    if (cause instanceof CurrentFinalizedEvmCallErrorV1) {
      const code = cause.code;
      const message = cause.message;
      if (
        CURRENT_FINALIZED_EVM_CALL_ERROR_CODES_V1.includes(code)
        && typeof message === 'string'
      ) {
        return new CurrentFinalizedEvmCallErrorV1(code, message);
      }
    }
  } catch {
    // Hostile error objects cannot select a verifier disposition.
  }
  return new CurrentFinalizedEvmCallErrorV1(
    'rpc-unavailable',
    'Current-finalized EVM chain adapter failed closed',
  );
}
