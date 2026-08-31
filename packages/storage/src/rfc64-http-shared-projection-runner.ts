import {
  DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1,
  type Rfc64SharedProjectionStreamOperationV1,
} from '@origintrail-official/dkg-core';

import type {
  Rfc64SharedProjectionStreamCapabilityV1,
} from './rfc64-shared-projection-stream-capability.js';
import { spoolRfc64SharedProjectionHttpResponseV1 } from './rfc64-shared-projection-http-spool.js';
import { readSparqlResponseText } from './adapters/sparql-response-policy.js';

const SOURCE = 'rfc64.shared-projection.SYNC_KA_SHARED_PROJECTION_STREAM_V1';
const MAX_DIAGNOSTIC_RESPONSE_BYTES = 64 * 1024;
// The accepted N-Quads grammar permits a six-byte `\\uXXXX` escape for one
// canonical ASCII byte. Six is therefore the maximum UCHAR expansion; the
// spool retains independent canonical line and projection ceilings.
const BLAZEGRAPH_UCHAR_WIRE_EXPANSION_V1 = 6;

export interface Rfc64HttpProjectionRequestV1 {
  readonly accept: string;
  readonly priority: 'background';
  readonly source: typeof SOURCE;
  readonly sparql: string;
  readonly signal?: AbortSignal;
}

export interface Rfc64HttpProjectionTransportV1 {
  runConstruct<T>(
    request: Rfc64HttpProjectionRequestV1,
    consume: (
      response: Response,
      lifecycleSignal: AbortSignal | undefined,
    ) => Promise<T>,
  ): Promise<T>;
  responseError(
    status: number,
    excerpt: string,
  ): Error;
}

export const RFC64_BLAZEGRAPH_PROJECTION_RESPONSE_STRATEGY_V1 = Object.freeze({
  backend: 'blazegraph' as const,
});

export const RFC64_MANAGED_OXIGRAPH_PROJECTION_RESPONSE_STRATEGY_V1 = Object.freeze({
  backend: 'managed-oxigraph' as const,
});

export type Rfc64HttpProjectionResponseStrategyV1 =
  | typeof RFC64_BLAZEGRAPH_PROJECTION_RESPONSE_STRATEGY_V1
  | typeof RFC64_MANAGED_OXIGRAPH_PROJECTION_RESPONSE_STRATEGY_V1;

interface ResolvedRfc64HttpProjectionResponseStrategyV1 {
  readonly accept: string;
  readonly diagnosticByteCeiling: (projectionByteCeiling: number) => number;
  readonly inputLineByteCeiling: (
    operation: Rfc64SharedProjectionStreamOperationV1,
  ) => number;
  readonly managedOxigraph: boolean;
  readonly wireByteCeiling: (
    operation: Rfc64SharedProjectionStreamOperationV1,
  ) => number;
}

/**
 * Install the common RFC-64 HTTP projection workflow over a scheduler-owning
 * streaming CONSTRUCT transport. Adapters supply only transport, typed error
 * construction, and one named backend response strategy; response validation,
 * bounded diagnostics, cancellation, and spooling have one lifecycle owner.
 */
export function createRfc64HttpSharedProjectionRunnerV1(
  transport: Rfc64HttpProjectionTransportV1,
  responseStrategy: Rfc64HttpProjectionResponseStrategyV1,
): Rfc64SharedProjectionStreamCapabilityV1['rfc64SharedProjectionStreamV1'] {
  const policy = resolveRfc64HttpProjectionResponseStrategyV1(responseStrategy);
  return (
    operation: Rfc64SharedProjectionStreamOperationV1,
    options,
  ) => transport.runConstruct({
    accept: policy.accept,
    priority: 'background',
    source: SOURCE,
    sparql: operation.sparql,
    signal: options.signal,
  }, async (response, lifecycleSignal) => {
    if (!response.ok) {
      const text = await readSparqlResponseText(response, {
        // Successful projection bytes are constrained by byteCeiling below.
        // Error evidence has an independent bounded allowance so a small
        // projection cannot truncate a managed cancellation marker.
        maxResponseBytes: policy.diagnosticByteCeiling(options.byteCeiling),
        managedOxigraph: policy.managedOxigraph,
        operation: 'construct',
        tolerateReadFailure: true,
      });
      throw transport.responseError(response.status, text.slice(0, 300));
    }
    if (response.body === null) {
      throw transport.responseError(
        response.status,
        'response has no readable body',
      );
    }
    return spoolRfc64SharedProjectionHttpResponseV1({
      body: response.body,
      operation,
      byteCeiling: options.byteCeiling,
      inputLineByteCeiling: policy.inputLineByteCeiling(operation),
      signal: lifecycleSignal,
      consumptionSignal: options.signal,
      managedOxigraph: policy.managedOxigraph,
      wireByteCeiling: policy.wireByteCeiling(operation),
    });
  });
}

function resolveRfc64HttpProjectionResponseStrategyV1(
  strategy: Rfc64HttpProjectionResponseStrategyV1,
): ResolvedRfc64HttpProjectionResponseStrategyV1 {
  switch (strategy.backend) {
    case 'blazegraph':
      return Object.freeze({
        accept: 'text/x-nquads, application/n-quads',
        diagnosticByteCeiling: (projectionByteCeiling: number) => Math.min(
          projectionByteCeiling,
          MAX_DIAGNOSTIC_RESPONSE_BYTES,
        ),
        inputLineByteCeiling: (operation: Rfc64SharedProjectionStreamOperationV1) =>
          expandBlazegraphWireBytes(
            Math.min(
              DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1.maxLineBytes,
              operation.protocolByteCeiling,
            ),
          ),
        managedOxigraph: false,
        wireByteCeiling: (operation: Rfc64SharedProjectionStreamOperationV1) =>
          expandBlazegraphWireBytes(
            operation.protocolByteCeiling,
          ),
      });
    case 'managed-oxigraph':
      return Object.freeze({
        accept: 'application/n-quads, text/n-quads',
        diagnosticByteCeiling: () => MAX_DIAGNOSTIC_RESPONSE_BYTES,
        inputLineByteCeiling: (operation: Rfc64SharedProjectionStreamOperationV1) => Math.min(
          DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1.maxLineBytes,
          operation.protocolByteCeiling,
        ),
        managedOxigraph: true,
        wireByteCeiling: (operation: Rfc64SharedProjectionStreamOperationV1) =>
          operation.protocolByteCeiling,
      });
  }
}

function expandBlazegraphWireBytes(canonicalBytes: number): number {
  return canonicalBytes * BLAZEGRAPH_UCHAR_WIRE_EXPANSION_V1;
}
