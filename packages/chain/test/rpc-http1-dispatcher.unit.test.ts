import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chainRpcFetch } from '../src/rpc-http1-dispatcher.js';
import {
  LOCALHOST_CERT,
  LOCALHOST_KEY,
  startHttp2AndHttp1JsonRpcServer,
  withTrustedCertificate,
  type JsonRpcTlsServer,
} from './helpers/local-tls.js';

/** Where undici 8 and later keep the dispatcher `fetch` uses by default. */
const FETCH_GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.2');
/** Where undici 6 and 7 (Node 22 and 24) keep it. */
const UNDICI7_FETCH_GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');
const RUNNING_FETCH_NEGOTIATES_HTTP2 = Number.parseInt(process.versions.undici ?? '', 10) >= 8;
const RUNNING_FETCH_GLOBAL_DISPATCHER = RUNNING_FETCH_NEGOTIATES_HTTP2 ? FETCH_GLOBAL_DISPATCHER : UNDICI7_FETCH_GLOBAL_DISPATCHER;
const RPC_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });

type Dispatch = (options: Record<string, unknown>, handler: object) => boolean;
interface TestDispatcher {
  dispatch: Dispatch;
  compose(...interceptors: Array<(dispatch: Dispatch) => Dispatch>): TestDispatcher;
  close(): Promise<void>;
}
type ChainRpcInit = RequestInit & { dispatcher?: TestDispatcher };

const slots = globalThis as unknown as Record<symbol, unknown>;

async function withGlobalDispatcher<T>(
  dispatcher: unknown,
  run: () => T | Promise<T>,
  key: symbol = FETCH_GLOBAL_DISPATCHER,
): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  if (previous) slots[key] = dispatcher;
  else Object.defineProperty(globalThis, key, { value: dispatcher, writable: true, configurable: true });
  try {
    return await run();
  } finally {
    if (previous) slots[key] = previous.value;
    else delete slots[key];
  }
}

/** A dispatcher whose compose() applies interceptors as undici's does; it keeps the options that reach it. */
function recordingDispatcher(dispatched: Array<Record<string, unknown>>): TestDispatcher {
  const withDispatch = (dispatch: Dispatch): TestDispatcher => ({
    dispatch,
    compose: (...interceptors) => withDispatch(interceptors.reduce((next, interceptor) => interceptor(next), dispatch)),
    close: async () => undefined,
  });
  return withDispatch((options) => {
    dispatched.push(options);
    return true;
  });
}

async function withBundledUndici<T>(version: string, run: () => T | Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(process.versions, 'undici');
  Object.defineProperty(process.versions, 'undici', { value: version, configurable: true, enumerable: true });
  try {
    return await run();
  } finally {
    if (previous) Object.defineProperty(process.versions, 'undici', previous);
    else delete (process.versions as Record<string, unknown>).undici;
  }
}


async function readRpc(response: Promise<Response>): Promise<unknown> {
  const settled = await response;
  expect(settled.status).toBe(200);
  return settled.json();
}

/** Captures the init each global fetch receives; answers every call with an empty 200. */
function captureGlobalFetch(): ChainRpcInit[] {
  const inits: ChainRpcInit[] = [];
  vi.stubGlobal('fetch', async (_input: unknown, init: ChainRpcInit) => {
    inits.push(init);
    return new Response('{}', { status: 200 });
  });
  return inits;
}

/** The module with fresh once-only warning state. */
async function freshChainRpcFetch(): Promise<typeof chainRpcFetch> {
  vi.resetModules();
  return (await import('../src/rpc-http1-dispatcher.js')).chainRpcFetch;
}

const RPC_URL = 'https://rpc.example.invalid/';

describe('chainRpcFetch (#2828)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('refuses Brotli, and leaves the protocol alone, through the active global dispatcher where the bundled undici stays on HTTP/1.1 (Node 22 and 24)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fresh = await freshChainRpcFetch();
    const inits = captureGlobalFetch();
    const dispatched: Array<Record<string, unknown>> = [];
    const active = recordingDispatcher(dispatched);

    await withGlobalDispatcher(active, async () => {
      await withBundledUndici('6.21.1', () => fresh(RPC_URL, { method: 'POST' }));
      await withBundledUndici('7.12.0', () => fresh(RPC_URL, { method: 'POST' }));
    }, UNDICI7_FETCH_GLOBAL_DISPATCHER);

    expect(inits).toHaveLength(2);
    expect(inits[0]).toMatchObject({ method: 'POST' });
    expect(inits[1]!.dispatcher).toBe(inits[0]!.dispatcher);
    inits[0]!.dispatcher!.dispatch(
      { origin: 'https://rpc.example.invalid', path: '/', headers: { 'accept-encoding': 'br, gzip' } },
      {},
    );
    expect(dispatched).toEqual([{ origin: 'https://rpc.example.invalid', path: '/', headers: { 'accept-encoding': 'gzip' } }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses Brotli and HTTP/2 through the active global dispatcher for undici 8', async () => {
    const dispatched: Array<Record<string, unknown>> = [];
    const active = recordingDispatcher(dispatched);
    const inits = captureGlobalFetch();

    await withBundledUndici('8.0.0', () => withGlobalDispatcher(active, async () => {
      await chainRpcFetch(RPC_URL, { method: 'POST', redirect: 'error' });
      await chainRpcFetch(RPC_URL, {});
    }));

    expect(inits[0]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(inits[1]!.dispatcher).toBe(inits[0]!.dispatcher);
    inits[0]!.dispatcher!.dispatch(
      { origin: 'https://rpc.example.invalid', path: '/', headers: { 'accept-encoding': 'br, gzip' } },
      {},
    );
    expect(dispatched).toEqual([
      { origin: 'https://rpc.example.invalid', path: '/', headers: { 'accept-encoding': 'gzip' }, allowH2: false },
    ]);
  });

  it('passes init unchanged, and warns once, when the undici 8 global dispatcher has no compose() or is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fresh = await freshChainRpcFetch();
    const inits = captureGlobalFetch();
    const init: RequestInit = { method: 'POST' };

    await withBundledUndici('8.0.0', async () => {
      await withGlobalDispatcher({ dispatch: () => true }, () => fresh(RPC_URL, init));
      await withGlobalDispatcher(undefined, () => fresh(RPC_URL, init));
    });

    expect(inits).toHaveLength(2);
    expect(inits.every((received) => received === init)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('may use HTTP/2 (#2828) and accept Brotli-encoded responses');
    expect(warn.mock.calls[0]![0]).toContain('cannot refuse them per request');
  });

  it('passes init unchanged, and warns once, on an undici it has not been verified with', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fresh = await freshChainRpcFetch();
    const inits = captureGlobalFetch();
    const init: RequestInit = { method: 'POST' };
    const installed = { compose: () => { throw new Error('an unverified undici must not be composed'); } };

    await withBundledUndici('9.0.0', () => withGlobalDispatcher(installed, async () => {
      await fresh(RPC_URL, init);
      await fresh(RPC_URL, init);
    }));

    expect(inits.every((received) => received === init)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('undici 9.0.0, which this release has not been verified with');
  });
});

describe('chain RPC fetches against a server that offers HTTP/2 (#2828)', () => {
  let server: JsonRpcTlsServer;

  beforeAll(async () => {
    server = await startHttp2AndHttp1JsonRpcServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('stay on HTTP/1.1 where a plain fetch negotiates HTTP/2', async () => {
    server.httpVersions.length = 0;
    await withTrustedCertificate(server.cert, async () => {
      await readRpc(fetch(server.url, { method: 'POST', body: RPC_BODY }));
      await readRpc(chainRpcFetch(server.url, { method: 'POST', body: RPC_BODY }));
      await readRpc(chainRpcFetch(server.url, { method: 'POST', body: RPC_BODY }));
    });

    // The plain fetch shows what the running Node negotiates on its own: HTTP/2 from undici 8 (Node 26).
    expect(server.httpVersions).toEqual([RUNNING_FETCH_NEGOTIATES_HTTP2 ? '2.0' : '1.1', '1.1', '1.1']);
  });
});

describe('chain RPC fetches against a server that answers with Brotli (CVE-2026-111497)', () => {
  const RESULT = { jsonrpc: '2.0', id: 1, result: '0x1' };
  const BROTLI_RESULT = zlib.brotliCompressSync(JSON.stringify(RESULT));
  let plain: http.Server;
  let plainUrl: string;
  let secure: https.Server;
  let secureUrl: string;

  /** Answers a path with `br` in it with the Brotli-encoded result, and any other path with the plain one. */
  function answer(req: http.IncomingMessage, res: http.ServerResponse): void {
    req.resume();
    if (req.url?.includes('br')) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' });
      res.end(BROTLI_RESULT);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(RESULT));
  }

  beforeAll(async () => {
    plain = http.createServer(answer);
    secure = https.createServer({ cert: LOCALHOST_CERT, key: LOCALHOST_KEY }, answer);
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => secure.listen(0, '127.0.0.1', resolve));
    plainUrl = `http://127.0.0.1:${(plain.address() as AddressInfo).port}/`;
    secureUrl = `https://localhost:${(secure.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    plain.closeAllConnections();
    secure.closeAllConnections();
    await new Promise((resolve) => plain.close(resolve));
    await new Promise((resolve) => secure.close(resolve));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function refusal(response: Promise<Response>): Promise<{ cause?: unknown }> {
    return response.then(
      (settled) => {
        throw new Error(`expected the call to fail, got ${settled.status}`);
      },
      (error: { cause?: unknown }) => error,
    );
  }

  it('refuse the answer before any Brotli decoder exists, where a plain fetch decodes it', async () => {
    const decoders = vi.spyOn(zlib, 'createBrotliDecompress');

    await expect(readRpc(fetch(`${plainUrl}br`, { method: 'POST', body: RPC_BODY }))).resolves.toEqual(RESULT);
    expect(decoders).toHaveBeenCalledTimes(1);

    const error = await refusal(chainRpcFetch(`${plainUrl}br/v3/project-key`, { method: 'POST', body: RPC_BODY }));
    expect(error.cause).toMatchObject({
      name: 'BrotliResponseRefusedError',
      host: new URL(plainUrl).host,
      message: `Refused a Brotli-encoded response from ${new URL(plainUrl).host}`,
    });
    expect(decoders).toHaveBeenCalledTimes(1);
  });

  it('refuse it through a dispatcher the application installed, with its own TLS trust', async () => {
    const decoders = vi.spyOn(zlib, 'createBrotliDecompress');
    // Loading fetch's classes installs Node's default dispatcher.
    void globalThis.Response;
    const nodeDefault = slots[RUNNING_FETCH_GLOBAL_DISPATCHER] as TestDispatcher;
    // An application's undici Agent that trusts the test certificate; nothing else in the process does.
    const Agent = nodeDefault.constructor as new (options: object) => TestDispatcher;
    const custom = new Agent({ connect: { ca: [LOCALHOST_CERT] } });

    try {
      await withGlobalDispatcher(custom, async () => {
        await expect(readRpc(chainRpcFetch(secureUrl, { method: 'POST', body: RPC_BODY }))).resolves.toEqual(RESULT);
        const error = await refusal(chainRpcFetch(`${secureUrl}br`, { method: 'POST', body: RPC_BODY }));
        expect(error.cause).toMatchObject({ name: 'BrotliResponseRefusedError', host: new URL(secureUrl).host });
      }, RUNNING_FETCH_GLOBAL_DISPATCHER);
    } finally {
      await custom.close();
    }
    expect(decoders).not.toHaveBeenCalled();
  });
});
