import { Logger, createOperationContext, isAsyncAdmissionPhase, isAsyncAdmissionRoute, type AsyncAdmissionDiagnosticContext } from '@origintrail-official/dkg-core';
import { createWarningGate } from './warning-gate.js';

/** Local warnings only; twenty closed route/phase/outcome keys, never request ID. */
export function createAdmissionTraceReporter(options: {
  now?: () => number;
  emit?: (message: string) => void | Promise<void>;
} = {}) {
  const gate = createWarningGate(options.now ?? (() => performance.now()), 60_000, 32);
  const logger = new Logger('async-admission');
  const emit = options.emit ?? ((message: string) => logger.warn(createOperationContext('system'), message));
  return (
    context: AsyncAdmissionDiagnosticContext, status: number, elapsedMs: number,
    outcome: 'response_closed' | 'answer_after_close' = 'response_closed',
  ): void => {
    try {
      if (!isAsyncAdmissionRoute(context.route) || !isAsyncAdmissionPhase(context.phase)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(context.requestId)
        || !['response_closed', 'answer_after_close'].includes(outcome)
        || !Number.isInteger(status) || status < 0 || status > 599) return;
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
      // This is an observation threshold, never an execution deadline.
      if (outcome === 'response_closed' && status > 0 && status < 500 && elapsedMs < 10_000) return;
      if (!gate(`${context.route}/${context.phase}/${outcome}`).warn) return;
      const delivery = emit(JSON.stringify({
        event: 'async_admission_slow_or_failed',
        requestId: context.requestId, route: context.route, phase: context.phase,
        outcome,
        status,
        elapsedMs: Math.round(elapsedMs),
      }));
      if (delivery) void delivery.catch(() => undefined);
    } catch {
      // A diagnostic sink can neither cancel work nor change its response.
    }
  };
}

export const reportAdmissionTrace = createAdmissionTraceReporter();
