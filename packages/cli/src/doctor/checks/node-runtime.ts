import { inspectNodeRuntime, nodeRuntimeError } from '../../node-runtime-preflight.js';
import type { DoctorDeps, Finding, StateSummary } from '../types.js';

export function runNodeRuntimeCheck(deps: DoctorDeps, state: StateSummary): Finding[] {
  const runtime = state.runtime ?? inspectNodeRuntime(deps.runtimeHost);
  const error = nodeRuntimeError(runtime);
  return error ? [{ check: 'node-runtime', severity: 'error', message: error, details: { ...runtime } }] : [];
}
