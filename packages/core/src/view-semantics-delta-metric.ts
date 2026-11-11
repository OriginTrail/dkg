// SPDX-License-Identifier: Apache-2.0
import { metrics, type Counter } from '@opentelemetry/api';

// The meter of telemetry-api.ts. The counter is created at its first use, after the daemon has
// registered its meter provider, so it records into the node's metrics.
const METER_NAME = '@origintrail-official/dkg';
let delta: Counter | undefined;

/**
 * Count one sampled view query by how its merged answer differs from its per-asset answer.
 * `kind` is one of: none, copies-removed, rows-added, rows-removed-or-changed.
 */
export function recordViewSemanticsDelta(kind: string): void {
  delta ??= metrics.getMeter(METER_NAME).createCounter('dkg.query.view_semantics_delta', {
    description: 'Sampled view queries by how their merged answer differs from their per-asset answer',
  });
  delta.add(1, { kind });
}
