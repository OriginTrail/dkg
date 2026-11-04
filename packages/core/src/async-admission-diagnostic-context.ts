import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { AsyncAdmissionPhase, AsyncAdmissionRoute } from './async-admission-usage.js';

/** Private diagnostic correlation only: never an authority, intent key or metric label. */
export interface AsyncAdmissionDiagnosticContext {
  readonly requestId: string;
  readonly route: AsyncAdmissionRoute;
  readonly phase: AsyncAdmissionPhase;
}

const current = new AsyncLocalStorage<AsyncAdmissionDiagnosticContext>();
const routes = new Set<AsyncAdmissionRoute>(['share_async', 'publish_async']);
const phases = new Set<AsyncAdmissionPhase>([
  'request', 'write_preflight', 'intent_resolution', 'snapshot_preflight', 'enqueue',
]);

/** Mint locally; no header, body, coordinate or caller-supplied ID is accepted. */
export function createAsyncAdmissionDiagnosticTrace(route: AsyncAdmissionRoute) {
  const requestId = randomUUID();
  return Object.freeze({
    requestId,
    run<T>(phase: AsyncAdmissionPhase, work: () => T): T {
      // Diagnostics must not change admission even for an invalid internal label.
      if (!routes.has(route) || !phases.has(phase)) return current.exit(work);
      return current.run(Object.freeze({ requestId, route, phase }), work);
    },
  });
}

/** Same-isolate only; does not imply propagation through worker IPC. */
export function currentAsyncAdmissionDiagnosticContext(): AsyncAdmissionDiagnosticContext | undefined {
  return current.getStore();
}

/** Detached workers must not inherit whichever HTTP request happened to wake them. */
export function withoutAsyncAdmissionDiagnosticContext<T>(work: () => T): T {
  return current.exit(work);
}
