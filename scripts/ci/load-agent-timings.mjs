import { loadVitestTimings } from './load-vitest-timings.mjs';

/** Validate the generated format and expose only immutable planning inputs. */
export function loadAgentTimings(file) {
  return loadVitestTimings(file, 'agent');
}
