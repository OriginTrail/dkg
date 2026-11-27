import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { BrotliResponseRefusedError, isBrotliRefusing, refuseBrotliResponses } from '@origintrail-official/dkg-http-utils';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { localAgentChannelFetchInit } from '../src/daemon/local-agent-channel-fetch.js';
import { refuseBrotliOnDaemonFetch } from '../src/daemon/outbound-brotli-refusal.js';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';

const mocks = vi.hoisted(() => ({ refuseBrotliOnDaemonFetch: vi.fn() }));

// The daemon start test stops the boot at this step; every other test runs the real one.
vi.mock('../src/daemon/outbound-brotli-refusal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/daemon/outbound-brotli-refusal.js')>();
  mocks.refuseBrotliOnDaemonFetch.mockImplementation(actual.refuseBrotliOnDaemonFetch);
  return { refuseBrotliOnDaemonFetch: mocks.refuseBrotliOnDaemonFetch };
});

const PLAIN = 'a body every test reads back';
const BROTLI_BODY = zlib.brotliCompressSync(PLAIN);
const slots = globalThis as unknown as Record<symbol, unknown>;
const GLOBAL_DISPATCHER_KEYS = [Symbol.for('undici.globalDispatcher.1'), Symbol.for('undici.globalDispatcher.2')];
/** The global slot whose dispatcher the running Node's fetch uses. */
const FETCH_SLOT = Number.parseInt(process.versions.undici ?? '', 10) >= 8 ? GLOBAL_DISPATCHER_KEYS[1]! : GLOBAL_DISPATCHER_KEYS[0]!;

let server: http.Server;
let baseUrl: string;
let host: string;

beforeAll(async () => {
  // `/br` answers with a Brotli-encoded body; every other path with a plain one.
  server = http.createServer((req, res) => {
    if (req.url === '/br') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'br' });
      res.end(BROTLI_BODY);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(PLAIN);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  baseUrl = `http://${host}`;
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function failure(request: Promise<unknown>): Promise<{ cause?: unknown }> {
  return request.then(
    () => {
      throw new Error('expected the request to fail');
    },
    (error: { cause?: unknown }) => error,
  );
}

describe('refuseBrotliOnDaemonFetch', () => {
  let saved: Map<symbol, PropertyDescriptor | undefined>;

  beforeEach(() => {
    void globalThis.Response;
    saved = new Map(GLOBAL_DISPATCHER_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  });

  afterEach(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) slots[key] = descriptor.value;
      else delete slots[key];
    }
  });

  it('says so in the daemon log, and a fetch with no dispatcher of its own then refuses Brotli', async () => {
    const lines: string[] = [];
    refuseBrotliOnDaemonFetch((line) => lines.push(line));
    const decoders = vi.spyOn(zlib, 'createBrotliDecompress');

    expect(lines).toEqual(['Outbound HTTP refuses Brotli-encoded responses (CVE-2026-111497 hardening)']);
    expect(isBrotliRefusing(slots[FETCH_SLOT])).toBe(true);
    const error = await failure(fetch(`${baseUrl}/br`));
    expect(error.cause).toBeInstanceOf(BrotliResponseRefusedError);
    expect(error.cause).toMatchObject({ host });
    expect(await (await fetch(`${baseUrl}/plain`)).text()).toBe(PLAIN);
    expect(decoders).not.toHaveBeenCalled();
  });

  it('warns in the daemon log when the global fetch dispatcher cannot refuse it', () => {
    const opaque = { dispatch: () => true };
    slots[FETCH_SLOT] = opaque;
    const lines: string[] = [];

    refuseBrotliOnDaemonFetch((line) => lines.push(line));

    expect(lines).toEqual([
      'WARNING: outbound HTTP may accept Brotli-encoded responses: '
        + 'the global fetch dispatcher cannot be composed with an interceptor',
    ]);
    expect(slots[FETCH_SLOT]).toBe(opaque);
  });
});

describe("undici's own fetch", () => {
  it('decodes a Brotli answer through a plain Agent, and refuses it through one composed with refuseBrotliResponses', async () => {
    const decoders = vi.spyOn(zlib, 'createBrotliDecompress');
    const plainAgent = new Agent();
    const refusingAgent = new Agent().compose(refuseBrotliResponses as unknown as Dispatcher.DispatcherComposeInterceptor);

    try {
      const decoded = await undiciFetch(`${baseUrl}/br`, { dispatcher: plainAgent });
      expect(await decoded.text()).toBe(PLAIN);
      expect(decoders).toHaveBeenCalledTimes(1);

      const error = await failure(undiciFetch(`${baseUrl}/br`, { dispatcher: refusingAgent }));
      expect(error.cause).toBeInstanceOf(BrotliResponseRefusedError);
      expect(error.cause).toMatchObject({ host });
      expect(decoders).toHaveBeenCalledTimes(1);
    } finally {
      await plainAgent.close();
      await refusingAgent.close();
    }
  });
});

describe('local-agent channel forwards', () => {
  it('refuse a Brotli answer through their own dispatcher, and pass a plain one', async () => {
    const decoders = vi.spyOn(zlib, 'createBrotliDecompress');

    const error = await failure(fetch(`${baseUrl}/br`, localAgentChannelFetchInit(5_000)));
    expect(error.cause).toBeInstanceOf(BrotliResponseRefusedError);
    const response = await fetch(`${baseUrl}/plain`, localAgentChannelFetchInit(5_000));
    expect(await response.text()).toBe(PLAIN);
    expect(decoders).not.toHaveBeenCalled();
  });
});

describe('daemon start', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dkg-brotli-refusal-boot-'));
    previousHome = process.env.DKG_HOME;
    process.env.DKG_HOME = home;
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  it('makes outbound HTTP refuse Brotli right after the Node runtime check', async () => {
    const stopped = new Error('the boot stops at the Brotli refusal');
    mocks.refuseBrotliOnDaemonFetch.mockClear();
    mocks.refuseBrotliOnDaemonFetch.mockImplementationOnce(() => {
      throw stopped;
    });
    const { runDaemonInner } = await import('../src/daemon/lifecycle.js');

    await expect(runDaemonInner(
      true,
      { name: 'brotli-refusal-boot', listenPort: 0 } as Parameters<typeof runDaemonInner>[1],
      Date.now(),
      resolveShutdownPolicy(undefined),
    )).rejects.toBe(stopped);
    expect(mocks.refuseBrotliOnDaemonFetch).toHaveBeenCalledTimes(1);
    expect(mocks.refuseBrotliOnDaemonFetch.mock.calls[0]![0]).toEqual(expect.any(Function));
  });
});
