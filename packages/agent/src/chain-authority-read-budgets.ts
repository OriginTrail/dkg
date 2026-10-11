// SPDX-License-Identifier: Apache-2.0

import {
  CHAIN_AUTHORITY_COLD_RESOLUTION_TIMEOUT_MS,
  CHAIN_POLICY_READ_TIMEOUT_MS,
} from './dkg-agent-constants.js';

/** Environment override for the request-scoped chain authority read deadline. */
export const CHAIN_AUTHORITY_READ_TIMEOUT_ENV = 'DKG_CHAIN_AUTHORITY_READ_TIMEOUT_MS';
/** Environment override for the detached cold finalized-authority resolution budget. */
export const CHAIN_AUTHORITY_COLD_RESOLUTION_TIMEOUT_ENV =
  'DKG_CHAIN_AUTHORITY_COLD_RESOLUTION_TIMEOUT_MS';

/** Operator-facing keys, shared by the agent `chainConfig` and the CLI `chain` block. */
export interface ChainAuthorityReadBudgetsConfig {
  /**
   * Deadline (ms) for one request-scoped on-chain authority read: liveness,
   * access/publish policy, participant roster, and the finalized-index
   * snapshot lookup that gates a query, share, or SWM sync decision. A read
   * that misses it fails CLOSED for that request. Defaults to
   * {@link CHAIN_POLICY_READ_TIMEOUT_MS} (2.5s).
   */
  authorityReadTimeoutMs?: number;
  /**
   * Budget (ms) for the detached cold finalized-authority resolution that keeps
   * running after a request deadline trips, so its result reaches the chain
   * reader's projection cache. Never resolved below `authorityReadTimeoutMs`.
   * Defaults to {@link CHAIN_AUTHORITY_COLD_RESOLUTION_TIMEOUT_MS} (20s).
   */
  authorityColdResolutionTimeoutMs?: number;
}

/** Resolved, validated deadlines every authority read on an agent shares. */
export interface ChainAuthorityReadBudgets {
  readonly requestTimeoutMs: number;
  readonly coldResolutionTimeoutMs: number;
}

/** Process defaults; the value every agent uses when nothing is configured. */
export const DEFAULT_CHAIN_AUTHORITY_READ_BUDGETS: ChainAuthorityReadBudgets = Object.freeze({
  requestTimeoutMs: CHAIN_POLICY_READ_TIMEOUT_MS,
  coldResolutionTimeoutMs: CHAIN_AUTHORITY_COLD_RESOLUTION_TIMEOUT_MS,
});

/**
 * Deadlines of an agent-like host. A production agent resolves them once at
 * construction; a prototype-bound test host that never declared the field
 * receives the package defaults, exactly as an unconfigured agent would.
 */
export function chainAuthorityReadBudgetsOf(
  host: { readonly chainAuthorityReadBudgets?: ChainAuthorityReadBudgets },
): ChainAuthorityReadBudgets {
  return host.chainAuthorityReadBudgets ?? DEFAULT_CHAIN_AUTHORITY_READ_BUDGETS;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Validate one explicitly configured deadline. Presence matters to callers:
 * an explicit `null`, zero, fraction, or string is an operator error and must
 * fail fast rather than silently fall back to the default.
 */
export function resolveChainAuthorityTimeoutMs(value: unknown, label: string): number {
  if (!isPositiveSafeInteger(value)) {
    throw new TypeError(`${label} must be a positive integer (milliseconds)`);
  }
  return value;
}

/**
 * Same integer contract as `parseIntegerEnv` in `sync/backpressure.ts`: an
 * absent, blank, or non-positive-integer environment value is ignored so a
 * typo can never disable a security deadline or turn it into `NaN`.
 */
function readPositiveIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return isPositiveSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Resolve the deadlines once per agent. Precedence per key: environment
 * override, then explicit config, then the package default. The cold budget is
 * floored at the request deadline: a cold flight that ended before the request
 * it serves would only ever hand that request its own abort.
 */
export function resolveChainAuthorityReadBudgets(
  config: ChainAuthorityReadBudgetsConfig | undefined = undefined,
  env: NodeJS.ProcessEnv = process.env,
): ChainAuthorityReadBudgets {
  const configuredRequest = config !== undefined
    && Object.prototype.hasOwnProperty.call(config, 'authorityReadTimeoutMs')
    && config.authorityReadTimeoutMs !== undefined
    ? resolveChainAuthorityTimeoutMs(
        config.authorityReadTimeoutMs,
        'chainConfig.authorityReadTimeoutMs',
      )
    : undefined;
  const configuredCold = config !== undefined
    && Object.prototype.hasOwnProperty.call(config, 'authorityColdResolutionTimeoutMs')
    && config.authorityColdResolutionTimeoutMs !== undefined
    ? resolveChainAuthorityTimeoutMs(
        config.authorityColdResolutionTimeoutMs,
        'chainConfig.authorityColdResolutionTimeoutMs',
      )
    : undefined;
  const requestTimeoutMs = readPositiveIntegerEnv(env, CHAIN_AUTHORITY_READ_TIMEOUT_ENV)
    ?? configuredRequest
    ?? DEFAULT_CHAIN_AUTHORITY_READ_BUDGETS.requestTimeoutMs;
  const coldResolutionTimeoutMs = readPositiveIntegerEnv(
    env,
    CHAIN_AUTHORITY_COLD_RESOLUTION_TIMEOUT_ENV,
  )
    ?? configuredCold
    ?? DEFAULT_CHAIN_AUTHORITY_READ_BUDGETS.coldResolutionTimeoutMs;
  return Object.freeze({
    requestTimeoutMs,
    coldResolutionTimeoutMs: Math.max(coldResolutionTimeoutMs, requestTimeoutMs),
  });
}
