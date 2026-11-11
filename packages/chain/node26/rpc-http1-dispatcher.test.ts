import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chainRpcFetch } from '../src/rpc-http1-dispatcher.js';
import {
  startConnectProxy,
  startHttp2AndHttp1JsonRpcServer,
  withTrustedCertificate,
  type JsonRpcTlsServer,
} from '../test/helpers/local-tls.js';

// This suite is an obligatory real Node 26 transport check, not a generic
// unit suite with runtime-dependent skips. Reject a misrouted invocation.
if (!process.versions.node.startsWith('26.') || !process.versions.undici?.startsWith('8.')
  || process.env.DKG_REQUIRE_UNDICI8_FETCH !== '1') {
  throw new Error('Node 26 transport suite requires Node 26 / undici 8 and DKG_REQUIRE_UNDICI8_FETCH=1');
}

const FETCH_GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.2');
const RPC_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
type Dispatch = (options: Record<string, unknown>, handler: object) => boolean;
interface TestDispatcher {
  dispatch: Dispatch;
  compose(...interceptors: Array<(dispatch: Dispatch) => Dispatch>): TestDispatcher;
  close(): Promise<void>;
}
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

/** Environment variables that would route a child's requests through a proxy. */
const PROXY_ENV = ['NODE_USE_ENV_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];

/**
 * Runs one chain RPC call to `url` as the first request of a fresh Node
 * process that trusts the test certificate, with `env` added and no other
 * proxy settings, and returns what the child reports.
 */
async function runChainRpcChild(url: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of PROXY_ENV) delete childEnv[name];
  Object.assign(childEnv, env, {
    NODE_EXTRA_CA_CERTS: fileURLToPath(new URL('../test/fixtures/localhost-tls/localhost-cert.pem', import.meta.url)),
  });
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [fileURLToPath(new URL('../test/helpers/chain-rpc-fetch-child.mjs', import.meta.url)), url],
      { env: childEnv, timeout: 20_000 },
      (error, out, err) => (error ? reject(new Error(error.message + '\n' + err)) : resolve(out)),
    );
  });
  return JSON.parse(stdout);
}

async function readRpc(response: Promise<Response>): Promise<unknown> {
  const settled = await response;
  expect(settled.status).toBe(200);
  return settled.json();
}

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

    // Prove this runtime really negotiates HTTP/2 before the RPC guard forces HTTP/1.1.
    expect(server.httpVersions).toEqual(['2.0', '1.1', '1.1']);
  });

  it(
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

  it(
    'go through the proxy of NODE_USE_ENV_PROXY',
    async () => {
      server.httpVersions.length = 0;
      const proxy = await startConnectProxy();

      try {
        const result = await runChainRpcChild(server.url, { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxy.url });

        expect(result).toMatchObject({ status: 200, body: { result: '0x1' } });
        expect(proxy.connects).toEqual([new URL(server.url).host]);
        expect(server.httpVersions).toEqual(['1.1']);
      } finally {
        await proxy.close();
      }
    },
  );

  it(
    'stay on HTTP/1.1 when a chain RPC call is the first request of a fresh process',
    async () => {
      server.httpVersions.length = 0;

      // No proxy, and nothing in the child touches fetch or its classes before chainRpcFetch.
      const result = await runChainRpcChild(server.url, {});

      expect(result).toMatchObject({ status: 200, body: { result: '0x1' } });
      expect(server.httpVersions).toEqual(['1.1']);
    },
  );
});
