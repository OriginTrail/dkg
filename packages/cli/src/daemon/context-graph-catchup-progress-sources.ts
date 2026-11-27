// daemon/context-graph-catchup-progress-sources.ts
//
// The daemon's catch-up work as the catch-up progress registry reports it to
// writes that wait for their graph (`context-graph-catchup-progress.ts`):
// catch-up jobs in flight, from the job ledger, and the readiness repeats. The
// daemon starts reporting them when its catch-up runner exists and stops with
// the catch-up triggers at shutdown. The activation catch-up reports its own
// queue, for as long as each one runs (`startActivationCatchups`).

import { catchupJobInFlightFor } from './catchup-telemetry.js';
import { registerContextGraphCatchupProgress } from './context-graph-catchup-progress.js';
import { readinessRepeatProgress } from './context-graph-readiness-repeat.js';

/** Report catch-up jobs and readiness repeats; the returned function stops reporting them. */
export function startContextGraphCatchupProgress(): () => void {
  const stops = [
    registerContextGraphCatchupProgress({ catchingUp: catchupJobInFlightFor }),
    registerContextGraphCatchupProgress(readinessRepeatProgress),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
