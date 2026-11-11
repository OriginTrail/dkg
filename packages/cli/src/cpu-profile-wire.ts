// The operator-only CPU profile of a running node: request and answer shared
// by the daemon route and the CLI.

export const CPU_PROFILE_PATH = '/api/diagnostics/cpu-profile';
export const CPU_PROFILE_DEFAULT_SECONDS = 10;
export const CPU_PROFILE_MIN_SECONDS = 1;
export const CPU_PROFILE_MAX_SECONDS = 60;
/** Time the client allows past the recording for the node to stop the profiler and write the file. */
export const CPU_PROFILE_RESPONSE_GRACE_MS = 60_000;

/** The node's answer once the profile is written. */
export interface CpuProfileResult {
  /** Absolute path of the `.cpuprofile` file on the node's host. */
  readonly path: string;
  /** The duration recorded for, after clamping. */
  readonly seconds: number;
  /** True when the requested duration was outside the bounds and was clamped. */
  readonly clamped: boolean;
  /** How long the profiler ran, in milliseconds. */
  readonly recordedMs: number;
  /** Size of the written file. */
  readonly bytes: number;
  /** True when the node began to shut down and the profile was stopped before its duration. */
  readonly stoppedEarly: boolean;
}

export type CpuProfileRequestParse =
  | { readonly seconds: number; readonly clamped: boolean }
  | { readonly error: string };

/**
 * Parse a request body: an empty body or `{}` records for the default
 * duration; `{ "seconds": n }` takes any positive number and clamps it to
 * 1-60 s. Anything else is refused.
 */
export function parseCpuProfileRequest(body: string): CpuProfileRequestParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim() === '' ? '{}' : body);
  } catch {
    parsed = undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'The CPU profile request must be a JSON object, for example {"seconds": 30}.' };
  }
  const unknown = Object.keys(parsed).find((key) => key !== 'seconds');
  if (unknown !== undefined) {
    return { error: `Unknown field "${unknown}"; the only field is "seconds".` };
  }
  const requested = (parsed as { seconds?: unknown }).seconds;
  if (requested === undefined) return { seconds: CPU_PROFILE_DEFAULT_SECONDS, clamped: false };
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return { error: 'seconds must be a positive number.' };
  }
  const seconds = Math.min(CPU_PROFILE_MAX_SECONDS, Math.max(CPU_PROFILE_MIN_SECONDS, requested));
  return { seconds, clamped: seconds !== requested };
}

/**
 * The client's deadline for one profile request of `seconds` (the node's
 * default when absent), in whole milliseconds as `AbortSignal.timeout` requires.
 */
export function cpuProfileRequestTimeoutMs(seconds = CPU_PROFILE_DEFAULT_SECONDS): number {
  const recorded = Math.min(CPU_PROFILE_MAX_SECONDS, Math.max(CPU_PROFILE_MIN_SECONDS, seconds));
  return Math.ceil(recorded * 1000) + CPU_PROFILE_RESPONSE_GRACE_MS;
}
