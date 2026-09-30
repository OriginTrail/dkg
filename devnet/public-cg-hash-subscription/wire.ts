/**
 * The daemon replies the hash-subscription devnet suite reads, checked at the
 * HTTP boundary: the four the suite is about (subscribe, context-graph list,
 * subscriptions, catch-up status) and the two it needs to bring two edges
 * together (status, connections).
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * Each `parse*` function takes the JSON of a 200 reply as `unknown` and either
 * returns it typed as the canonical declaration (imported type-only from the
 * CLI package, so nothing under packages/ loads at runtime) or throws a
 * `WireShapeError` that names the endpoint and the missing or mistyped field.
 * A renamed field, a retyped field or an identity or job state spelled
 * differently therefore fails HERE, at the reply, with that message, instead of
 * as an `undefined` deep inside a test.
 *
 * It checks mainly the fields this suite reads, plus a few it does not read (for
 * example `synced`, `coreHosted` and the catch-up `status`), so a change to those
 * fails here too. It is not the daemon's contract: the routes build these bodies
 * inline and export no schema, and the CLI client's declarations are hand-written,
 * so the canonical contract (one schema the route constructs its reply from and
 * every client parses with) would live at the CLI boundary, not in a devnet
 * suite. A field it does not check can change without failing here, and the
 * returned value is typed as the whole declaration although only the checked
 * fields are verified. No schema
 * library is used: the checks are a few plain functions.
 *
 * The state vocabularies below are copied, not imported (a runtime import would
 * load the CLI package). Each copy is tied to its declaration at the TYPE level,
 * so adding a state to the declaration without listing it here is a compile
 * error in a type-check of this file. Nothing in CI type-checks devnet suites,
 * so that tie only holds for whoever runs one (a throwaway tsconfig, an editor).
 */
import type { ApiClient } from '../../packages/cli/src/api-client.js';
import type {
  CatchupContextGraphIdentity,
  CatchupJobState,
  CatchupStatusResponse,
} from '../../packages/cli/src/catchup-status.js';

/**
 * Response of POST /api/context-graph/subscribe: the CLI client's declaration of
 * it (`ApiClient.subscribeToContextGraph`), which carries the `identity` and
 * `onChainReference` notes. The route builds the body inline and exports no type
 * of its own.
 */
export type SubscribeResponse = Awaited<ReturnType<ApiClient['subscribeToContextGraph']>>;

/** Response of GET /api/context-graph/list (`ApiClient.listContextGraphs`). */
export type ContextGraphListResponse = Awaited<ReturnType<ApiClient['listContextGraphs']>>;

/**
 * One row of GET /api/context-graph/subscriptions. The route builds it inline
 * (packages/cli/src/daemon/routes/context-graph.ts, "GET /api/context-graph/
 * subscriptions") and no exported declaration exists, so the four scalar fields
 * are stated here exactly as the route emits them; `identity` is the daemon's
 * name-hash identity note, the same declaration the subscribe reply and the
 * catch-up status carry.
 */
export interface SubscriptionRow {
  contextGraphId: string;
  subscribed: boolean;
  synced: boolean;
  coreHosted: boolean;
  identity?: CatchupContextGraphIdentity;
}

export type { CatchupContextGraphIdentity, CatchupJobState, CatchupStatusResponse };

/** The endpoints, spelled once so an error names the same string a reader greps for. */
export const ENDPOINT = {
  subscribe: 'POST /api/context-graph/subscribe',
  list: 'GET /api/context-graph/list',
  subscriptions: 'GET /api/context-graph/subscriptions',
  catchupStatus: 'GET /api/sync/catchup-status',
  status: 'GET /api/status',
  connections: 'GET /api/connections',
} as const;

// The vocabularies, tied to their declarations at the type level (see the header).
export const WIRE_IDENTITY_STATES = ['name-hash-only', 'name-hash-only-private', 'resolved'] as const satisfies
  readonly CatchupContextGraphIdentity['state'][];
export const WIRE_JOB_STATES = [
  'queued', 'running', 'done', 'failed', 'denied', 'deferred', 'partial', 'unreachable',
] as const satisfies readonly CatchupJobState[];

type MustBeNever<T extends never> = T;
/** A type error here means the declaration gained a state that the list above lacks. */
export type IdentityStatesListed = MustBeNever<
  Exclude<CatchupContextGraphIdentity['state'], (typeof WIRE_IDENTITY_STATES)[number]>
>;
/** A type error here means the declaration gained a job state that the list above lacks. */
export type JobStatesListed = MustBeNever<Exclude<CatchupJobState, (typeof WIRE_JOB_STATES)[number]>>;

/** A reply that does not have the shape the suite reads. `field` is a dotted path from the reply root. */
export class WireShapeError extends Error {
  constructor(
    readonly endpoint: string,
    readonly field: string,
    readonly expected: string,
    readonly actual: unknown,
  ) {
    super(`${endpoint}: ${field} is ${describeActual(actual)}, expected ${expected}`);
    this.name = 'WireShapeError';
  }
}

function describeActual(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}...` : value)}`;
  if (typeof value === 'object') return 'an object';
  return `the ${typeof value} ${String(value)}`;
}

type Obj = Record<string, unknown>;

function object(endpoint: string, field: string, value: unknown): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WireShapeError(endpoint, field, 'an object', value);
  }
  return value as Obj;
}

function requiredString(endpoint: string, field: string, parent: Obj, key: string): string {
  const value = parent[key];
  if (typeof value !== 'string') throw new WireShapeError(endpoint, `${field}.${key}`, 'a string', value);
  return value;
}

function optionalString(endpoint: string, field: string, parent: Obj, key: string): string | undefined {
  const value = parent[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new WireShapeError(endpoint, `${field}.${key}`, 'a string when present', value);
  return value;
}

function requiredBoolean(endpoint: string, field: string, parent: Obj, key: string): boolean {
  const value = parent[key];
  if (typeof value !== 'boolean') throw new WireShapeError(endpoint, `${field}.${key}`, 'a boolean', value);
  return value;
}

function oneOf<T extends string>(
  endpoint: string,
  field: string,
  parent: Obj,
  key: string,
  allowed: readonly T[],
): T {
  const value = parent[key];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new WireShapeError(endpoint, `${field}.${key}`, `one of ${allowed.map((entry) => JSON.stringify(entry)).join(', ')}`, value);
  }
  return value as T;
}

/** The name-hash identity note every one of the four replies can carry; absent means "no note". */
function optionalIdentity(endpoint: string, field: string, parent: Obj): CatchupContextGraphIdentity | undefined {
  const raw = parent.identity;
  if (raw === undefined) return undefined;
  const path = `${field}.identity`;
  const note = object(endpoint, path, raw);
  oneOf(endpoint, path, note, 'state', WIRE_IDENTITY_STATES);
  requiredString(endpoint, path, note, 'nameHash');
  requiredString(endpoint, path, note, 'message');
  optionalString(endpoint, path, note, 'onChainId');
  optionalString(endpoint, path, note, 'contextGraphId');
  return note as unknown as CatchupContextGraphIdentity;
}

/**
 * POST /api/context-graph/subscribe. Reads: `subscribed`, the queued job's
 * `catchup.jobId` (the completed-catch-up variant has none), `identity` and
 * `onChainReference`.
 */
export function parseSubscribeResponse(value: unknown): SubscribeResponse {
  const endpoint = ENDPOINT.subscribe;
  const reply = object(endpoint, 'reply', value);
  requiredString(endpoint, 'reply', reply, 'subscribed');
  if (reply.catchup !== undefined) {
    const catchup = object(endpoint, 'reply.catchup', reply.catchup);
    optionalString(endpoint, 'reply.catchup', catchup, 'jobId');
    optionalString(endpoint, 'reply.catchup', catchup, 'status');
  }
  optionalIdentity(endpoint, 'reply', reply);
  if (reply.onChainReference !== undefined) {
    const note = object(endpoint, 'reply.onChainReference', reply.onChainReference);
    requiredString(endpoint, 'reply.onChainReference', note, 'onChainId');
    requiredString(endpoint, 'reply.onChainReference', note, 'message');
  }
  return reply as unknown as SubscribeResponse;
}

/**
 * GET /api/context-graph/list. Reads, per row, the on-chain id a node observed:
 * `onChainId`, else `onChain.id`.
 */
export function parseContextGraphListResponse(value: unknown): ContextGraphListResponse {
  const endpoint = ENDPOINT.list;
  const reply = object(endpoint, 'reply', value);
  if (!Array.isArray(reply.contextGraphs)) {
    throw new WireShapeError(endpoint, 'reply.contextGraphs', 'an array', reply.contextGraphs);
  }
  reply.contextGraphs.forEach((raw: unknown, index: number) => {
    const field = `reply.contextGraphs[${index}]`;
    const row = object(endpoint, field, raw);
    optionalString(endpoint, field, row, 'onChainId');
    if (row.onChain !== undefined) {
      const onChain = object(endpoint, `${field}.onChain`, row.onChain);
      requiredString(endpoint, `${field}.onChain`, onChain, 'id');
    }
  });
  return reply as unknown as ContextGraphListResponse;
}

/** One entry of GET /api/context-graph/subscriptions. */
export function parseSubscriptionRow(value: unknown, field = 'row'): SubscriptionRow {
  const endpoint = ENDPOINT.subscriptions;
  const row = object(endpoint, field, value);
  requiredString(endpoint, field, row, 'contextGraphId');
  requiredBoolean(endpoint, field, row, 'subscribed');
  requiredBoolean(endpoint, field, row, 'synced');
  requiredBoolean(endpoint, field, row, 'coreHosted');
  optionalIdentity(endpoint, field, row);
  return row as unknown as SubscriptionRow;
}

/** GET /api/context-graph/subscriptions: the list and each of its rows. */
export function parseSubscriptionsResponse(value: unknown): { subscriptions: SubscriptionRow[] } {
  const reply = object(ENDPOINT.subscriptions, 'reply', value);
  if (!Array.isArray(reply.subscriptions)) {
    throw new WireShapeError(ENDPOINT.subscriptions, 'reply.subscriptions', 'an array', reply.subscriptions);
  }
  return { subscriptions: reply.subscriptions.map((row: unknown, index: number) => parseSubscriptionRow(row, `reply.subscriptions[${index}]`)) };
}

/**
 * GET /api/sync/catchup-status. Reads: `jobId`, `contextGraphId`, `jobStatus`,
 * `resolvedContextGraphId`, `error` and `identity`.
 */
export function parseCatchupStatusResponse(value: unknown): CatchupStatusResponse {
  const endpoint = ENDPOINT.catchupStatus;
  const reply = object(endpoint, 'reply', value);
  requiredString(endpoint, 'reply', reply, 'jobId');
  requiredString(endpoint, 'reply', reply, 'contextGraphId');
  oneOf(endpoint, 'reply', reply, 'jobStatus', WIRE_JOB_STATES);
  optionalString(endpoint, 'reply', reply, 'resolvedContextGraphId');
  optionalString(endpoint, 'reply', reply, 'error');
  optionalIdentity(endpoint, 'reply', reply);
  return reply as unknown as CatchupStatusResponse;
}

/** What the suite needs of a node to dial it: its peer id and the addresses it listens on. */
export interface NodePeerInfo {
  readonly peerId: string;
  readonly multiaddrs: readonly string[];
}

/** GET /api/status. Reads: `peerId` and `multiaddrs`. */
export function parseNodePeerInfo(value: unknown): NodePeerInfo {
  const endpoint = ENDPOINT.status;
  const reply = object(endpoint, 'reply', value);
  const peerId = requiredString(endpoint, 'reply', reply, 'peerId');
  const raw = reply.multiaddrs;
  if (!Array.isArray(raw)) throw new WireShapeError(endpoint, 'reply.multiaddrs', 'an array', raw);
  raw.forEach((entry: unknown, index: number) => {
    if (typeof entry !== 'string') throw new WireShapeError(endpoint, `reply.multiaddrs[${index}]`, 'a string', entry);
  });
  return { peerId, multiaddrs: raw as string[] };
}

/** GET /api/connections. Reads: the `peerId` of every entry of `connections`. */
export function parseConnectedPeerIds(value: unknown): string[] {
  const endpoint = ENDPOINT.connections;
  const reply = object(endpoint, 'reply', value);
  if (!Array.isArray(reply.connections)) {
    throw new WireShapeError(endpoint, 'reply.connections', 'an array', reply.connections);
  }
  return reply.connections.map((entry: unknown, index: number) => (
    requiredString(endpoint, `reply.connections[${index}]`, object(endpoint, `reply.connections[${index}]`, entry), 'peerId')
  ));
}
