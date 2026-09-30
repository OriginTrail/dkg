/**
 * The suite's wire validators, proven without a devnet: each accepts a
 * real-shaped payload and rejects a renamed or retyped field with a message
 * that names the endpoint and the field.
 *
 * "Real-shaped" is as real as it can be made here. The catch-up status payloads
 * are built by the daemon's own `toCatchupStatusResponse`, and the job states
 * are read from the daemon's own `CATCHUP_JOB_STATES` (this test loads those two
 * small CLI modules at runtime; the suite itself only imports types). The
 * subscribe reply, the list reply and the subscriptions list are built inline
 * by their routes and export no builder, so those payloads are written out here
 * exactly as the routes build them (packages/cli/src/daemon/routes/
 * context-graph.ts).
 *
 * What this cannot prove: that a live daemon still emits these shapes. The devnet
 * run does that, through the same validators.
 */
import { describe, expect, it } from 'vitest';
import { CATCHUP_JOB_STATES } from '../../packages/cli/src/catchup-status.js';
import { toCatchupStatusResponse, type CatchupJob } from '../../packages/cli/src/daemon/types.js';
import {
  ENDPOINT,
  WIRE_JOB_STATES,
  type CatchupContextGraphIdentity,
  WireShapeError,
  parseCatchupStatusResponse,
  parseConnectedPeerIds,
  parseContextGraphListResponse,
  parseNodePeerInfo,
  parseQueryBindings,
  parseSubscribeResponse,
  parseSubscriptionRow,
  parseSubscriptionsResponse,
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
    ['a queued job with an identity note', queuedReply],
    ['the completed-catch-up variant, which has no job id, with an on-chain reference note', completedReply],
    ['a replayed job (a status other than queued)', with_(queuedReply, { catchup: { status: 'done', includeWorkspace: true, jobId: 'ml3x9a-done00' } })],
    ['no catch-up at all', with_(queuedReply, { catchup: undefined })],
  ])('accepts %s', (_name, payload) => {
    expect(parseSubscribeResponse(payload)).toBe(payload);
  });

  it('does not police fields the suite does not read', () => {
    expect(() => parseSubscribeResponse(with_(queuedReply, { syncMode: 12, somethingNew: { a: 1 } }))).not.toThrow();
  });

  it.each([
    ['a renamed `subscribed`', renamed(queuedReply, 'subscribed', 'subscribedTo'), 'reply.subscribed is missing, expected a string'],
    ['a retyped `subscribed`', with_(queuedReply, { subscribed: 33 }), 'reply.subscribed is the number 33, expected a string'],
    ['a `catchup` that is not an object', with_(queuedReply, { catchup: 'queued' }), 'reply.catchup is the string "queued", expected an object'],
    ['a retyped `catchup.jobId`', with_(queuedReply, { catchup: { status: 'queued', includeWorkspace: true, jobId: 7 } }), 'reply.catchup.jobId is the number 7, expected a string when present'],
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

  it('accepts rows with an on-chain id, with a chain view, and with neither', () => {
    expect(parseContextGraphListResponse(list)).toBe(list);
    expect(parseContextGraphListResponse({ contextGraphs: [] })).toEqual({ contextGraphs: [] });
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
    expect(parseSubscriptionsResponse(list)).toEqual({ subscriptions: list.subscriptions });
    expect(parseSubscriptionRow(row)).toBe(row);
    expect(parseSubscriptionRow({ ...row, identity: resolved }).identity).toEqual(resolved);
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
    'accepts what the daemon builds for a job that is %s',
    (status) => {
      const payload = toCatchupStatusResponse(job(status, status === 'unreachable' ? { error: hashOnly.message } : {}), undefined, status === 'unreachable' ? hashOnly : null);
      expect(parseCatchupStatusResponse(payload)).toBe(payload);
    },
  );

  it('accepts a job that continued under the cleartext id, with a resolved identity note', () => {
    const payload = toCatchupStatusResponse(job('done', { resolvedContextGraphId: CLEARTEXT }), undefined, resolved);
    expect(parseCatchupStatusResponse(payload)).toMatchObject({ resolvedContextGraphId: CLEARTEXT, identity: { state: 'resolved', contextGraphId: CLEARTEXT } });
  });

  it('lists exactly the job states the daemon declares', () => {
    expect([...WIRE_JOB_STATES]).toEqual([...CATCHUP_JOB_STATES]);
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

describe('parseQueryBindings', () => {
  const bindings = [{ p: '<https://schema.org/name>', o: '"kept"' }, { p: { value: 'https://schema.org/description', type: 'uri' }, o: { value: 'x', datatype: 'http://www.w3.org/2001/XMLSchema#string' } }];

  it.each([
    ['the current daemon shape (result.bindings)', { type: 'bindings', result: { bindings }, bindings: [] }],
    ['SPARQL JSON (results.bindings)', { head: { vars: ['p', 'o'] }, results: { bindings } }],
    ['the legacy flat shape (bindings)', { bindings }],
  ])('accepts %s and returns the rows', (_name, payload) => {
    expect(parseQueryBindings(payload)).toBe(bindings);
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
  ])('rejects %s', (_name, payload, message) => {
    expect(() => parseQueryBindings(payload)).toThrow(WireShapeError);
    expect(() => parseQueryBindings(payload)).toThrow(message);
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
