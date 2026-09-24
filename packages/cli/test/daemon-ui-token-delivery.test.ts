import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleNodeUIRequest } from '@origintrail-official/dkg-node-ui';
import { hostIsLocal } from '../src/daemon/http-utils.js';
import { nodeOperatorToken, nodeUiTokenForRequest } from '../src/daemon/node-ui-access.js';

// The dashboard shell is public, but the daemon embeds the node-operator token
// in it only for a trusted local request: a loopback client socket AND a Host
// header naming the loopback interface. Everyone else gets the same shell
// without the token.

const AGENT_TOKENS = new Map([
  ['agent-token-1', '0x00000000000000000000000000000000000000a1'],
  ['agent-token-2', '0x00000000000000000000000000000000000000a2'],
]);
const resolveAgentByToken = (token: string) => AGENT_TOKENS.get(token);
// Agent tokens first: the order a token-file reload leaves the set in.
const VALID_TOKENS = new Set(['agent-token-1', 'agent-token-2', 'operator-token']);

describe('hostIsLocal', () => {
  it.each([
    '127.0.0.1',
    '127.0.0.1:9200',
    'localhost',
    'localhost:9200',
    'LocalHost:9200',
    ' localhost:9200 ',
    '[::1]',
    '[::1]:9200',
    '::1',
  ])('accepts %s', (host) => {
    expect(hostIsLocal(host)).toBe(true);
  });

  it.each([
    [undefined],
    [''],
    ['evil.example'],
    ['evil.example:9200'],
    ['localhost.evil.example:9200'],
    ['127.0.0.1.nip.io:9200'],
    ['localhost.'],
    ['0.0.0.0:9200'],
    ['127.0.0.2:9200'],
    ['192.168.1.20:9200'],
    ['[::ffff:127.0.0.1]:9200'],
    ['[::1'],
    ['[::1]9200'],
    ['localhost:abc'],
    ['127.0.0.1:9200:1'],
    ['::1:9200'],
    ['user@localhost:9200'],
  ])('rejects %s', (host) => {
    expect(hostIsLocal(host)).toBe(false);
  });
});

describe('nodeOperatorToken', () => {
  it('skips agent tokens that precede the operator token', () => {
    expect(nodeOperatorToken(VALID_TOKENS, resolveAgentByToken)).toBe('operator-token');
  });

  it('returns the first operator token', () => {
    expect(nodeOperatorToken(['config-token', 'file-token'], resolveAgentByToken)).toBe('config-token');
  });

  it('returns undefined when only agent tokens are loaded', () => {
    expect(nodeOperatorToken(['agent-token-1', 'agent-token-2'], resolveAgentByToken)).toBeUndefined();
  });
});

describe('nodeUiTokenForRequest', () => {
  function fakeReq(remoteAddress: string | undefined, host: string | undefined) {
    return {
      socket: { remoteAddress },
      headers: host === undefined ? {} : { host },
    } as unknown as IncomingMessage;
  }
  const opts = { authEnabled: true, validTokens: VALID_TOKENS, resolveAgentByToken };

  it.each([
    ['127.0.0.1', 'localhost:9200'],
    ['127.0.0.1', '127.0.0.1:9200'],
    ['127.0.0.1', 'localhost'],
    ['::1', '[::1]:9200'],
    ['::ffff:127.0.0.1', 'localhost:9200'],
  ])('serves the operator token to %s with Host %s', (remoteAddress, host) => {
    expect(nodeUiTokenForRequest(fakeReq(remoteAddress, host), opts)).toBe('operator-token');
  });

  it.each([
    // Non-loopback clients, whatever Host they present.
    ['192.168.1.20', 'localhost:9200'],
    ['192.168.1.20', '192.168.1.5:9200'],
    ['10.0.0.8', '127.0.0.1:9200'],
    ['::ffff:10.0.0.8', '[::1]:9200'],
    // Loopback clients presenting another host name, or none.
    ['127.0.0.1', 'evil.example:9200'],
    ['::1', 'other.example:9200'],
    ['127.0.0.1', undefined],
    // No socket address at all.
    [undefined, 'localhost:9200'],
  ])('withholds the token from %s with Host %s', (remoteAddress, host) => {
    expect(nodeUiTokenForRequest(fakeReq(remoteAddress, host), opts)).toBeUndefined();
  });

  it('withholds the token when daemon auth is disabled', () => {
    expect(nodeUiTokenForRequest(
      fakeReq('127.0.0.1', 'localhost:9200'),
      { ...opts, authEnabled: false },
    )).toBeUndefined();
  });
});

describe('dashboard shell behind the token decision (real HTTP)', () => {
  let server: Server;
  let port: number;
  let staticDir: string;

  beforeAll(async () => {
    staticDir = mkdtempSync(join(tmpdir(), 'dkg-ui-shell-'));
    writeFileSync(join(staticDir, 'index.html'), '<html><head><title>DKG</title></head><body></body></html>');
    // Mirrors the daemon: decide the token per request, then serve the shell.
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const token = nodeUiTokenForRequest(req, { authEnabled: true, validTokens: VALID_TOKENS, resolveAgentByToken });
      void handleNodeUIRequest(req, res, url, { dataDir: staticDir } as never, staticDir, undefined, undefined, token);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(staticDir, { recursive: true, force: true });
  });

  // node:http, not fetch: the Host header must reach the server exactly as set.
  function get(path: string, host: string): Promise<{ status: number; body: string; acao: unknown }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          acao: res.headers['access-control-allow-origin'],
        }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it.each(['localhost', '127.0.0.1'])('embeds the operator token for a loopback caller with Host %s', async (name) => {
    const res = await get('/ui', `${name}:${port}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<script>window.__DKG_TOKEN__="operator-token"</script>');
    expect(res.acao).toBeUndefined();
  });

  it.each(['/ui', '/ui/', '/ui/settings'])('serves %s without the token to a loopback caller with a foreign Host', async (path) => {
    const res = await get(path, `evil.example:${port}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<title>DKG</title>');
    expect(res.body).not.toContain('__DKG_TOKEN__');
    expect(res.body).not.toContain('operator-token');
  });
});
