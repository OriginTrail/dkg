/**
 * Client-side deadlines for daemon HTTP requests, shared by the CLI and MCP
 * clients so both give every route the same deadline and read the same
 * environment overrides. Below them, how long a client waits before it repeats
 * a request the daemon answered with its retryable authority 503.
 */

import { MAX_NODE_TIMER_DELAY_MS } from './node-timer.js';

/** Deadline for GET reads, which answer from local daemon state. */
export const DAEMON_READ_TIMEOUT_MS = 30_000;

/**
 * Deadline for the GET lists in {@link DAEMON_LIST_READ_ROUTES}, which walk
 * every context graph, sub-graph, PCA or publisher job (the PCA list reads
 * each account from the chain). It matches the node UI's graph-list deadline
 * and never falls below the read deadline.
 */
export const DAEMON_LIST_READ_TIMEOUT_MS = 60_000;

/** Paths, without a query string, of the GET routes that take the list deadline. */
export const DAEMON_LIST_READ_ROUTES: ReadonlySet<string> = new Set([
  '/api/context-graph/list',
  '/api/sub-graph/list',
  '/api/pca',
  '/api/publisher/jobs',
]);

/**
 * Deadline for every other request: several wait on peers or the chain.
 * `vm/publish` holds the request open for the publisher's storage-ACK window
 * (`ACK_TIMEOUT_MS`, 120 s, in packages/publisher/src/ack-collector.ts) plus
 * chain confirmation; registration, PCA and wallet routes wait for their
 * transactions. It stays under the 300 s Node's fetch waits on its own, so this
 * deadline, and a long mutation's outcome-unknown report, comes first.
 */
export const DAEMON_LONG_TIMEOUT_MS = 240_000;

/** Environment overrides, in ms, for the read and long deadlines. */
export const DAEMON_READ_TIMEOUT_ENV = 'DKG_API_READ_TIMEOUT_MS';
export const DAEMON_LONG_TIMEOUT_ENV = 'DKG_API_LONG_TIMEOUT_MS';

export type DaemonRequestDeadlineClass = 'read' | 'list-read' | 'long';

export interface DaemonRequestRoute {
  readonly method: string;
  /** The request path; a query string is ignored. */
  readonly path: string;
}

/**
 * The route or path without its query string. A plain `indexOf` keeps this
 * linear on any input (a `/\?.*$/` replace is flagged by CodeQL as
 * polynomial on strings with many `?`).
 */
function withoutQuery(route: string): string {
  const query = route.indexOf('?');
  return query === -1 ? route : route.slice(0, query);
}

/** GET reads take the read class (the list class for the list routes); every other method the long class. */
export function classifyDaemonRequestDeadline(
  route: DaemonRequestRoute,
): DaemonRequestDeadlineClass {
  if (route.method !== 'GET') return 'long';
  return DAEMON_LIST_READ_ROUTES.has(withoutQuery(route.path)) ? 'list-read' : 'read';
}

export interface DaemonRequestDeadlineOptions {
  /** Deadline in ms for GET reads (default `DKG_API_READ_TIMEOUT_MS`, else 30 000). */
  readonly readTimeoutMs?: number;
  /**
   * Deadline in ms for every other request (default `DKG_API_LONG_TIMEOUT_MS`,
   * else 240 000; never below the read deadline).
   */
  readonly longTimeoutMs?: number;
}

export interface DaemonRequestDeadlines {
  readonly readTimeoutMs: number;
  readonly listReadTimeoutMs: number;
  readonly longTimeoutMs: number;
  /** The deadline, in ms, of one request by its method and path. */
  timeoutMsFor(route: DaemonRequestRoute): number;
}

/** A deadline override from the environment; unset or empty means none. */
function timeoutFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): number | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  // A longer value would not survive as a timer: Node fires it after 1 ms.
  if (!/^\d+$/.test(raw) || value < 1 || value > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(
      `${name} must be a whole number of milliseconds from 1 to ${MAX_NODE_TIMER_DELAY_MS}, got "${raw}"`,
    );
  }
  return value;
}

/**
 * Resolve a client's deadlines once: an explicit option wins, then its
 * environment variable (validated only when it is consulted), then the
 * default. The list deadline never falls below the read deadline, nor the
 * long deadline below the read deadline.
 */
export function resolveDaemonRequestDeadlines(
  options: DaemonRequestDeadlineOptions = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): DaemonRequestDeadlines {
  const readTimeoutMs = options.readTimeoutMs
    ?? timeoutFromEnv(env, DAEMON_READ_TIMEOUT_ENV)
    ?? DAEMON_READ_TIMEOUT_MS;
  const listReadTimeoutMs = Math.max(DAEMON_LIST_READ_TIMEOUT_MS, readTimeoutMs);
  const longTimeoutMs = Math.max(
    options.longTimeoutMs ?? timeoutFromEnv(env, DAEMON_LONG_TIMEOUT_ENV) ?? DAEMON_LONG_TIMEOUT_MS,
    readTimeoutMs,
  );
  const byClass: Readonly<Record<DaemonRequestDeadlineClass, number>> = Object.freeze({
    read: readTimeoutMs,
    'list-read': listReadTimeoutMs,
    long: longTimeoutMs,
  });
  return Object.freeze({
    readTimeoutMs,
    listReadTimeoutMs,
    longTimeoutMs,
    timeoutMsFor: (route: DaemonRequestRoute) => byClass[classifyDaemonRequestDeadline(route)],
  });
}

/** The daemon's code while a read cannot resolve a Context Graph's authority. */
export const DAEMON_READ_AUTHORITY_UNAVAILABLE_CODE = 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE';
/** The same answer from an operation's own authority check: a subscribe, a private publish. */
export const DAEMON_AUTHORITY_UNAVAILABLE_CODE = 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE';
export const DAEMON_RETRYABLE_AUTHORITY_CODES: readonly string[] = Object.freeze([
  DAEMON_READ_AUTHORITY_UNAVAILABLE_CODE,
  DAEMON_AUTHORITY_UNAVAILABLE_CODE,
]);

/**
 * The wait before each retry, in order, when the daemon asks for no longer one.
 * Its length is the number of retries. Their 15 s in all, or 18 s at the
 * `Retry-After: 3` of a read, outlast the windows of about 13 s seen against slow
 * public RPC endpoints. The harnesses keep the same bound in
 * `scripts/lib/qa/authority-retry.mjs`, which has to run without a build.
 */
export const DAEMON_AUTHORITY_RETRY_DELAYS_MS: readonly number[] = Object.freeze([1_000, 2_000, 4_000, 8_000]);
/** The longest single wait: an answer that asks for more is reported as it came. */
export const DAEMON_AUTHORITY_RETRY_MAX_DELAY_MS = 15_000;

/** Whether an answer is the retryable authority 503 under one of `codes`. */
export function isRetryableDaemonAuthorityAnswer(
  status: number,
  body: unknown,
  codes: readonly string[] = DAEMON_RETRYABLE_AUTHORITY_CODES,
): boolean {
  if (status !== 503 || body === null || typeof body !== 'object') return false;
  const { code, retryable } = body as { code?: unknown; retryable?: unknown };
  return retryable === true && typeof code === 'string' && codes.includes(code);
}

/** A `Retry-After` value in ms: delta-seconds or an HTTP-date. Anything else counts as absent. */
export function parseDaemonRetryAfterMs(
  header: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (typeof header !== 'string') return undefined;
  const value = header.trim();
  if (/^[0-9]+$/.test(value)) return Number(value) * 1_000;
  if (!/^[A-Z][a-z]{2}, [0-9]{2} [A-Z][a-z]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

/**
 * The wait before retry `retry` (from 0), in ms: its back-off, or what the daemon
 * asked for when that is longer, so a retry never comes before the daemon asked.
 * `null` when the client stops here: the retries are spent, or the daemon asked
 * for more than one wait may take.
 */
export function daemonAuthorityRetryDelayMs(
  retry: number,
  retryAfter: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  const backoff = DAEMON_AUTHORITY_RETRY_DELAYS_MS[retry];
  if (backoff === undefined) return null;
  const delay = Math.max(backoff, parseDaemonRetryAfterMs(retryAfter, nowMs) ?? 0);
  return delay <= DAEMON_AUTHORITY_RETRY_MAX_DELAY_MS ? delay : null;
}
