import { ACKRoundDiagnostics } from '../../src/ack-diagnostics.js';

function checkMeasurementContract(diagnostics: ACKRoundDiagnostics): void {
  const work = async () => 42;
  const attempt: Promise<number> = diagnostics.measureAttempt(work);
  const backoff: Promise<number> = diagnostics.measureBackoff('transient_decline', work);
  // @ts-expect-error Backoff attribution requires an explicit reason.
  diagnostics.measureBackoff(work);
  // @ts-expect-error Attempts cannot carry a backoff reason.
  diagnostics.measureAttempt(work, 'transport');
  // @ts-expect-error Backoff attribution accepts only the closed retry causes.
  diagnostics.measureBackoff('other', work);
  void [attempt, backoff];
}
void checkMeasurementContract;
