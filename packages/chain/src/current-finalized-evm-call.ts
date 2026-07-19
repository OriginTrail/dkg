import {
  assertCanonicalChainId,
  type ChainIdV1,
} from '@origintrail-official/dkg-core';

import {
  CONTROL_EIP1271_MAX_CONCURRENT_CALLS_PER_CHAIN_V1,
  CURRENT_FINALIZED_EVM_CALL_ERROR_CODES_V1,
  CurrentFinalizedEvmCallErrorV1,
  type CurrentFinalizedEvmCallRequestV1,
  type CurrentFinalizedEvmCallResultV1,
  type CurrentFinalizedEvmCallV1,
} from './control-object-signature-verifier.js';
import {
  snapshotCurrentFinalizedEvmCallRequestV1,
  snapshotDenseDataArray,
  snapshotExactDataRecord,
} from './current-finalized-strict-snapshot.js';

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
    const request = snapshotCurrentFinalizedEvmCallRequestV1(input);
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
  const registrations = snapshotDenseDataArray(
    input,
    'Current-finalized adapter registrations must be a dense data-only array',
  );
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
