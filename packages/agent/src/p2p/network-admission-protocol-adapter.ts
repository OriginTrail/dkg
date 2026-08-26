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
 * The router-facing admission policy as one object: the probing full check and
 * the cached-verdict pre-read gate are two phases of a single invariant and
 * must read the same coordinator state. Constructing them together (see
 * `createNetworkAdmissionRouterPolicy`) is what keeps a future admission
 * change from wiring one phase and silently dropping — or contradicting — the
 * other.
 */
export interface NetworkAdmissionRouterPolicy {
  isPeerAccepted: NonNullable<ProtocolRouterOptions['isPeerAccepted']>;
  isPeerKnownRejected: NonNullable<ProtocolRouterOptions['isPeerKnownRejected']>;
}

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

/**
 * Build the COMPLETE admission policy for ProtocolRouter from one coordinator.
 * Spread the result into the router options in a single operation:
 *
 *   new ProtocolRouter(node, { ...createNetworkAdmissionRouterPolicy(coordinator), ... })
 *
 * `isPeerAccepted` is the full (possibly probing) check that runs after the
 * bounded body read; `isPeerKnownRejected` is the synchronous cached-verdict
 * pre-read gate — `isRejectedPeer` reads the admission cache and never probes,
 * so consulting it before the body is read cannot invert the inbound/outbound
 * I/O order the way a probing check there would.
 */
export function createNetworkAdmissionRouterPolicy(
  coordinator: Pick<NetworkAdmissionCoordinator, 'ensureAdmitted' | 'isRejectedPeer'>,
): NetworkAdmissionRouterPolicy {
  return {
    isPeerAccepted: createNetworkAdmissionProtocolCheck(coordinator),
    isPeerKnownRejected: (peerId) => coordinator.isRejectedPeer(peerId),
  };
}
