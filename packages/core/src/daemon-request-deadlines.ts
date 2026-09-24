/**
 * Client-side deadlines for daemon HTTP requests, shared by the CLI and MCP
 * clients so both give every route the same deadline and read the same
 * environment overrides.
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

/** GET reads take the read class (the list class for the list routes); every other method the long class. */
export function classifyDaemonRequestDeadline(
  route: DaemonRequestRoute,
): DaemonRequestDeadlineClass {
  if (route.method !== 'GET') return 'long';
  return DAEMON_LIST_READ_ROUTES.has(route.path.replace(/\?.*$/, '')) ? 'list-read' : 'read';
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
