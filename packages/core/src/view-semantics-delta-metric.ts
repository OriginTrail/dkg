// SPDX-License-Identifier: Apache-2.0
import { metrics, type Counter, type MeterProvider } from '@opentelemetry/api';

// The meter of telemetry-api.ts. The counter belongs to the global meter provider it was created
// on. The daemon replaces that provider when telemetry is switched on or off, so the counter is
// created again on the provider of the moment, and always records into the node's current metrics.
const METER_NAME = '@origintrail-official/dkg';
let delta: { readonly provider: MeterProvider; readonly counter: Counter } | undefined;

/**
 * Count one sampled view query by how its merged answer differs from its per-asset answer.
 * `kind` is one of: none, copies-removed, rows-added, rows-removed-or-changed.
 */
export function recordViewSemanticsDelta(kind: string): void {
  const provider = metrics.getMeterProvider();
  if (delta?.provider !== provider) {
    delta = {
      provider,
      counter: provider.getMeter(METER_NAME).createCounter('dkg.query.view_semantics_delta', {
        description: 'Sampled view queries by how their merged answer differs from their per-asset answer',
      }),
    };
  }
  delta.counter.add(1, { kind });
}
