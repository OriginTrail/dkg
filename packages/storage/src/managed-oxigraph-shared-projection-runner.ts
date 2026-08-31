import type {
  Rfc64SharedProjectionStreamOperationV1,
} from '@origintrail-official/dkg-core';

import type {
  Rfc64SharedProjectionStreamCapabilityV1,
} from './rfc64-shared-projection-stream-capability.js';
import { spoolRfc64SharedProjectionHttpResponseV1 } from './rfc64-shared-projection-http-spool.js';
import { readSparqlResponseText } from './adapters/sparql-response-policy.js';

const SOURCE = 'rfc64.shared-projection.SYNC_KA_SHARED_PROJECTION_STREAM_V1';

export interface ManagedOxigraphConstructRequestV1 {
  readonly accept: 'application/n-quads, text/n-quads';
  readonly priority: 'background';
  readonly source: typeof SOURCE;
  readonly sparql: string;
  readonly signal?: AbortSignal;
}

export interface ManagedOxigraphSharedProjectionTransportV1 {
  runConstruct<T>(
    request: ManagedOxigraphConstructRequestV1,
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

/**
 * Install the RFC-64 managed-Oxigraph projection workflow over a generic,
 * scheduler-owning streaming CONSTRUCT transport. Protocol response policy,
 * bounded error reads, and external spooling stay outside SparqlHttpStore.
 */
export function createManagedOxigraphSharedProjectionRunnerV1(
  transport: ManagedOxigraphSharedProjectionTransportV1,
): Rfc64SharedProjectionStreamCapabilityV1['rfc64SharedProjectionStreamV1'] {
  return (
    operation: Rfc64SharedProjectionStreamOperationV1,
    options,
  ) => transport.runConstruct({
    accept: 'application/n-quads, text/n-quads',
    priority: 'background',
    source: SOURCE,
    sparql: operation.sparql,
    signal: options.signal,
  }, async (response, lifecycleSignal) => {
    if (!response.ok) {
      const text = await readSparqlResponseText(response, {
        maxResponseBytes: Math.min(options.byteCeiling, 64 * 1024),
        managedOxigraph: true,
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
      signal: lifecycleSignal,
      consumptionSignal: options.signal,
      managedOxigraph: true,
    });
  });
}
