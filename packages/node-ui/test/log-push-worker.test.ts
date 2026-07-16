/**
 * Tests for LogPushWorker: syslog RFC 5424 formatting, SD escaping,
 * newline stripping, message truncation, buffer overflow, flush behavior.
 *
 * Uses a real TCP server on localhost to capture what the worker sends.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { LogPushWorker, type LogPushWorkerOptions } from '../src/gelf-push-worker.js';

function makeEntry(overrides?: Partial<{
  level: string;
  operationName: string;
  operationId: string;
  module: string;
  message: string;
}>) {
  return {
    level: 'info',
    operationName: 'publish',
    operationId: 'op-001',
    module: 'DKGAgent',
    message: 'Test log message',
    ...overrides,
  };
}

function startServer(): Promise<{ server: Server; port: number; lines: () => string[] }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const server = createServer((socket: Socket) => {
      socket.on('data', (d) => chunks.push(d));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        port: addr.port,
        lines: () => Buffer.concat(chunks).toString('utf-8').split('\n').filter(Boolean),
      });
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const FLUSH_WAIT = 2500;

describe('LogPushWorker', () => {
  let server: Server | null = null;
  let worker: LogPushWorker | null = null;

  afterEach(async () => {
    worker?.stop();
    worker = null;
    await new Promise<void>((r) => server ? server.close(() => r()) : r());
    server = null;
  });

  it('formats syslog RFC 5424 lines correctly', async () => {
    const { server: srv, port, lines } = await startServer();
    server = srv;

    worker = new LogPushWorker({
      host: '127.0.0.1', port, peerId: '12D3KooWTestPeer', network: 'testnet', nodeName: 'tars',
    });
    worker.push(makeEntry());
    worker.start();

    await wait(FLUSH_WAIT);

    const result = lines();
    expect(result.length).toBeGreaterThanOrEqual(1);

    const line = result[0];
    // PRI = FACILITY_LOCAL0 * 8 + severity(info=6) = 16*8+6 = 134
    expect(line).toMatch(/^<134>1 /);
    expect(line).toContain(' dkg ');
    expect(line).toContain(' tars ');
    expect(line).toContain('[dkg@0 ');
    expect(line).toContain('peer="12D3KooWTestPeer"');
    expect(line).toContain('op="publish"');
    expect(line).toContain('opid="op-001"');
    expect(line).toContain('mod="DKGAgent"');
    expect(line).toContain('net="testnet"');
    expect(line).toContain('Test log message');
  });

  it('maps log levels to correct syslog severity', async () => {
    const { server: srv, port, lines } = await startServer();
    server = srv;

    worker = new LogPushWorker({
      host: '127.0.0.1', port, peerId: 'peer1', network: 'testnet', nodeName: 'n1',
    });

    worker.push(makeEntry({ level: 'error' }));
    worker.push(makeEntry({ level: 'warn' }));
    worker.push(makeEntry({ level: 'info' }));
    worker.push(makeEntry({ level: 'debug' }));
    worker.start();

    await wait(FLUSH_WAIT);

    const result = lines();
    expect(result).toHaveLength(4);
    const pris = result.map((l) => {
      const m = l.match(/^<(\d+)>/);
      return m ? Number(m[1]) : -1;
    });
    // FACILITY_LOCAL0 = 16, pri = 16*8 + severity
    expect(pris).toEqual([16 * 8 + 3, 16 * 8 + 4, 16 * 8 + 6, 16 * 8 + 7]);
  });

  it('escapes SD-PARAM special characters (backslash, quote, bracket)', async () => {
    const { server: srv, port, lines } = await startServer();
    server = srv;

    worker = new LogPushWorker({
      host: '127.0.0.1', port,
      peerId: 'peer"with\\special]chars',
      network: 'testnet',
      nodeName: 'node"test',
    });

    worker.push(makeEntry({
      operationName: 'op"name',
      operationId: 'id\\with]brackets',
      module: 'Mod"ule',
    }));
    worker.start();

    await wait(FLUSH_WAIT);

    const line = lines()[0];
    // Backslash-escaped per RFC 5424 SD-PARAM rules
    expect(line).toContain('peer="peer\\"with\\\\special\\]chars"');
    expect(line).toContain('op="op\\"name"');
    expect(line).toContain('opid="id\\\\with\\]brackets"');
    expect(line).toContain('mod="Mod\\"ule"');
  });

  it('strips newlines from message body', async () => {
    const { server: srv, port, lines } = await startServer();
    server = srv;

    worker = new LogPushWorker({
      host: '127.0.0.1', port, peerId: 'p1', network: 'testnet', nodeName: 'n1',
    });
    worker.push(makeEntry({ message: 'line1\nline2\r\nline3\rline4' }));
    worker.start();

    await wait(FLUSH_WAIT);

    const line = lines()[0];
    expect(line).toContain('line1 line2 line3 line4');
  });

  it('truncates messages longer than 8192 characters', async () => {
    const { server: srv, port, lines } = await startServer();
    server = srv;

    worker = new LogPushWorker({
      host: '127.0.0.1', port, peerId: 'p1', network: 'testnet', nodeName: 'n1',
    });
    const longMsg = 'A'.repeat(10000);
    worker.push(makeEntry({ message: longMsg }));
    worker.start();

    await wait(FLUSH_WAIT);

    const line = lines()[0];
    // Extract the message portion (after the last ] and space)
    const afterSD = line.split('] ').pop()!;
    expect(afterSD.length).toBeLessThanOrEqual(8192);
  });

  it('drops oldest entries when buffer exceeds MAX_BUFFER (500)', async () => {
    const { server: srv, port, lines } = await startServer();
    server = srv;

    worker = new LogPushWorker({
      host: '127.0.0.1', port, peerId: 'p1', network: 'testnet', nodeName: 'n1',
    });

    for (let i = 0; i < 510; i++) {
      worker.push(makeEntry({ operationId: `op-${i}` }));
    }
    worker.start();

    await wait(FLUSH_WAIT);

    const result = lines();
    // MAX_BUFFER = 500, so oldest 10 entries were dropped
    expect(result).toHaveLength(500);
    // First entry should be op-10 (the first 10 were dropped)
    expect(result[0]).toContain('opid="op-10"');
    expect(result[499]).toContain('opid="op-509"');
  });

  it('defaults nodeName to dkg-node when not provided', async () => {
    const { server: srv, port, lines } = await startServer();
    server = srv;

    worker = new LogPushWorker({
      host: '127.0.0.1', port, peerId: 'peer1', network: 'testnet',
    });
    worker.push(makeEntry());
    worker.start();

    await wait(FLUSH_WAIT);

    const line = lines()[0];
    expect(line).toContain(' dkg-node ');
  });

  it('does not send anything when buffer is empty', async () => {
    const { server: srv, port, lines } = await startServer();
    server = srv;

    worker = new LogPushWorker({
      host: '127.0.0.1', port, peerId: 'peer1', network: 'testnet',
    });
    worker.start();

    await wait(FLUSH_WAIT);

    expect(lines()).toHaveLength(0);
  });
});
