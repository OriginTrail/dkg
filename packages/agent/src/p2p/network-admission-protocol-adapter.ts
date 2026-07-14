import {
  QuietRetryableHandlerError,
  createOperationContext,
  type ProtocolRouterOptions,
} from '@origintrail-official/dkg-core';
import {
  NetworkAdmissionProbeError,
  type NetworkAdmissionCoordinator,
} from './network-admission-coordinator.js';

/**
 * Translate agent-owned probe backoff into the core router's generic quiet
 * retryable concept at the protocol boundary. Outbound callers retain the
 * original error so connect/send diagnostics and retry policy stay unchanged.
 */
export function translateNetworkAdmissionErrorAtProtocolBoundary(
  error: unknown,
  direction: 'inbound' | 'outbound',
): unknown {
  if (direction === 'inbound' && error instanceof NetworkAdmissionProbeError) {
    return new QuietRetryableHandlerError(error.message);
  }
  return error;
}

/** Build the admission callback installed into ProtocolRouter by lifecycle. */
export function createNetworkAdmissionProtocolCheck(
  coordinator: Pick<NetworkAdmissionCoordinator, 'ensureAdmitted'>,
): NonNullable<ProtocolRouterOptions['isPeerAccepted']> {
  return async (peerId, _protocolId, direction, options) => {
    try {
      return await coordinator.ensureAdmitted(
        peerId,
        createOperationContext('connect'),
        options,
      );
    } catch (error) {
      throw translateNetworkAdmissionErrorAtProtocolBoundary(error, direction);
    }
  };
}
