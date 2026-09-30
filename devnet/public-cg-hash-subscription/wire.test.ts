/**
 * The suite's wire validators, proven without a devnet: each accepts a
 * real-shaped payload (with fields it does not check, which stay out of what it
 * returns) and rejects a renamed or retyped field it does check, with a message
 * that names the endpoint and the field.
 *
 * "Real-shaped" is as real as it can be made here. The catch-up status payloads
 * are built by the daemon's own `toCatchupStatusResponse`, and the job states
 * are read from the daemon's own `CATCHUP_JOB_STATES`, the list wire.ts itself
 * validates against (this test also loads daemon/types.ts at runtime, which the
 * suite does not). The subscribe reply, the list reply and the subscriptions list
 * are built inline by their routes and export no builder, so those payloads are
 * written out here exactly as the routes build them (packages/cli/src/daemon/
 * routes/context-graph.ts).
 *
 * The `@ts-expect-error` lines are type-level checks: they only mean something
 * under a type-check of this file (a throwaway tsconfig, an editor), where they
 * fail if a projection ever exposes a field its parser does not check.
 *
 * What this cannot prove: that a live daemon still emits these shapes. The devnet
 * run does that, through the same validators.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATCHUP_JOB_STATES } from '../../packages/cli/src/catchup-status.js';
import { toCatchupStatusResponse, type CatchupJob } from '../../packages/cli/src/daemon/types.js';
import {
  ENDPOINT,
  NO_CATCHUP_JOB_ERROR,
  type CatchupContextGraphIdentity,
  WireShapeError,
  isNoCatchupJobReply,
  parseCatchupStatusResponse,
  parseConnectedPeerIds,
  parseContextGraphListResponse,
  parseNodePeerInfo,
  parseQueryBindings,
  parseSubscribeResponse,
  parseSubscriptionRow,
  parseSubscriptionsResponse,
  type QueryBindings,
} from './wire.js';

const HASH = `0x${'ab'.repeat(32)}`;
const CLEARTEXT = 'devnet-hash-sub-wire-test';

const hashOnly = { state: 'name-hash-only', nameHash: HASH, onChainId: '7', message: 'known only by its on-chain name hash' } satisfies CatchupContextGraphIdentity;
const resolved = { state: 'resolved', nameHash: HASH, onChainId: '7', contextGraphId: CLEARTEXT, message: 'resolved to its cleartext id' } satisfies CatchupContextGraphIdentity;

/** A copy of `value` with `patch` applied; an `undefined` entry deletes the key. */
function with_<T extends object>(value: T, patch: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [key, entry] of Object.entries(patch)) {
    if (entry === undefined) delete copy[key];
    else copy[key] = entry;
  }
  return copy;
}

/** Rename `from` to `to`, keeping its value. */
function renamed(value: object, from: string, to: string): Record<string, unknown> {
  const { [from]: kept, ...rest } = value as Record<string, unknown>;
  return { ...rest, [to]: kept };
}

/** What the queued variant of the route's 200 body looks like. */
const queuedReply = {
  subscribed: HASH,
  syncMode: 'always-on',
  catchup: { status: 'queued', includeWorkspace: true, jobId: 'ml3x9a-k2j1qz' },
  identity: hashOnly,
};
/** The completed-catch-up variant: a `catchup` object with counters and no job id. */
const completedReply = {
  subscribed: CLEARTEXT,
  syncMode: 'always-on',
  catchup: { connectedPeers: 4, syncCapablePeers: 4, peersTried: 4, peersResponded: 4, peersSucceeded: 4, deferredBackpressure: 0, dataSynced: 12, sharedMemorySynced: 3, denied: false, deniedPeers: 0 },
  onChainReference: { onChainId: '7', message: 'On-chain id 7 is the graph named ...' },
};

describe('parseSubscribeResponse', () => {
  it.each([
    ['a queued job with an identity note', queuedReply, { subscribed: HASH, catchup: { status: 'queued', jobId: 'ml3x9a-k2j1qz' }, identity: hashOnly }],
    ['the completed-catch-up variant, which has no job id, with an on-chain reference note', completedReply, { subscribed: CLEARTEXT, catchup: {}, onChainReference: completedReply.onChainReference }],
    ['a replayed job (a status other than queued)', with_(queuedReply, { catchup: { status: 'done', includeWorkspace: true, jobId: 'ml3x9a-done00' } }), { subscribed: HASH, catchup: { status: 'done', jobId: 'ml3x9a-done00' }, identity: hashOnly }],
    ['no catch-up at all', with_(queuedReply, { catchup: undefined }), { subscribed: HASH, identity: hashOnly }],
  ])('accepts %s and returns exactly the fields it checked', (_name, payload, projection) => {
    expect(parseSubscribeResponse(payload)).toStrictEqual(projection);
  });

  it('accepts fields it does not check, and leaves them out of what it returns', () => {
    const noisy = with_(queuedReply, {
      syncMode: 12,
      somethingNew: { a: 1 },
      catchup: { status: 'queued', includeWorkspace: true, jobId: 'x', peersTried: 'many' },
      identity: { ...hashOnly, extra: 1 },
    });
    const parsed = parseSubscribeResponse(noisy);
    expect(parsed).toStrictEqual({ subscribed: HASH, catchup: { status: 'queued', jobId: 'x' }, identity: hashOnly });
    expect(parsed).not.toHaveProperty('syncMode');
    // @ts-expect-error `syncMode` is not checked, so it is not in the returned type either
    void parsed.syncMode;
    // @ts-expect-error nor are the completed-catch-up counters
    void parsed.catchup?.peersTried;
  });

  it.each([
    ['a renamed `subscribed`', renamed(queuedReply, 'subscribed', 'subscribedTo'), 'reply.subscribed is missing, expected a string'],
    ['a retyped `subscribed`', with_(queuedReply, { subscribed: 33 }), 'reply.subscribed is the number 33, expected a string'],
    ['a `catchup` that is not an object', with_(queuedReply, { catchup: 'queued' }), 'reply.catchup is the string "queued", expected an object'],
    ['a retyped `catchup.jobId`', with_(queuedReply, { catchup: { status: 'queued', includeWorkspace: true, jobId: 7 } }), 'reply.catchup.jobId is the number 7, expected a string when present'],
    ['a retyped `catchup.status`', with_(queuedReply, { catchup: { status: 5, includeWorkspace: true, jobId: 'x' } }), 'reply.catchup.status is the number 5, expected a string when present'],
    ['an identity state spelled differently', with_(queuedReply, { identity: { ...hashOnly, state: 'hash-only' } }), 'reply.identity.state is the string "hash-only", expected one of "name-hash-only", "name-hash-only-private", "resolved"'],
    ['an identity without its message', with_(queuedReply, { identity: with_(hashOnly, { message: undefined }) }), 'reply.identity.message is missing, expected a string'],
    ['an identity whose hash was renamed', with_(queuedReply, { identity: renamed(hashOnly, 'nameHash', 'hash') }), 'reply.identity.nameHash is missing, expected a string'],
    ['an on-chain reference without its id', with_(completedReply, { onChainReference: { message: 'x' } }), 'reply.onChainReference.onChainId is missing, expected a string'],
  ])('rejects %s', (_name, payload, detail) => {
    expect(() => parseSubscribeResponse(payload)).toThrow(WireShapeError);
    expect(() => parseSubscribeResponse(payload)).toThrow(`${ENDPOINT.subscribe}: ${detail}`);
  });

  it.each([[null], [[]], ['ok'], [42]])('rejects a body that is not an object (%j)', (payload) => {
    expect(() => parseSubscribeResponse(payload)).toThrow(`${ENDPOINT.subscribe}: reply is `);
  });
});

describe('parseContextGraphListResponse', () => {
  const list = {
    contextGraphs: [
      { id: 'devnet-test', uri: 'did:dkg:context-graph:devnet-test', name: 'devnet-test', isSystem: false, subscribed: true },
      { id: HASH, uri: 'did:dkg:context-graph:x', name: HASH, isSystem: false, onChainId: '7', nameKnown: false },
      { id: CLEARTEXT, uri: 'did:dkg:context-graph:y', name: CLEARTEXT, isSystem: false, onChain: { id: '8', access: 'public', publishPolicy: 'open', owner: null, createdAt: null, active: true, nameHash: HASH } },
    ],
  };

  it('returns only the on-chain ids of each row: from `onChainId`, from the chain view, or none', () => {
    expect(parseContextGraphListResponse(list)).toStrictEqual({
      contextGraphs: [{}, { onChainId: '7' }, { onChain: { id: '8' } }],
    });
    expect(parseContextGraphListResponse({ contextGraphs: [] })).toEqual({ contextGraphs: [] });
  });

  it('accepts rows without an id, uri, name or isSystem, and does not expose those fields', () => {
    const parsed = parseContextGraphListResponse({ contextGraphs: [{ onChainId: '7' }, { onChain: { id: '8', active: false } }] });
    expect(parsed.contextGraphs).toStrictEqual([{ onChainId: '7' }, { onChain: { id: '8' } }]);
    // @ts-expect-error the row's `id` is not checked, so it is not in the returned type
    void parsed.contextGraphs[0]?.id;
    // @ts-expect-error nor is `isSystem`
    void parsed.contextGraphs[0]?.isSystem;
  });

  it.each([
    ['a renamed `contextGraphs`', renamed(list, 'contextGraphs', 'graphs'), 'reply.contextGraphs is missing, expected an array'],
    ['a `contextGraphs` that is an object', { contextGraphs: {} }, 'reply.contextGraphs is an object, expected an array'],
    ['a row that is not an object', { contextGraphs: [list.contextGraphs[0], 'devnet-test'] }, 'reply.contextGraphs[1] is the string "devnet-test", expected an object'],
    ['a retyped `onChainId`', { contextGraphs: [{ id: 'a', onChainId: 7 }] }, 'reply.contextGraphs[0].onChainId is the number 7, expected a string when present'],
    ['an `onChain` view without its id', { contextGraphs: [{ id: 'a', onChain: { access: 'public' } }] }, 'reply.contextGraphs[0].onChain.id is missing, expected a string'],
  ])('rejects %s', (_name, payload, detail) => {
    expect(() => parseContextGraphListResponse(payload)).toThrow(`${ENDPOINT.list}: ${detail}`);
  });
});

describe('parseSubscriptionsResponse', () => {
  const row = { contextGraphId: CLEARTEXT, subscribed: true, synced: false, coreHosted: false };
  const list = {
    count: 2,
    subscriptions: [row, { ...row, contextGraphId: HASH, identity: hashOnly }],
    rehydration: null,
  };

  it('accepts the route body: rows with and without an identity note, and the fields around them', () => {
    expect(parseSubscriptionsResponse(list)).toStrictEqual({ subscriptions: list.subscriptions });
    expect(parseSubscriptionRow(row)).toStrictEqual(row);
    expect(parseSubscriptionRow({ ...row, identity: resolved }).identity).toEqual(resolved);
  });

  it('leaves the fields of a row it does not check out of what it returns', () => {
    const parsed = parseSubscriptionRow({ ...row, syncMode: 'always-on', contextGraphName: 'x', identity: { ...hashOnly, extra: 1 } });
    expect(parsed).toStrictEqual({ ...row, identity: hashOnly });
    // @ts-expect-error `syncMode` is not checked, so it is not in the returned type
    void parsed.syncMode;
  });

  it.each([
    ['a renamed `subscriptions`', renamed(list, 'subscriptions', 'subs'), 'reply.subscriptions is missing, expected an array'],
    ['a `subscriptions` that is not an array', with_(list, { subscriptions: { count: 0 } }), 'reply.subscriptions is an object, expected an array'],
    ['a row whose id was renamed', with_(list, { subscriptions: [row, renamed(row, 'contextGraphId', 'id')] }), 'reply.subscriptions[1].contextGraphId is missing, expected a string'],
    ['a retyped `synced`', with_(list, { subscriptions: [with_(row, { synced: 'yes' })] }), 'reply.subscriptions[0].synced is the string "yes", expected a boolean'],
    ['a dropped `coreHosted`', with_(list, { subscriptions: [with_(row, { coreHosted: undefined })] }), 'reply.subscriptions[0].coreHosted is missing, expected a boolean'],
    ['a changed identity shape', with_(list, { subscriptions: [with_(row, { identity: with_(hashOnly, { state: 'pending' }) })] }), 'reply.subscriptions[0].identity.state is the string "pending", expected one of'],
  ])('rejects %s', (_name, payload, detail) => {
    expect(() => parseSubscriptionsResponse(payload)).toThrow(`${ENDPOINT.subscriptions}: ${detail}`);
  });

  it('names the row in a failure of one row read alone', () => {
    expect(() => parseSubscriptionRow(with_(row, { subscribed: 1 }))).toThrow(`${ENDPOINT.subscriptions}: row.subscribed is the number 1, expected a boolean`);
  });
});

describe('parseCatchupStatusResponse', () => {
  const job = (status: CatchupJob['status'], extra: Partial<CatchupJob> = {}): CatchupJob => ({
    jobId: 'ml3x9a-k2j1qz',
    contextGraphId: HASH,
    includeWorkspace: true,
    status,
    queuedAt: 1_700_000_000_000,
    startedAt: 1_700_000_000_100,
    finishedAt: 1_700_000_000_200,
    ...extra,
  });

  it.each(CATCHUP_JOB_STATES.map((status) => [status] as const))(
    'accepts what the daemon builds for a job that is %s and returns exactly the fields it checked',
    (status) => {
      const unreachable = status === 'unreachable';
      const payload = toCatchupStatusResponse(job(status, unreachable ? { error: hashOnly.message } : {}), undefined, unreachable ? hashOnly : null);
      expect(parseCatchupStatusResponse(payload)).toStrictEqual({
        jobId: 'ml3x9a-k2j1qz',
        contextGraphId: HASH,
        jobStatus: status,
        ...(unreachable ? { error: hashOnly.message, identity: hashOnly } : {}),
      });
    },
  );

  it('accepts a job that continued under the cleartext id, with a resolved identity note', () => {
    const payload = toCatchupStatusResponse(job('done', { resolvedContextGraphId: CLEARTEXT }), undefined, resolved);
    expect(parseCatchupStatusResponse(payload)).toStrictEqual({
      jobId: 'ml3x9a-k2j1qz',
      contextGraphId: HASH,
      jobStatus: 'done',
      resolvedContextGraphId: CLEARTEXT,
      identity: resolved,
    });
  });

  it('accepts fields it does not check, retyped or not, and leaves them out of what it returns', () => {
    const payload = with_(toCatchupStatusResponse(job('done'), undefined, null), { queuedAt: 'yesterday', status: 'finished', graphSync: 12, extra: [1] });
    const parsed = parseCatchupStatusResponse(payload);
    expect(parsed).toStrictEqual({ jobId: 'ml3x9a-k2j1qz', contextGraphId: HASH, jobStatus: 'done' });
    // @ts-expect-error the timestamps are not checked, so they are not in the returned type
    void parsed.queuedAt;
    // @ts-expect-error nor is the legacy `status`
    void parsed.status;
  });

  const good = toCatchupStatusResponse(job('unreachable', { error: 'x' }), undefined, hashOnly);
  it.each([
    ['a renamed `jobStatus`', renamed(good, 'jobStatus', 'state'), 'reply.jobStatus is missing, expected one of "queued", "running", "done"'],
    ['a job state spelled differently', with_(good, { jobStatus: 'finished' }), 'reply.jobStatus is the string "finished", expected one of'],
    ['a retyped `jobId`', with_(good, { jobId: 42 }), 'reply.jobId is the number 42, expected a string'],
    ['a dropped `contextGraphId`', with_(good, { contextGraphId: undefined }), 'reply.contextGraphId is missing, expected a string'],
    ['a retyped `resolvedContextGraphId`', with_(good, { resolvedContextGraphId: 3 }), 'reply.resolvedContextGraphId is the number 3, expected a string when present'],
    ['a retyped `error`', with_(good, { error: { message: 'x' } }), 'reply.error is an object, expected a string when present'],
    ['a changed identity shape', with_(good, { identity: { state: 'resolved', hash: HASH } }), 'reply.identity.nameHash is missing, expected a string'],
  ])('rejects %s', (_name, payload, detail) => {
    expect(() => parseCatchupStatusResponse(payload)).toThrow(`${ENDPOINT.catchupStatus}: ${detail}`);
  });
});

describe('parseNodePeerInfo and parseConnectedPeerIds', () => {
  const status = { peerId: '12D3KooWExample', multiaddrs: ['/ip4/127.0.0.1/tcp/10006/p2p/12D3KooWExample'], connectedPeers: 4 };
  const connections = {
    total: 2,
    direct: 2,
    relayed: 0,
    connections: [
      { peerId: '12D3KooWOne', remoteAddr: '/ip4/127.0.0.1/tcp/10001', transport: 'direct', direction: 'outbound' },
      { peerId: '12D3KooWTwo', remoteAddr: '/ip4/127.0.0.1/tcp/10002', transport: 'direct', direction: 'outbound' },
    ],
  };

  it('accept the route bodies and return what the suite reads', () => {
    expect(parseNodePeerInfo(status)).toEqual({ peerId: '12D3KooWExample', multiaddrs: status.multiaddrs });
    expect(parseConnectedPeerIds(connections)).toEqual(['12D3KooWOne', '12D3KooWTwo']);
    expect(parseConnectedPeerIds({ connections: [] })).toEqual([]);
  });

  it.each([
    ['a renamed `peerId`', () => parseNodePeerInfo(renamed(status, 'peerId', 'id')), `${ENDPOINT.status}: reply.peerId is missing, expected a string`],
    ['a `multiaddrs` that is not an array', () => parseNodePeerInfo(with_(status, { multiaddrs: '/ip4/127.0.0.1' })), `${ENDPOINT.status}: reply.multiaddrs is the string "/ip4/127.0.0.1", expected an array`],
    ['an address that is not a string', () => parseNodePeerInfo(with_(status, { multiaddrs: ['/ip4/1.2.3.4', 7] })), `${ENDPOINT.status}: reply.multiaddrs[1] is the number 7, expected a string`],
    ['a renamed `connections`', () => parseConnectedPeerIds(renamed(connections, 'connections', 'peers')), `${ENDPOINT.connections}: reply.connections is missing, expected an array`],
    ['a connection without its `peerId`', () => parseConnectedPeerIds({ connections: [{ remotePeer: 'x' }] }), `${ENDPOINT.connections}: reply.connections[0].peerId is missing, expected a string`],
  ])('reject %s', (_name, parse, detail) => {
    expect(parse).toThrow(detail);
  });
});

describe('isNoCatchupJobReply', () => {
  it('is the route\'s own 404 "No catch-up job found", and nothing else', () => {
    expect(isNoCatchupJobReply(404, { error: NO_CATCHUP_JOB_ERROR })).toBe(true);
    expect(isNoCatchupJobReply(404, { error: 'No catch-up job found', extra: 1 })).toBe(true);
  });

  it.each([
    ['another status with the same message', 400, { error: NO_CATCHUP_JOB_ERROR }],
    ['a 200 with the same message', 200, { error: NO_CATCHUP_JOB_ERROR }],
    ['the unmatched-route 404', 404, { error: 'Not found' }],
    ['the unknown-job-id 404', 404, { error: 'Catch-up job "j1" not found' }],
    ['a 404 whose message is reworded', 404, { error: 'no catch-up job found' }],
    ['a 404 with no error field', 404, {}],
    ['a 404 whose error is not a string', 404, { error: [NO_CATCHUP_JOB_ERROR] }],
    ['a 404 with a body that is not an object', 404, NO_CATCHUP_JOB_ERROR],
    ['a 404 with an array body', 404, [NO_CATCHUP_JOB_ERROR]],
    ['a 404 that is not JSON', 404, null],
    ['a 404 with no body', 404, undefined],
  ])('is not %s', (_what, status, body) => {
    expect(isNoCatchupJobReply(status, body)).toBe(false);
  });

  it('matches what the route sends: the message is the literal of the route\'s no-job reply', () => {
    // The daemon's 404 body is built inline and exported nowhere, so the suite's copy of the
    // message is tied to the route's source: a reworded route fails here, without a devnet.
    const route = readFileSync(resolve(import.meta.dirname, '../../packages/cli/src/daemon/routes/query.ts'), 'utf8');
    expect(route).toMatch(new RegExp(`jsonResponse\\(res,\\s*404,\\s*\\{\\s*error:\\s*["']${NO_CATCHUP_JOB_ERROR}["']\\s*\\}\\)`));
  });
});

describe('parseQueryBindings', () => {
  const bindings = [{ p: '<https://schema.org/name>', o: '"kept"' }, { p: { value: 'https://schema.org/description', type: 'uri' }, o: { value: 'x', datatype: 'http://www.w3.org/2001/XMLSchema#string' } }];

  it.each([
    ['the current daemon shape (result.bindings)', { type: 'bindings', result: { bindings }, bindings: [] }],
    ['SPARQL JSON (results.bindings)', { head: { vars: ['p', 'o'] }, results: { bindings } }],
    ['the legacy flat shape (bindings)', { bindings }],
  ])('accepts %s and returns the rows', (_name, payload) => {
    expect(parseQueryBindings(payload)).toStrictEqual(bindings);
  });

  it('keeps only the fields of a structured cell that the harness reads', () => {
    const parsed = parseQueryBindings({ result: { bindings: [{ o: { value: 'x', type: 'literal', 'xml:lang': 'en', extra: 1 } }] } });
    expect(parsed).toStrictEqual([{ o: { value: 'x', type: 'literal', 'xml:lang': 'en' } }]);
  });

  it('accepts a SELECT with no rows', () => {
    expect(parseQueryBindings({ result: { bindings: [] } })).toEqual([]);
  });

  it.each([
    ['a body that is not an object', 'ok', `${ENDPOINT.query}: reply is the string "ok", expected an object`],
    ['a body with no bindings anywhere', { result: {}, type: 'quads' }, `${ENDPOINT.query}: reply.result.bindings is missing, expected an array (or results.bindings, or bindings)`],
    ['bindings that are not an array', { result: { bindings: 'none' } }, `${ENDPOINT.query}: reply.result.bindings is the string "none", expected an array`],
    ['a result that is not an object', { result: 3, bindings: [] }, `${ENDPOINT.query}: reply.result is the number 3, expected an object`],
    ['a row that is not an object', { results: { bindings: [{ p: 'a' }, 'row'] } }, `${ENDPOINT.query}: reply.results.bindings[1] is the string "row", expected an object`],
    ['a cell that is neither a term string nor an object', { bindings: [{ p: 'a', o: 7 }] }, `${ENDPOINT.query}: reply.bindings[0].o is the number 7, expected an object`],
    ['a structured cell whose value is not a string', { bindings: [{ o: { value: 7 } }] }, `${ENDPOINT.query}: reply.bindings[0].o.value is the number 7, expected a string when present`],
  ])('rejects %s', (_name, payload, message) => {
    expect(() => parseQueryBindings(payload)).toThrow(WireShapeError);
    expect(() => parseQueryBindings(payload)).toThrow(message);
  });
});

/**
 * The parser as it was before it delegated to `_bootstrap/select-response.ts`, frozen
 * verbatim (only renamed), so the delegation is shown not to have changed what the suite
 * accepts or how it says no. Do not edit it to follow the parser.
 */
function frozenParseQueryBindings(value: unknown): QueryBindings {
  type Obj = Record<string, unknown>;
  const endpoint = ENDPOINT.query;
  const object = (field: string, candidate: unknown): Obj => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new WireShapeError(endpoint, field, 'an object', candidate);
    }
    return Object.fromEntries(Object.entries(candidate));
  };
  const optionalString = (field: string, parent: Obj, key: string): string | undefined => {
    const entry = parent[key];
    if (entry === undefined) return undefined;
    if (typeof entry !== 'string') throw new WireShapeError(endpoint, `${field}.${key}`, 'a string when present', entry);
    return entry;
  };
  const present = (key: string, entry: string | undefined): Obj => (entry === undefined ? {} : { [key]: entry });
  const reply = object('reply', value);
  const holders: Array<[string, Obj | undefined]> = [
    ['reply.result', reply.result === undefined ? undefined : object('reply.result', reply.result)],
    ['reply.results', reply.results === undefined ? undefined : object('reply.results', reply.results)],
    ['reply', reply],
  ];
  const found = holders.find(([, holder]) => holder?.bindings !== undefined);
  if (found === undefined) {
    throw new WireShapeError(endpoint, 'reply.result.bindings', 'an array (or results.bindings, or bindings)', undefined);
  }
  const [path, holder] = found;
  const bindings = holder?.bindings;
  if (!Array.isArray(bindings)) throw new WireShapeError(endpoint, `${path}.bindings`, 'an array', bindings);
  return bindings.map((row: unknown, index: number) => {
    const rowPath = `${path}.bindings[${index}]`;
    const cells = object(rowPath, row);
    const parsed: Record<string, never> = {};
    for (const [name, cell] of Object.entries(cells)) {
      if (typeof cell === 'string') {
        parsed[name] = cell as never;
        continue;
      }
      const cellPath = `${rowPath}.${name}`;
      const structured = object(cellPath, cell);
      parsed[name] = {
        ...present('value', optionalString(cellPath, structured, 'value')),
        ...present('datatype', optionalString(cellPath, structured, 'datatype')),
        ...present('type', optionalString(cellPath, structured, 'type')),
        ...present('xml:lang', optionalString(cellPath, structured, 'xml:lang')),
        ...present('lang', optionalString(cellPath, structured, 'lang')),
      } as never;
    }
    return parsed;
  });
}

describe('parseQueryBindings reads an answer as it did before the shared module', () => {
  type Outcome = { readonly returned: unknown } | { readonly wireShape: unknown } | { readonly threw: string };
  const run = (parse: (value: unknown) => QueryBindings, value: unknown): Outcome => {
    try {
      return { returned: parse(value) };
    } catch (error) {
      if (error instanceof WireShapeError) {
        const { endpoint, field, expected, actual, message } = error;
        return { wireShape: { endpoint, field, expected, actual: actual === undefined ? 'undefined' : actual, message } };
      }
      return { threw: String(error) };
    }
  };

  const ABSENT = Symbol('absent');
  const CELLS: unknown[] = ['"a"', '<urn:x>', { value: 'x' }, { value: 'x', type: 'literal', 'xml:lang': 'en', extra: 1 }, { value: 7 }, { datatype: null }, { lang: ['en'] }, 7, null, [], true];
  const ROW_VALUES: unknown[] = [{}, { p: '"a"' }, { p: { value: 'urn:b', type: 'uri' }, o: { value: 'x', datatype: 'urn:dt' } }, ...CELLS.map((cell) => ({ o: cell })), 'row', 7, null, []];
  const BINDINGS: unknown[] = [ABSENT, [], [ROW_VALUES[1]], [ROW_VALUES[2], ROW_VALUES[3]], ROW_VALUES, '', 'none', 0, 7, false, {}, { rows: [] }];
  const HOLDERS: unknown[] = [ABSENT, null, 3, 'str', true, [], {}, ...BINDINGS.filter((value) => value !== ABSENT).map((bindings) => ({ bindings }))];
  const body = (result: unknown, results: unknown, flat: unknown): Record<string, unknown> => {
    const out: Record<string, unknown> = { type: 'bindings' };
    if (result !== ABSENT) out.result = result;
    if (results !== ABSENT) out.results = results;
    if (flat !== ABSENT) out.bindings = flat;
    return out;
  };

  it('agrees with the frozen parser on every envelope mix, row and cell: accepted set, projections, and diagnostics (endpoint, field, expected, actual, message)', () => {
    let cases = 0;
    let accepted = 0;
    let rejected = 0;
    const disagreements: string[] = [];
    for (const result of HOLDERS) {
      for (const results of HOLDERS) {
        for (const flat of BINDINGS) {
          const answer = body(result, results, flat);
          const now = run(parseQueryBindings, answer);
          const was = run(frozenParseQueryBindings, answer);
          cases += 1;
          if ('returned' in was) accepted += 1;
          else rejected += 1;
          if (JSON.stringify(now) !== JSON.stringify(was)) disagreements.push(`${JSON.stringify(answer)}\n  now: ${JSON.stringify(now)}\n  was: ${JSON.stringify(was)}`);
        }
      }
    }
    expect(disagreements.slice(0, 5), `${disagreements.length} of ${cases} answers read differently`).toEqual([]);
    expect(cases).toBeGreaterThan(1_800);
    expect(accepted).toBeGreaterThan(200);
    expect(rejected).toBeGreaterThan(1_000);
  });

  it.each([null, 'ok', 42, true, [], [{ p: 'a' }]])('agrees with the frozen parser on a body that is %j', (answer) => {
    expect(run(parseQueryBindings, answer)).toStrictEqual(run(frozenParseQueryBindings, answer));
  });

  // The one difference, on purpose: the envelope is now picked by the harness's rule (the first
  // bindings that is not null or undefined), where this parser took the first that was not
  // undefined, so a null there used to be the answer and is now read past.
  it('reads past a bindings that is null to the next envelope, as queryNode does (the frozen parser rejected it)', () => {
    const answer = { result: { bindings: null }, bindings: [{ p: '"a"' }] };
    expect(parseQueryBindings(answer)).toEqual([{ p: '"a"' }]);
    expect(() => frozenParseQueryBindings(answer)).toThrow('reply.result.bindings is null, expected an array');
    expect(() => parseQueryBindings({ result: { bindings: null } })).toThrow(`${ENDPOINT.query}: reply.result.bindings is missing, expected an array (or results.bindings, or bindings)`);
  });
});

describe('WireShapeError', () => {
  it('keeps its class and fields when a caller adds context, and keeps the original as the cause', () => {
    const original = new WireShapeError(ENDPOINT.subscribe, 'reply.catchup.jobId', 'a string when present', 7);
    const annotated = original.withContext('node5');
    expect(annotated).toBeInstanceOf(WireShapeError);
    expect(annotated).toMatchObject({ name: 'WireShapeError', endpoint: ENDPOINT.subscribe, field: 'reply.catchup.jobId', expected: 'a string when present', actual: 7, context: 'node5' });
    expect(annotated.message).toBe(`node5 ${ENDPOINT.subscribe}: reply.catchup.jobId is the number 7, expected a string when present`);
    expect(annotated.cause).toBe(original);
    expect(original.message).toBe(`${ENDPOINT.subscribe}: reply.catchup.jobId is the number 7, expected a string when present`);
    expect(annotated.withContext('flow').message.startsWith(`flow node5 ${ENDPOINT.subscribe}:`)).toBe(true);
  });

  it('carries the endpoint, the field, what was expected and what arrived', () => {
    let caught: unknown;
    try {
      parseSubscriptionsResponse({ subscriptions: [{ contextGraphId: 'a', subscribed: true, synced: 1, coreHosted: false }] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WireShapeError);
    expect(caught).toMatchObject({
      name: 'WireShapeError',
      endpoint: ENDPOINT.subscriptions,
      field: 'reply.subscriptions[0].synced',
      expected: 'a boolean',
      actual: 1,
    });
  });
});
