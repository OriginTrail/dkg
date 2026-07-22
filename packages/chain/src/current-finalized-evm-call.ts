import {
  assertCanonicalChainId,
  type ChainIdV1,
} from '@origintrail-official/dkg-core';

import {
  type CurrentFinalizedEvmCallRequestV1,
  type CurrentFinalizedEvmCallResultV1,
  type CurrentFinalizedEvmCallV1,
} from './current-finalized-evm-call-model.js';
import {
  CURRENT_FINALIZED_EVM_READ_MAX_CONCURRENT_PER_CHAIN_V1,
  CURRENT_FINALIZED_EVM_READ_MAX_RETURN_BYTES_V1,
  CURRENT_FINALIZED_EVM_CALL_ERROR_CODES_V1,
  CurrentFinalizedEvmCallErrorV1,
} from './current-finalized-evm-read-profile.js';
import { createNonqueueingAdmissionGateV1 } from './nonqueueing-admission.js';
import {
  assertCanonicalNonzeroEvmAddress,
  isAbortSignal,
  snapshotDenseDataArray,
  snapshotExactDataRecord,
} from './strict-local-data.js';

const REQUEST_KEYS = Object.freeze([
  'chainId',
  'data',
  'maxReturnBytes',
  'signal',
  'to',
] as const);

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
  const admission = createNonqueueingAdmissionGateV1<ChainIdV1>(
    CURRENT_FINALIZED_EVM_READ_MAX_CONCURRENT_PER_CHAIN_V1,
  );

  const route: CurrentFinalizedEvmCallV1 = async (input) => {
    const request = snapshotCurrentFinalizedEvmCallRequestV1(input);
    const adapter = adapters.get(request.chainId);
    if (adapter === undefined) {
      throw new CurrentFinalizedEvmCallErrorV1(
        'unsupported-chain',
        `No current-finalized EVM adapter is configured for chain ${request.chainId}`,
      );
    }

    // Do not race this operation with request.signal. The verifier may stop
    // awaiting after caller cancellation, but this permit remains held until
    // the actual adapter operation settles (including adapters that ignore
    // abort), so abandoned work cannot evade the four-call ceiling.
    return admission.run(
      request.chainId,
      () => Promise.resolve()
        .then(() => adapter(request))
        .catch((cause: unknown) => {
          throw snapshotAdapterFailure(cause);
        }),
      (active) => new CurrentFinalizedEvmCallErrorV1(
        'concurrency-saturated',
        `Chain ${request.chainId} already has ${active} current-finalized calls in flight`,
      ),
    );
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
    return snapshotDenseDataArray(input, {
      label: 'Current-finalized adapter registrations',
    });
  } catch {
    throw new TypeError('Current-finalized adapter registrations must be a dense data-only array');
  }
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

/** Package-internal strict snapshot shared by the router and raw transport. */
export function snapshotCurrentFinalizedEvmCallRequestV1(
  input: unknown,
): CurrentFinalizedEvmCallRequestV1 {
  try {
    const record = snapshotExactDataRecord(input, REQUEST_KEYS);
    assertCanonicalChainId(record.chainId, 'current-finalized request chainId');
    assertCanonicalNonzeroEvmAddress(record.to, 'current-finalized request to');
    if (typeof record.data !== 'string') throw new Error('call data is not a string');
    assertCanonicalAbiCallData(record.data);
    if (
      typeof record.maxReturnBytes !== 'number'
      || !Number.isSafeInteger(record.maxReturnBytes)
      || record.maxReturnBytes < 1
      || record.maxReturnBytes > CURRENT_FINALIZED_EVM_READ_MAX_RETURN_BYTES_V1
    ) {
      throw new Error('wrong return cap');
    }
    if (!isAbortSignal(record.signal)) throw new Error('signal is not an AbortSignal');

    return Object.freeze({
      chainId: record.chainId,
      to: record.to,
      data: record.data,
      maxReturnBytes: record.maxReturnBytes,
      signal: record.signal,
    }) as CurrentFinalizedEvmCallRequestV1;
  } catch {
    throw new CurrentFinalizedEvmCallErrorV1(
      'rpc-unavailable',
      'Current-finalized EVM call request failed the fixed local profile',
    );
  }
}

function assertCanonicalAbiCallData(data: string): void {
  if (!/^0x[0-9a-f]{8}(?:[0-9a-f]{2})*$/.test(data)) {
    throw new Error('call data is not canonical ABI calldata');
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
