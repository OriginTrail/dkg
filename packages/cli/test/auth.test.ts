import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  verifyToken,
  extractBearerToken,
  httpAuthGuard,
  loadTokens,
} from '../src/auth.js';

// ---------------------------------------------------------------------------
// Unit tests for pure functions
// ---------------------------------------------------------------------------

describe('extractBearerToken', () => {
  it('extracts token from "Bearer <token>"', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });

  it('handles lowercase "bearer"', () => {
    expect(extractBearerToken('bearer xyz')).toBe('xyz');
  });

  it('returns raw value when no Bearer prefix', () => {
    expect(extractBearerToken('raw-token-value')).toBe('raw-token-value');
  });

  it('returns undefined for undefined input', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(extractBearerToken('')).toBeUndefined();
  });

  it('trims whitespace', () => {
    expect(extractBearerToken('  Bearer  tok  ')).toBe('tok');
  });
});

describe('verifyToken', () => {
  const tokens = new Set(['valid-token-1', 'valid-token-2']);

  it('returns true for valid token', () => {
    expect(verifyToken('valid-token-1', tokens)).toBe(true);
    expect(verifyToken('valid-token-2', tokens)).toBe(true);
  });

  it('returns false for invalid token', () => {
    expect(verifyToken('bad-token', tokens)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(verifyToken(undefined, tokens)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(verifyToken('', tokens)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadTokens
// ---------------------------------------------------------------------------

describe('loadTokens', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `dkg-auth-test-${randomBytes(4).toString('hex')}`);
    await mkdir(tempDir, { recursive: true });
    process.env.DKG_HOME = tempDir;
  });

  afterEach(async () => {
    delete process.env.DKG_HOME;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('auto-generates a token file when none exists', async () => {
    const tokens = await loadTokens();
    expect(tokens.size).toBe(1);
    const [token] = [...tokens];
    expect(token.length).toBeGreaterThan(20);
  });

  it('loads tokens from existing file', async () => {
    await writeFile(join(tempDir, 'auth.token'), '# comment\nmy-custom-token\n');
    const tokens = await loadTokens();
    expect(tokens.has('my-custom-token')).toBe(true);
  });

  it('skips comment lines and empty lines', async () => {
    await writeFile(join(tempDir, 'auth.token'), '# header\n\ntoken-a\n\n# another comment\ntoken-b\n');
    const tokens = await loadTokens();
    expect(tokens.has('token-a')).toBe(true);
    expect(tokens.has('token-b')).toBe(true);
    expect(tokens.has('# header')).toBe(false);
    expect(tokens.size).toBe(2);
  });

  it('merges config tokens with file tokens', async () => {
    await writeFile(join(tempDir, 'auth.token'), 'file-token\n');
    const tokens = await loadTokens({ tokens: ['config-token'] });
    expect(tokens.has('file-token')).toBe(true);
    expect(tokens.has('config-token')).toBe(true);
    expect(tokens.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// httpAuthGuard (integration test with real HTTP server)
// ---------------------------------------------------------------------------

describe('httpAuthGuard', () => {
  const VALID_TOKEN = 'test-secret-token';
  const validTokens = new Set([VALID_TOKEN]);
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!httpAuthGuard(req, res, true, validTokens)) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('allows /api/status without token (public)', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('allows OPTIONS without token (CORS preflight)', async () => {
    const res = await fetch(`${baseUrl}/api/shared-memory/publish`, { method: 'OPTIONS' });
    expect(res.status).toBe(200);
  });

  it('allows /ui paths without token (static UI)', async () => {
    const res = await fetch(`${baseUrl}/ui/index.html`);
    expect(res.status).toBe(200);
  });

  it('rejects protected endpoint without token', async () => {
    const res = await fetch(`${baseUrl}/api/shared-memory/publish`, { method: 'POST' });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('Unauthorized');
  });

  it('rejects protected endpoint with invalid token', async () => {
    const res = await fetch(`${baseUrl}/api/agents`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('allows protected endpoint with valid Bearer token', async () => {
    const res = await fetch(`${baseUrl}/api/agents`, {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('allows protected endpoint with raw token (no Bearer prefix)', async () => {
    const res = await fetch(`${baseUrl}/api/shared-memory/publish`, {
      method: 'POST',
      headers: { Authorization: VALID_TOKEN },
    });
    expect(res.status).toBe(200);
  });

  it('includes WWW-Authenticate header in 401 response', async () => {
    const res = await fetch(`${baseUrl}/api/query`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="dkg-node"');
  });
});

describe('httpAuthGuard (auth disabled)', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!httpAuthGuard(req, res, false, new Set())) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('allows all requests when auth is disabled', async () => {
    const res = await fetch(`${baseUrl}/api/shared-memory/publish`, { method: 'POST' });
    expect(res.status).toBe(200);
  });
});
