import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chainRpcFetch } from '../src/rpc-http1-dispatcher.js';
import {
  startConnectProxy,
  startHttp2AndHttp1JsonRpcServer,
  type JsonRpcTlsServer,
} from './helpers/local-tls.js';

/** Where undici 8 and later keep the dispatcher `fetch` uses by default. */
const FETCH_GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.2');
const RUNNING_FETCH_NEGOTIATES_HTTP2 = Number.parseInt(process.versions.undici ?? '', 10) >= 8;
if (process.env.DKG_REQUIRE_UNDICI8_FETCH === '1' && !RUNNING_FETCH_NEGOTIATES_HTTP2) {
  throw new Error('the chain-rpc-node26 lane needs a Node whose fetch is undici 8 or later, got undici ' + process.versions.undici);
}
const RPC_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });

type Dispatch = (options: Record<string, unknown>, handler: object) => boolean;
interface TestDispatcher {
  dispatch: Dispatch;
  compose(interceptor: (dispatch: Dispatch) => Dispatch): TestDispatcher;
  close(): Promise<void>;
}
type ChainRpcInit = RequestInit & { dispatcher?: TestDispatcher };

const slots = globalThis as unknown as Record<symbol, unknown>;

async function withGlobalDispatcher<T>(dispatcher: unknown, run: () => T | Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, FETCH_GLOBAL_DISPATCHER);
  if (previous) slots[FETCH_GLOBAL_DISPATCHER] = dispatcher;
  else Object.defineProperty(globalThis, FETCH_GLOBAL_DISPATCHER, { value: dispatcher, writable: true, configurable: true });
  try {
    return await run();
  } finally {
    if (previous) slots[FETCH_GLOBAL_DISPATCHER] = previous.value;
    else delete slots[FETCH_GLOBAL_DISPATCHER];
  }
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

async function withTrustedCertificate<T>(cert: string, run: () => Promise<T>): Promise<T> {
  const defaults = tls.getCACertificates('default');
  tls.setDefaultCACertificates([...defaults, cert]);
  try {
    return await run();
  } finally {
    tls.setDefaultCACertificates(defaults);
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

  it('passes init unchanged, without a warning, where the bundled undici stays on HTTP/1.1 (Node 22 and 24)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fresh = await freshChainRpcFetch();
    const inits = captureGlobalFetch();
    const init: RequestInit = { method: 'POST' };

    await withBundledUndici('6.21.1', () => fresh(RPC_URL, init));
    await withBundledUndici('7.12.0', () => fresh(RPC_URL, init));

    expect(inits).toEqual([init, init]);
    expect(inits[0]).toBe(init);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses HTTP/2 through the active global dispatcher for undici 8', async () => {
    const dispatched: Array<Record<string, unknown>> = [];
    const active = {
      compose: (interceptor: (dispatch: Dispatch) => Dispatch) => ({
        dispatch: interceptor((options) => {
          dispatched.push(options);
          return true;
        }),
      }),
    };
    const inits = captureGlobalFetch();

    await withBundledUndici('8.0.0', () => withGlobalDispatcher(active, async () => {
      await chainRpcFetch(RPC_URL, { method: 'POST', redirect: 'error' });
      await chainRpcFetch(RPC_URL, {});
    }));

    expect(inits[0]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(inits[1]!.dispatcher).toBe(inits[0]!.dispatcher);
    inits[0]!.dispatcher!.dispatch({ origin: 'https://rpc.example.invalid', path: '/' }, {});
    expect(dispatched).toEqual([{ origin: 'https://rpc.example.invalid', path: '/', allowH2: false }]);
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
    expect(warn.mock.calls[0]![0]).toContain('cannot refuse it per request');
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

  // test-disable-allow: D1 #2828 -- owner=branarakic lane=chain-rpc-node26 expires=2026-10-26 Needs undici 8 fetch; runs on Node 26 in chain-rpc-node26.yml.
  it.runIf(RUNNING_FETCH_NEGOTIATES_HTTP2)(
    'go through a dispatcher the application installed, with its own TLS trust',
    async () => {
      server.httpVersions.length = 0;
      // Loading fetch's classes installs Node's default dispatcher.
      void globalThis.Response;
      const nodeDefault = slots[FETCH_GLOBAL_DISPATCHER] as TestDispatcher;
      // An application's undici Agent that trusts the test certificate; nothing else in the process does.
      const Agent = nodeDefault.constructor as new (options: object) => TestDispatcher;
      const custom = new Agent({ connect: { ca: [server.cert] } });
      const seenAllowH2: unknown[] = [];
      const installed = custom.compose((dispatch) => (options, handler) => {
        seenAllowH2.push(options.allowH2);
        return dispatch(options, handler);
      });

      try {
        await withGlobalDispatcher(installed, () =>
          readRpc(chainRpcFetch(server.url, { method: 'POST', body: RPC_BODY })));
      } finally {
        await custom.close();
      }

      expect(seenAllowH2).toEqual([false]);
      expect(server.httpVersions.at(-1)).toBe('1.1');
    },
  );

  // test-disable-allow: D1 #2828 -- owner=branarakic lane=chain-rpc-node26 expires=2026-10-26 Needs undici 8 fetch; runs on Node 26 in chain-rpc-node26.yml.
  it.runIf(RUNNING_FETCH_NEGOTIATES_HTTP2)(
    'go through the proxy of NODE_USE_ENV_PROXY',
    async () => {
      server.httpVersions.length = 0;
      const proxy = await startConnectProxy();
      const dir = mkdtempSync(join(tmpdir(), 'chain-rpc-env-proxy-'));
      const certFile = join(dir, 'localhost.pem');
      writeFileSync(certFile, server.cert);
      const env: NodeJS.ProcessEnv = { ...process.env, NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxy.url, NODE_EXTRA_CA_CERTS: certFile };
      for (const name of ['https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) delete env[name];

      try {
        const stdout = await new Promise<string>((resolve, reject) => {
          execFile(
            process.execPath,
            [fileURLToPath(new URL('./helpers/chain-rpc-fetch-child.mjs', import.meta.url)), server.url],
            { env, timeout: 20_000 },
            (error, out, err) => (error ? reject(new Error(`${error.message}\n${err}`)) : resolve(out)),
          );
        });

        expect(JSON.parse(stdout)).toMatchObject({ status: 200, body: { result: '0x1' } });
        expect(proxy.connects).toEqual([new URL(server.url).host]);
        expect(server.httpVersions).toEqual(['1.1']);
      } finally {
        await proxy.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
