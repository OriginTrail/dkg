/**
 * The daemon replies the hash-subscription devnet suite reads, checked at the
 * HTTP boundary: the four the suite is about (subscribe, context-graph list,
 * subscriptions, catch-up status), the query answers its content checks read, and
 * the two it needs to bring two edges together (status, connections).
 *
 * WHAT THIS GUARANTEES
 *
 * Each `parse*` function takes the JSON of a 200 reply as `unknown` and either
 * returns a PROJECTION or throws a `WireShapeError` that names the endpoint and the
 * missing or mistyped field. The projection is a new object holding exactly the
 * fields the parser checked, and its type says so: it is built from the fields of
 * the CLI package's own declarations (indexed access types over `import type`s), so
 * a field the parser did not check is not in the type (reading it is a compile
 * error) and not in the value, and a field renamed in the declaration breaks the
 * type check of this file. A renamed field, a retyped field or an identity or job
 * state spelled differently therefore fails HERE, at the reply, with that message,
 * instead of as an `undefined` deep inside a test. Fields the parser does not
 * check may be present, absent or changed in the reply without failing anything.
 *
 * WHAT IT IS NOT
 *
 * It is not the daemon's contract: the routes build these bodies inline and export
 * no schema, and the CLI client's declarations are hand-written, so the canonical
 * contract (one schema the route constructs its reply from and every client parses
 * with) would live at the CLI boundary, not in a devnet suite. A few fields are
 * checked although the suite does not read them (`synced` and `coreHosted` of a
 * subscription row, the subscribe reply's `catchup.status`), so a change to those
 * fails here too. No schema library is used: the checks are a few plain functions.
 *
 * WHAT IS IMPORTED
 *
 * The catch-up job states are the CLI's own runtime list (`CATCHUP_JOB_STATES` of
 * packages/cli/src/catchup-status.ts). That module has only type imports, so
 * importing it loads neither the agent nor the CLI runtime; everything else from
 * packages/ is imported as a type and erased. The identity-note states have no
 * runtime list there, only a type, so a copy is kept below and tied to the type:
 * a state added to the declaration without being listed here is a compile error
 * in a type-check of this file. Nothing in CI type-checks devnet suites, so that
 * tie only holds for whoever runs one (a throwaway tsconfig, an editor).
 *
 * One reader is not this module's: how a SELECT answer of POST /api/query is read (which
 * envelope holds the rows, what a row and a cell may be) is the harness's own knowledge,
 * kept in `_bootstrap/select-response.ts` and shared with `queryNode`. `parseQueryBindings`
 * below asks it for its strict reading and only turns its rejections into `WireShapeError`s.
 */
import { selectBindings, type SparqlBindingCell } from '../_bootstrap/select-response.js';
import type { ApiClient } from '../../packages/cli/src/api-client.js';
import {
  CATCHUP_JOB_STATES,
  type CatchupContextGraphIdentity,
  type CatchupJobState,
  type CatchupStatusResponse,
} from '../../packages/cli/src/catchup-status.js';

/** The CLI client's declaration of the subscribe reply (the route builds the body inline and exports none). */
type SubscribeDeclaration = Awaited<ReturnType<ApiClient['subscribeToContextGraph']>>;
/** The queued variant of its `catchup` member: the one that carries a job id. */
type QueuedCatchupDeclaration = Extract<NonNullable<SubscribeDeclaration['catchup']>, { jobId: string }>;
/** One row of the CLI client's declaration of the context-graph list. */
type ListRowDeclaration = Awaited<ReturnType<ApiClient['listContextGraphs']>>['contextGraphs'][number];

/**
 * POST /api/context-graph/subscribe. `catchup` is what the request queued or
 * replayed: `jobId` is absent in the completed-catch-up variant, whose counters
 * the suite does not read. The client declares `catchup.status` as `'queued'`
 * only, but the route also replays a running or done job, so it is promised only
 * as a string. `syncMode` and the rest are not checked and not here.
 */
export interface SubscribeReply {
  readonly subscribed: SubscribeDeclaration['subscribed'];
  readonly catchup?: Partial<Pick<QueuedCatchupDeclaration, 'jobId'>> & { readonly [K in keyof Pick<QueuedCatchupDeclaration, 'status'>]?: string };
  readonly identity?: SubscribeDeclaration['identity'];
  readonly onChainReference?: SubscribeDeclaration['onChainReference'];
}

/**
 * One row of GET /api/context-graph/list: the on-chain id a node observed for it,
 * as the row's `onChainId` or, when the node has chain facts, its `onChain.id`.
 * The row's `id`, `uri`, `name` and the rest are not checked and not here.
 */
export interface ContextGraphListRow {
  readonly onChainId?: ListRowDeclaration['onChainId'];
  readonly onChain?: Pick<NonNullable<ListRowDeclaration['onChain']>, 'id'>;
}

/** GET /api/context-graph/list. */
export interface ContextGraphListReply {
  readonly contextGraphs: readonly ContextGraphListRow[];
}

/**
 * One row of GET /api/context-graph/subscriptions. The route builds it inline
 * (packages/cli/src/daemon/routes/context-graph.ts, "GET /api/context-graph/
 * subscriptions") and no exported declaration exists, so the four scalar fields
 * are stated here exactly as the route emits them; `identity` is the daemon's
 * name-hash identity note, the same declaration the subscribe reply and the
 * catch-up status carry.
 */
export interface SubscriptionRow {
  readonly contextGraphId: string;
  readonly subscribed: boolean;
  readonly synced: boolean;
  readonly coreHosted: boolean;
  readonly identity?: CatchupContextGraphIdentity;
}

/** GET /api/context-graph/subscriptions. */
export interface SubscriptionsReply {
  readonly subscriptions: readonly SubscriptionRow[];
}

/**
 * GET /api/sync/catchup-status: the job's identity and verdict. The counters, the
 * timestamps, the graph sync status and the rest of `CatchupStatusResponse` are not
 * checked and not here.
 */
export type CatchupStatusReply = Pick<
  CatchupStatusResponse,
  'jobId' | 'contextGraphId' | 'jobStatus' | 'resolvedContextGraphId' | 'error' | 'identity'
>;

/** What the suite needs of a node to dial it: its peer id and the addresses it listens on. */
export interface NodePeerInfo {
  readonly peerId: string;
  readonly multiaddrs: readonly string[];
}

/** The rows of a SELECT: each variable is a term string or the structured SPARQL-JSON cell. */
export type QueryBindings = ReadonlyArray<Readonly<Record<string, SparqlBindingCell>>>;

export type { CatchupContextGraphIdentity, CatchupJobState };

/** The endpoints, spelled once so an error names the same string a reader greps for. */
export const ENDPOINT = {
  subscribe: 'POST /api/context-graph/subscribe',
  list: 'GET /api/context-graph/list',
  subscriptions: 'GET /api/context-graph/subscriptions',
  catchupStatus: 'GET /api/sync/catchup-status',
  status: 'GET /api/status',
  connections: 'GET /api/connections',
  query: 'POST /api/query',
} as const;

/**
 * What GET /api/sync/catchup-status answers when no job is named by the id it was
 * given: 404 with this `error` (packages/cli/src/daemon/routes/query.ts). The route
 * answers a refusal, an id the caller may not follow, the same way.
 */
export const NO_CATCHUP_JOB_ERROR = 'No catch-up job found';

/**
 * Whether a reply of GET /api/sync/catchup-status is the route's own "no job names
 * this id" answer. Only that is an absence: the status AND the body are matched,
 * because a bare 404 is also what an unmatched route answers (`{ error: 'Not found' }`,
 * packages/cli/src/daemon/handle-request.ts, e.g. a daemon without the endpoint) and what
 * the same route answers for a job id it does not hold (`Catch-up job "<id>" not found`,
 * which a lookup by graph id reaches only when a job was evicted behind an alias).
 * Neither says that no job names the id, so neither may satisfy an absence assertion.
 * If the route rewords its message, the lookup fails loudly (the failure names the status
 * and the body) instead of passing silently.
 */
export function isNoCatchupJobReply(status: number, body: unknown): boolean {
  if (status !== 404 || body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  return Object.entries(body).some(([key, value]) => key === 'error' && value === NO_CATCHUP_JOB_ERROR);
}

// The identity-note states: a copy, tied to its declaration at the type level (see the header).
export const WIRE_IDENTITY_STATES = ['name-hash-only', 'name-hash-only-private', 'resolved'] as const satisfies
  readonly CatchupContextGraphIdentity['state'][];

type MustBeNever<T extends never> = T;
/** A type error here means the declaration gained an identity state that the list above lacks. */
export type IdentityStatesListed = MustBeNever<
  Exclude<CatchupContextGraphIdentity['state'], (typeof WIRE_IDENTITY_STATES)[number]>
>;

/**
 * A reply that does not have the shape the suite reads. `field` is a dotted path
 * from the reply root. `context` is what a caller added to the message, such as
 * the node the reply came from: `withContext` keeps the class and every field, so
 * a caller that must tell a malformed reply from a transport failure can still
 * recognise it with `instanceof WireShapeError` after it was annotated.
 */
export class WireShapeError extends Error {
  constructor(
    readonly endpoint: string,
    readonly field: string,
    readonly expected: string,
    readonly actual: unknown,
    readonly context?: string,
    options?: ErrorOptions,
  ) {
    super(`${context === undefined ? '' : `${context} `}${endpoint}: ${field} is ${describeActual(actual)}, expected ${expected}`, options);
    this.name = 'WireShapeError';
  }

  /** The same failure with `context` in front of the message (the original stays as `cause`). */
  withContext(context: string): WireShapeError {
    return new WireShapeError(
      this.endpoint,
      this.field,
      this.expected,
      this.actual,
      this.context === undefined ? context : `${context} ${this.context}`,
      { cause: this },
    );
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
  return Object.fromEntries(Object.entries(value));
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
  const match = allowed.find((entry) => entry === value);
  if (match === undefined) {
    throw new WireShapeError(endpoint, `${field}.${key}`, `one of ${allowed.map((entry) => JSON.stringify(entry)).join(', ')}`, value);
  }
  return match;
}

/**
 * `{ [key]: value }`, or nothing when `value` is undefined, so a projection never
 * carries `key: undefined`. The one cast of this module: TypeScript cannot type a
 * computed key of a generic literal type.
 */
function present<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** The name-hash identity note every one of the four replies can carry; absent means "no note". */
function optionalIdentity(endpoint: string, field: string, parent: Obj): CatchupContextGraphIdentity | undefined {
  const raw = parent.identity;
  if (raw === undefined) return undefined;
  const path = `${field}.identity`;
  const note = object(endpoint, path, raw);
  return {
    state: oneOf(endpoint, path, note, 'state', WIRE_IDENTITY_STATES),
    nameHash: requiredString(endpoint, path, note, 'nameHash'),
    message: requiredString(endpoint, path, note, 'message'),
    ...present('onChainId', optionalString(endpoint, path, note, 'onChainId')),
    ...present('contextGraphId', optionalString(endpoint, path, note, 'contextGraphId')),
  };
}

/** POST /api/context-graph/subscribe. Checks `subscribed`, `catchup.jobId`, `catchup.status`, `identity` and `onChainReference`. */
export function parseSubscribeResponse(value: unknown): SubscribeReply {
  const endpoint = ENDPOINT.subscribe;
  const reply = object(endpoint, 'reply', value);
  const subscribed = requiredString(endpoint, 'reply', reply, 'subscribed');
  let catchup: SubscribeReply['catchup'];
  if (reply.catchup !== undefined) {
    const raw = object(endpoint, 'reply.catchup', reply.catchup);
    catchup = {
      ...present('jobId', optionalString(endpoint, 'reply.catchup', raw, 'jobId')),
      ...present('status', optionalString(endpoint, 'reply.catchup', raw, 'status')),
    };
  }
  let onChainReference: SubscribeReply['onChainReference'];
  if (reply.onChainReference !== undefined) {
    const raw = object(endpoint, 'reply.onChainReference', reply.onChainReference);
    onChainReference = {
      onChainId: requiredString(endpoint, 'reply.onChainReference', raw, 'onChainId'),
      message: requiredString(endpoint, 'reply.onChainReference', raw, 'message'),
    };
  }
  return {
    subscribed,
    ...present('catchup', catchup),
    ...present('identity', optionalIdentity(endpoint, 'reply', reply)),
    ...present('onChainReference', onChainReference),
  };
}

/** GET /api/context-graph/list. Checks, per row, `onChainId` and `onChain.id`. */
export function parseContextGraphListResponse(value: unknown): ContextGraphListReply {
  const endpoint = ENDPOINT.list;
  const reply = object(endpoint, 'reply', value);
  if (!Array.isArray(reply.contextGraphs)) {
    throw new WireShapeError(endpoint, 'reply.contextGraphs', 'an array', reply.contextGraphs);
  }
  return {
    contextGraphs: reply.contextGraphs.map((raw: unknown, index: number): ContextGraphListRow => {
      const field = `reply.contextGraphs[${index}]`;
      const row = object(endpoint, field, raw);
      const onChainId = optionalString(endpoint, field, row, 'onChainId');
      const onChain = row.onChain === undefined
        ? undefined
        : { id: requiredString(endpoint, `${field}.onChain`, object(endpoint, `${field}.onChain`, row.onChain), 'id') };
      return { ...present('onChainId', onChainId), ...present('onChain', onChain) };
    }),
  };
}

/** One entry of GET /api/context-graph/subscriptions. */
export function parseSubscriptionRow(value: unknown, field = 'row'): SubscriptionRow {
  const endpoint = ENDPOINT.subscriptions;
  const row = object(endpoint, field, value);
  return {
    contextGraphId: requiredString(endpoint, field, row, 'contextGraphId'),
    subscribed: requiredBoolean(endpoint, field, row, 'subscribed'),
    synced: requiredBoolean(endpoint, field, row, 'synced'),
    coreHosted: requiredBoolean(endpoint, field, row, 'coreHosted'),
    ...present('identity', optionalIdentity(endpoint, field, row)),
  };
}

/** GET /api/context-graph/subscriptions: the list and each of its rows. */
export function parseSubscriptionsResponse(value: unknown): SubscriptionsReply {
  const reply = object(ENDPOINT.subscriptions, 'reply', value);
  if (!Array.isArray(reply.subscriptions)) {
    throw new WireShapeError(ENDPOINT.subscriptions, 'reply.subscriptions', 'an array', reply.subscriptions);
  }
  return { subscriptions: reply.subscriptions.map((row: unknown, index: number) => parseSubscriptionRow(row, `reply.subscriptions[${index}]`)) };
}

/**
 * GET /api/sync/catchup-status. Checks `jobId`, `contextGraphId`, `jobStatus` (one of
 * the CLI's `CATCHUP_JOB_STATES`), `resolvedContextGraphId`, `error` and `identity`.
 */
export function parseCatchupStatusResponse(value: unknown): CatchupStatusReply {
  const endpoint = ENDPOINT.catchupStatus;
  const reply = object(endpoint, 'reply', value);
  return {
    jobId: requiredString(endpoint, 'reply', reply, 'jobId'),
    contextGraphId: requiredString(endpoint, 'reply', reply, 'contextGraphId'),
    jobStatus: oneOf(endpoint, 'reply', reply, 'jobStatus', CATCHUP_JOB_STATES),
    ...present('resolvedContextGraphId', optionalString(endpoint, 'reply', reply, 'resolvedContextGraphId')),
    ...present('error', optionalString(endpoint, 'reply', reply, 'error')),
    ...present('identity', optionalIdentity(endpoint, 'reply', reply)),
  };
}

/**
 * POST /api/query: the bindings of a SELECT, wherever the daemon puts them. The envelope
 * selection, the rows and the cells are read by the harness's shared module
 * (`_bootstrap/select-response.ts`, the same one `queryNode` reads through) in its strict
 * reading: a 200 with no bindings array in any envelope, with an envelope holder that is
 * not an object, with a row that is not an object or with a cell that is neither a term
 * string nor an object whose `value`, `datatype`, `type`, `xml:lang` and `lang` are strings
 * when present, is a failure of the reply, not "no rows yet". What is left to this suite
 * is the diagnostic: every rejection becomes a `WireShapeError` naming this endpoint.
 */
export function parseQueryBindings(value: unknown): QueryBindings {
  const endpoint = ENDPOINT.query;
  return selectBindings(value, {
    strict: true,
    reject: (path, expected, actual) => {
      throw new WireShapeError(endpoint, path, expected, actual);
    },
  });
}

/** GET /api/status. Checks `peerId` and `multiaddrs`. */
export function parseNodePeerInfo(value: unknown): NodePeerInfo {
  const endpoint = ENDPOINT.status;
  const reply = object(endpoint, 'reply', value);
  const peerId = requiredString(endpoint, 'reply', reply, 'peerId');
  const raw = reply.multiaddrs;
  if (!Array.isArray(raw)) throw new WireShapeError(endpoint, 'reply.multiaddrs', 'an array', raw);
  const multiaddrs = raw.map((entry: unknown, index: number) => {
    if (typeof entry !== 'string') throw new WireShapeError(endpoint, `reply.multiaddrs[${index}]`, 'a string', entry);
    return entry;
  });
  return { peerId, multiaddrs };
}

/** GET /api/connections. Checks the `peerId` of every entry of `connections`. */
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
