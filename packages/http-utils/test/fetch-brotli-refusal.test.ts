import { execFile } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BrotliResponseRefusedError,
  fetchGlobalDispatcher,
  installGlobalBrotliRefusal,
  isBrotliRefusing,
  isComposableDispatcher,
  refuseBrotliResponses,
  withBrotliRefusal,
  type ComposableDispatcher,
  type DispatchFunction,
} from '../src/index.js';

const PLAIN = 'a body every test reads back';
const RESPONSES: Record<string, { contentEncoding: Buffer; body: Buffer }> = {
  '/br': { contentEncoding: Buffer.from('Content-Encoding: br\r\n'), body: zlib.brotliCompressSync(PLAIN) },
  '/upper-case': { contentEncoding: Buffer.from('Content-Encoding: BR\r\n'), body: zlib.brotliCompressSync(PLAIN) },
  '/listed': { contentEncoding: Buffer.from('Content-Encoding: gzip, br\r\n'), body: zlib.brotliCompressSync(PLAIN) },
  '/spaced': { contentEncoding: Buffer.from('Content-Encoding: \tbr \r\n'), body: zlib.brotliCompressSync(PLAIN) },
  '/extra-byte': {
    contentEncoding: Buffer.concat([Buffer.from('Content-Encoding: br'), Buffer.from([0xa0]), Buffer.from('\r\n')]),
    body: zlib.brotliCompressSync(PLAIN),
  },
  '/two-lines': {
    contentEncoding: Buffer.from('Content-Encoding: identity\r\ncontent-encoding: br\r\n'),
    body: zlib.brotliCompressSync(PLAIN),
  },
  '/gzip': { contentEncoding: Buffer.from('Content-Encoding: gzip\r\n'), body: zlib.gzipSync(PLAIN) },
  '/plain': { contentEncoding: Buffer.alloc(0), body: Buffer.from(PLAIN) },
};
const BROTLI_PATHS = ['/br', '/upper-case', '/listed', '/spaced', '/extra-byte', '/two-lines'];

interface RawServer {
  readonly url: string;
  readonly host: string;
  /** The Accept-Encoding of each request, in arrival order. */
  readonly acceptEncodings: Array<string | undefined>;
  close(): Promise<void>;
}

/** Answers each path with the bytes in RESPONSES, written as they are. */
async function startRawServer(): Promise<RawServer> {
  const acceptEncodings: Array<string | undefined> = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let head = '';
    socket.on('data', (chunk: Buffer) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;
      const [requestLine, ...lines] = head.slice(0, end).split('\r\n');
      const path = new URL(requestLine!.split(' ')[1]!, 'http://raw.invalid').pathname;
      const acceptEncoding = lines.find((line) => /^accept-encoding:/i.test(line));
      acceptEncodings.push(acceptEncoding?.slice('accept-encoding:'.length).trim());
      const response = RESPONSES[path] ?? RESPONSES['/plain']!;
      socket.end(Buffer.concat([
        Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n'),
        response.contentEncoding,
        Buffer.from(`Content-Length: ${response.body.length}\r\n\r\n`),
        response.body,
      ]));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    acceptEncodings,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}

interface Proxy {
  readonly url: string;
  /** `CONNECT host:port` tunnels and absolute-form requests, in arrival order. */
  readonly requests: string[];
  close(): Promise<void>;
}

/** An HTTP proxy that tunnels CONNECT and forwards absolute-form requests, as undici's proxy agents use one. */
async function startProxy(): Promise<Proxy> {
  const requests: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? '');
    const upstream = http.request(request.url ?? '', { method: request.method, headers: request.headers }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
      answer.pipe(response);
    });
    upstream.on('error', () => response.destroy());
    request.pipe(upstream);
  });
  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (request: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    requests.push(`CONNECT ${request.url}`);
    const [host, port] = (request.url ?? '').split(':');
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}

/** Environment variables that would route a child's requests through a proxy. */
const PROXY_ENV = ['NODE_USE_ENV_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];

interface ChildReport {
  install: unknown;
  results: Array<{ status?: number; body?: string; error?: string }>;
  decoders: number;
}

/** Fetches `urls` in a fresh Node process that installs the global refusal first, with `env` and no other proxy settings. */
async function runChild(urls: string[], env: NodeJS.ProcessEnv = {}): Promise<ChildReport> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of PROXY_ENV) delete childEnv[name];
  Object.assign(childEnv, env);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [fileURLToPath(new URL('./helpers/brotli-refusal-child.mjs', import.meta.url)), ...urls],
      { env: childEnv, timeout: 20_000 },
      (error, out, err) => (error ? reject(new Error(`${error.message}\n${err}`)) : resolve(out)),
    );
  });
  return JSON.parse(stdout) as ChildReport;
}

type RecordedHandler = Record<string, (...args: unknown[]) => unknown>;

/** A dispatch function that keeps what it is given, as the end of an interceptor chain. */
function captureDispatch(): { dispatch: DispatchFunction; dispatched: Array<{ options: unknown; handler: RecordedHandler }> } {
  const dispatched: Array<{ options: unknown; handler: RecordedHandler }> = [];
  return {
    dispatched,
    dispatch: (options, handler) => {
      dispatched.push({ options, handler: handler as RecordedHandler });
      return true;
    },
  };
}

interface FakeDispatcher extends ComposableDispatcher {
  dispatch: DispatchFunction;
}

/** A dispatcher whose compose() applies interceptors as undici's does. */
function fakeDispatcher(dispatch: DispatchFunction): FakeDispatcher {
  return {
    dispatch,
    compose: (...interceptors) => fakeDispatcher(interceptors.reduce((next, interceptor) => interceptor(next), dispatch)),
  };
}

/** A handler whose every callback records its name and arguments and returns its name. */
function recordingHandler(names: string[]): { handler: RecordedHandler; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const handler: RecordedHandler = {};
  for (const name of names) {
    handler[name] = (...args: unknown[]) => {
      calls.push([name, ...args]);
      return name;
    };
  }
  return { handler, calls };
}

const LEGACY_CALLBACKS = [
  'onConnect', 'onHeaders', 'onUpgrade', 'onData', 'onComplete', 'onError', 'onBodySent', 'onRequestSent', 'onResponseStarted',
];
const MODERN_CALLBACKS = [
  'onRequestStart', 'onRequestUpgrade', 'onResponseStart', 'onResponseData', 'onResponseEnd', 'onResponseError',
  'onBodySent', 'onRequestSent', 'onResponseStarted',
];

const slots = globalThis as unknown as Record<symbol, unknown>;
const GLOBAL_DISPATCHER_KEYS = [Symbol.for('undici.globalDispatcher.1'), Symbol.for('undici.globalDispatcher.2')];

async function withBundledUndici<T>(version: string | undefined, run: () => T | Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(process.versions, 'undici');
  Object.defineProperty(process.versions, 'undici', { value: version, configurable: true, enumerable: true });
  try {
    return await run();
  } finally {
    if (previous) Object.defineProperty(process.versions, 'undici', previous);
    else delete (process.versions as Record<string, unknown>).undici;
  }
}

/** The dispatcher in fetch's global slot on the running Node. */
function fetchSlotKey(): symbol {
  return Number.parseInt(process.versions.undici ?? '', 10) >= 8 ? GLOBAL_DISPATCHER_KEYS[1]! : GLOBAL_DISPATCHER_KEYS[0]!;
}

async function failure(request: Promise<Response>): Promise<Error & { cause?: unknown }> {
  return request.then(
    (response) => {
      throw new Error(`expected the request to fail, got ${response.status}`);
    },
    (error: Error & { cause?: unknown }) => error,
  );
}

describe('refuseBrotliResponses with the running Node fetch', () => {
  let server: RawServer;
  let refusing: object;
  let brotliDecoders: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    server = await startRawServer();
    const active = fetchGlobalDispatcher();
    if (!('dispatcher' in active) || !isComposableDispatcher(active.dispatcher)) {
      throw new Error(`Node ${process.versions.node} has no composable fetch dispatcher`);
    }
    refusing = withBrotliRefusal(active.dispatcher);
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    brotliDecoders = vi.spyOn(zlib, 'createBrotliDecompress');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a plain fetch decodes the Brotli answer (the control)', async () => {
    const response = await fetch(`${server.url}/br`);

    expect(await response.text()).toBe(PLAIN);
    expect(brotliDecoders).toHaveBeenCalledTimes(1);
  });

  it.each(BROTLI_PATHS)('fails %s at its headers, before any Brotli decoder exists', async (path) => {
    const error = await failure(fetch(`${server.url}${path}?apiKey=hidden`, { dispatcher: refusing } as RequestInit));

    expect(error).toBeInstanceOf(TypeError);
    expect(error.cause).toBeInstanceOf(BrotliResponseRefusedError);
    expect(error.cause).toMatchObject({
      name: 'BrotliResponseRefusedError',
      code: 'DKG_BROTLI_RESPONSE_REFUSED',
      host: server.host,
      message: `Refused a Brotli-encoded response from ${server.host}`,
    });
    expect(brotliDecoders).not.toHaveBeenCalled();
  });

  it('passes gzip-encoded and unencoded answers through', async () => {
    for (const path of ['/gzip', '/plain']) {
      const response = await fetch(`${server.url}${path}`, { dispatcher: refusing } as RequestInit);
      expect(await response.text()).toBe(PLAIN);
    }
    expect(brotliDecoders).not.toHaveBeenCalled();
  });

  it('takes br out of the Accept-Encoding a request sends', async () => {
    server.acceptEncodings.length = 0;
    for (const acceptEncoding of ['br, gzip;q=0.8', 'BR', '*', 'gzip, deflate']) {
      const response = await fetch(`${server.url}/plain`, {
        dispatcher: refusing,
        headers: { 'Accept-Encoding': acceptEncoding },
      } as RequestInit);
      await response.text();
    }

    expect(server.acceptEncodings).toEqual(['gzip;q=0.8', 'identity', '*, br;q=0', 'gzip, deflate']);
  });
});

describe('refuseBrotliResponses with an onConnect / onHeaders handler (undici 6)', () => {
  it('aborts at the headers of a Brotli answer and forwards every other callback', () => {
    const { dispatch, dispatched } = captureDispatch();
    const { handler: downstream, calls } = recordingHandler(LEGACY_CALLBACKS);
    refuseBrotliResponses(dispatch)({ origin: 'https://rpc.example.invalid:8545', path: '/v1/key' }, downstream);
    const handler = dispatched[0]!.handler;
    const abort = vi.fn();
    const resume = () => undefined;
    const plainHeaders = [Buffer.from('Content-Type'), Buffer.from('text/plain')];

    expect(handler.onConnect!(abort, 'context')).toBe('onConnect');
    expect(handler.onHeaders!(200, plainHeaders, resume, 'OK')).toBe('onHeaders');
    expect(handler.onUpgrade!(101, plainHeaders, 'socket')).toBe('onUpgrade');
    expect(handler.onData!('chunk')).toBe('onData');
    expect(handler.onComplete!([])).toBe('onComplete');
    expect(handler.onBodySent!('sent')).toBe('onBodySent');
    expect(handler.onRequestSent!()).toBe('onRequestSent');
    expect(handler.onResponseStarted!()).toBe('onResponseStarted');
    const failed = new Error('socket closed');
    expect(handler.onError!(failed)).toBe('onError');
    expect(calls.map(([name]) => name)).toEqual(LEGACY_CALLBACKS.filter((name) => name !== 'onError').concat('onError'));
    expect(calls[0]).toEqual(['onConnect', abort, 'context']);
    expect(calls.at(-1)).toEqual(['onError', failed]);

    calls.length = 0;
    const brotliHeaders = [Buffer.from('Content-Type'), Buffer.from('text/plain'), Buffer.from('Content-Encoding'), [Buffer.from('gzip'), Buffer.from('br')]];
    expect(handler.onHeaders!(200, brotliHeaders, resume, 'OK')).toBe(false);
    expect(calls).toEqual([]);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort.mock.calls[0]![0]).toBeInstanceOf(BrotliResponseRefusedError);
    expect(abort.mock.calls[0]![0]).toMatchObject({ host: 'rpc.example.invalid:8545' });
  });

  it('throws the refusal from onHeaders when no onConnect ran, which undici turns into an abort', () => {
    const { dispatch, dispatched } = captureDispatch();
    refuseBrotliResponses(dispatch)({ origin: new URL('https://node.example.invalid/') }, {});

    expect(() => dispatched[0]!.handler.onHeaders!(200, ['content-encoding', 'br'], () => undefined, 'OK'))
      .toThrow(new BrotliResponseRefusedError('node.example.invalid'));
  });

  it('rethrows an error to undici when the handler has no onError, and forwards nothing it lacks', () => {
    const { dispatch, dispatched } = captureDispatch();
    refuseBrotliResponses(dispatch)({ origin: 'not a url' }, {});
    const handler = dispatched[0]!.handler;
    const failed = new Error('no handler');

    expect(() => handler.onError!(failed)).toThrow(failed);
    expect(handler.onConnect!(() => undefined)).toBeUndefined();
    expect(handler.onHeaders!(200, [], () => undefined, 'OK')).toBeUndefined();
    expect(handler.onData!('chunk')).toBeUndefined();
    expect(handler.onComplete!([])).toBeUndefined();
    expect(handler.onUpgrade!(101, [], 'socket')).toBeUndefined();
    expect(handler.onBodySent!('sent')).toBeUndefined();
    expect(handler.onRequestSent!()).toBeUndefined();
    expect(handler.onResponseStarted!()).toBeUndefined();
  });
});

describe('refuseBrotliResponses with an onRequestStart / onResponseStart handler (undici 7 and 8)', () => {
  it('aborts at the headers of a Brotli answer and forwards every other callback', () => {
    const { dispatch, dispatched } = captureDispatch();
    const { handler: downstream, calls } = recordingHandler(MODERN_CALLBACKS);
    refuseBrotliResponses(dispatch)({ origin: 'http://127.0.0.1:9545', path: '/' }, downstream);
    const handler = dispatched[0]!.handler;
    const controller = { abort: vi.fn() };
    const failed = new Error('socket closed');

    expect(handler.onRequestStart!(controller, 'context')).toBe('onRequestStart');
    expect(handler.onResponseStart!(controller, 200, { 'content-encoding': 'gzip' }, 'OK')).toBe('onResponseStart');
    expect(handler.onRequestUpgrade!(controller, 101, {}, 'socket')).toBe('onRequestUpgrade');
    expect(handler.onResponseData!(controller, 'chunk')).toBe('onResponseData');
    expect(handler.onResponseEnd!(controller, {})).toBe('onResponseEnd');
    expect(handler.onResponseError!(controller, failed)).toBe('onResponseError');
    expect(handler.onBodySent!('sent')).toBe('onBodySent');
    expect(handler.onRequestSent!()).toBe('onRequestSent');
    expect(handler.onResponseStarted!()).toBe('onResponseStarted');
    expect(calls.map(([name]) => name)).toEqual([
      'onRequestStart', 'onResponseStart', 'onRequestUpgrade', 'onResponseData', 'onResponseEnd', 'onResponseError',
      'onBodySent', 'onRequestSent', 'onResponseStarted',
    ]);

    calls.length = 0;
    expect(handler.onResponseStart!(controller, 200, { 'content-encoding': ['identity', ' BR'] }, 'OK')).toBeUndefined();
    expect(calls).toEqual([]);
    expect(controller.abort).toHaveBeenCalledTimes(1);
    expect(controller.abort.mock.calls[0]![0]).toMatchObject({ host: '127.0.0.1:9545' });
  });

  it("also reads the raw header bytes undici 8 keeps on the controller, which its fetch decodes from", () => {
    const { dispatch, dispatched } = captureDispatch();
    const { handler: downstream, calls } = recordingHandler(MODERN_CALLBACKS);
    refuseBrotliResponses(dispatch)({ origin: 'https://rpc.example.invalid' }, downstream);
    const controller = {
      abort: vi.fn(),
      rawHeaders: [Buffer.from('content-encoding'), new Uint8Array(Buffer.from('br'))],
    };

    dispatched[0]!.handler.onResponseStart!(controller, 200, { 'content-encoding': 42 }, 'OK');

    expect(calls).toEqual([]);
    expect(controller.abort).toHaveBeenCalledWith(new BrotliResponseRefusedError('rpc.example.invalid'));
  });

  it('throws the refusal when undici passes no controller, and rethrows errors it cannot forward', () => {
    const { dispatch, dispatched } = captureDispatch();
    refuseBrotliResponses(dispatch)({ origin: 'https://rpc.example.invalid' }, { onRequestStart: () => undefined });
    const handler = dispatched[0]!.handler;
    const failed = new Error('no handler');

    expect(() => handler.onResponseStart!(undefined, 200, { 'content-encoding': 'br' }, 'OK'))
      .toThrow(BrotliResponseRefusedError);
    expect(() => handler.onResponseError!(null, failed)).toThrow(failed);
    expect(handler.onResponseStart!({ abort: vi.fn() }, 200, null, 'OK')).toBeUndefined();
    expect(handler.onRequestUpgrade!({}, 101, {}, 'socket')).toBeUndefined();
    expect(handler.onResponseData!({}, 'chunk')).toBeUndefined();
    expect(handler.onResponseEnd!({}, {})).toBeUndefined();
    expect(handler.onBodySent!('sent')).toBeUndefined();
    expect(handler.onRequestSent!()).toBeUndefined();
    expect(handler.onResponseStarted!()).toBeUndefined();
  });
});

describe('refuseBrotliResponses request headers', () => {
  function dispatchedOptions(options: unknown): unknown {
    const { dispatch, dispatched } = captureDispatch();
    refuseBrotliResponses(dispatch)(options as Record<string, unknown>, {});
    return dispatched[0]!.options;
  }

  it.each([
    [{ 'accept-encoding': 'br, gzip, deflate' }, { 'accept-encoding': 'gzip, deflate' }],
    [{ 'Accept-Encoding': ' BR ;q=1.0' }, { 'Accept-Encoding': 'identity' }],
    [{ 'accept-encoding': '*;q=0.5' }, { 'accept-encoding': '*;q=0.5, br;q=0' }],
    [{ 'accept-encoding': ['br', 'gzip'], 'x-trace': 'br' }, { 'accept-encoding': ['identity', 'gzip'], 'x-trace': 'br' }],
    [['accept-encoding', 'zstd, br', 'x-trace', 'br'], ['accept-encoding', 'zstd', 'x-trace', 'br']],
  ])('rewrites %j to %j in a copy', (headers, expected) => {
    const options = { origin: 'https://rpc.example.invalid', headers };
    const sent = dispatchedOptions(options);

    expect(sent).toEqual({ origin: 'https://rpc.example.invalid', headers: expected });
    expect(sent).not.toBe(options);
    expect(options.headers).not.toEqual(expected);
  });

  it.each([
    ['without br', { 'accept-encoding': 'gzip, deflate' }],
    ['as a list without br', { 'accept-encoding': ['gzip'] }],
    ['with a value that is not text', { 'accept-encoding': 7 }],
    ['as a list that is not all text', { 'accept-encoding': ['br', 7] }],
    ['without Accept-Encoding', ['x-trace', 'br']],
    ['as an odd array', ['accept-encoding']],
    ['as another iterable', new Map([['accept-encoding', 'br']])],
    ['absent', undefined],
  ])('sends headers %s as they are', (_label, headers) => {
    const options = { origin: 'https://rpc.example.invalid', headers };

    expect(dispatchedOptions(options)).toBe(options);
  });

  it('hands options or a handler that are not objects to the dispatcher as they are', () => {
    const { dispatch, dispatched } = captureDispatch();
    const refusing = refuseBrotliResponses(dispatch);
    const handler = {};

    refusing(null as unknown as Record<string, unknown>, handler);
    refusing({ origin: 'https://rpc.example.invalid' }, null as unknown as object);

    expect(dispatched[0]).toEqual({ options: null, handler });
    expect(dispatched[0]!.handler).toBe(handler);
    expect(dispatched[1]).toEqual({ options: { origin: 'https://rpc.example.invalid' }, handler: null });
  });
});

describe('withBrotliRefusal', () => {
  it('composes a dispatcher once and keeps one that already refuses Brotli', () => {
    const dispatched: unknown[] = [];
    const base = fakeDispatcher((options) => {
      dispatched.push(options);
      return true;
    });

    const refusing = withBrotliRefusal(base);
    (refusing as FakeDispatcher).dispatch({ origin: 'https://x.invalid', headers: { 'accept-encoding': 'br, gzip' } }, {});

    expect(withBrotliRefusal(base)).toBe(refusing);
    expect(withBrotliRefusal(refusing)).toBe(refusing);
    expect(isBrotliRefusing(refusing)).toBe(true);
    expect(isBrotliRefusing(base)).toBe(false);
    expect(isBrotliRefusing(undefined)).toBe(false);
    expect(dispatched).toEqual([{ origin: 'https://x.invalid', headers: { 'accept-encoding': 'gzip' } }]);
  });

  it('knows a composable dispatcher', () => {
    expect(isComposableDispatcher(fakeDispatcher(() => true))).toBe(true);
    expect(isComposableDispatcher({ dispatch: () => true })).toBe(false);
    expect(isComposableDispatcher(null)).toBe(false);
  });
});

describe('fetchGlobalDispatcher', () => {
  it('names an undici it has not been verified with', async () => {
    expect(fetchGlobalDispatcher('9.0.1')).toEqual({ unverified: '9.0.1' });
    await withBundledUndici(undefined, () => {
      expect(fetchGlobalDispatcher()).toEqual({ unverified: '(unknown)' });
    });
  });

  it('returns the dispatcher in the global slot of each verified undici', () => {
    for (const [version, key] of [['6.21.0', GLOBAL_DISPATCHER_KEYS[0]], ['7.12.0', GLOBAL_DISPATCHER_KEYS[0]], ['8.9.0', GLOBAL_DISPATCHER_KEYS[1]]] as const) {
      const found = fetchGlobalDispatcher(version);
      expect(found).toEqual({ undiciMajor: Number.parseInt(version, 10), dispatcher: slots[key!] });
    }
    const running = fetchGlobalDispatcher();
    expect(isComposableDispatcher((running as { dispatcher: unknown }).dispatcher)).toBe(true);
  });
});

describe('installGlobalBrotliRefusal', () => {
  let server: RawServer;
  let saved: Map<symbol, PropertyDescriptor | undefined>;

  beforeAll(async () => {
    server = await startRawServer();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    void globalThis.Response;
    saved = new Map(GLOBAL_DISPATCHER_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, descriptor] of saved) {
      if (descriptor) slots[key] = descriptor.value;
      else delete slots[key];
    }
  });

  it('makes a fetch with no dispatcher of its own refuse Brotli, once', async () => {
    const brotliDecoders = vi.spyOn(zlib, 'createBrotliDecompress');
    const wrapped = slots[fetchSlotKey()];

    expect(installGlobalBrotliRefusal()).toEqual({ installed: true });
    const installed = slots[fetchSlotKey()];
    expect(installed).not.toBe(wrapped);
    expect(isBrotliRefusing(installed)).toBe(true);
    expect(installGlobalBrotliRefusal()).toEqual({ installed: true });
    expect(slots[fetchSlotKey()]).toBe(installed);

    const error = await failure(fetch(`${server.url}/br`));
    expect(error.cause).toBeInstanceOf(BrotliResponseRefusedError);
    expect(await (await fetch(`${server.url}/gzip`)).text()).toBe(PLAIN);
    expect(brotliDecoders).not.toHaveBeenCalled();
  });

  it('wraps the dispatcher in each global slot, keeping it as the one that sends', () => {
    const sent: unknown[][] = [];
    for (const [index, key] of GLOBAL_DISPATCHER_KEYS.entries()) {
      slots[key] = fakeDispatcher((options) => {
        sent.push([index, options]);
        return true;
      });
    }

    expect(installGlobalBrotliRefusal()).toEqual({ installed: true });
    for (const key of GLOBAL_DISPATCHER_KEYS) {
      expect(isBrotliRefusing(slots[key])).toBe(true);
      (slots[key] as FakeDispatcher).dispatch({ origin: 'https://a.invalid', headers: { 'accept-encoding': 'br' } }, {});
    }
    expect(sent).toEqual([
      [0, { origin: 'https://a.invalid', headers: { 'accept-encoding': 'identity' } }],
      [1, { origin: 'https://a.invalid', headers: { 'accept-encoding': 'identity' } }],
    ]);
  });

  it('changes nothing where fetch is an unverified undici or its dispatcher cannot be composed', async () => {
    const before = GLOBAL_DISPATCHER_KEYS.map((key) => slots[key]);

    await withBundledUndici('9.2.0', () => {
      expect(installGlobalBrotliRefusal()).toEqual({
        installed: false,
        reason: "Node's fetch is undici 9.2.0, which this release has not been verified with",
      });
    });
    expect(GLOBAL_DISPATCHER_KEYS.map((key) => slots[key])).toEqual(before);

    const opaque = { dispatch: () => true };
    slots[fetchSlotKey()] = opaque;
    expect(installGlobalBrotliRefusal()).toEqual({
      installed: false,
      reason: 'the global fetch dispatcher cannot be composed with an interceptor',
    });
    expect(slots[fetchSlotKey()]).toBe(opaque);
  });
});

describe('installGlobalBrotliRefusal as the first thing a fresh process does', () => {
  let server: RawServer;

  beforeAll(async () => {
    server = await startRawServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('refuses Brotli on the first fetch, and passes other answers', async () => {
    const report = await runChild([`${server.url}/br`, `${server.url}/gzip`]);

    expect(report).toEqual({
      install: { installed: true },
      results: [{ error: 'BrotliResponseRefusedError' }, { status: 200, body: PLAIN }],
      decoders: 0,
    });
  });

  it('keeps the proxy of NODE_USE_ENV_PROXY', async () => {
    const proxy = await startProxy();
    try {
      const report = await runChild([`${server.url}/br`, `${server.url}/plain`], {
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: proxy.url,
      });

      expect(report).toEqual({
        install: { installed: true },
        results: [{ error: 'BrotliResponseRefusedError' }, { status: 200, body: PLAIN }],
        decoders: 0,
      });
      // undici 6 and 7 tunnel every origin; undici 8 sends plain-HTTP requests in absolute form.
      expect(proxy.requests.length).toBeGreaterThanOrEqual(1);
      expect(proxy.requests.every((request) => request.includes(server.host))).toBe(true);
    } finally {
      await proxy.close();
    }
  });
});
