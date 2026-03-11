/**
 * Unified authentication for DKG node interfaces (HTTP API, MCP, WebSocket, etc.).
 *
 * Uses bearer tokens stored on disk. Tokens are auto-generated on first start.
 * Any interface that needs auth calls `verifyToken(token)` against the loaded set.
 */

import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dkgDir } from './config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthConfig {
  /** Master switch — when false, all requests are allowed (default: true). */
  enabled?: boolean;
  /** Pre-configured tokens. If empty, one is auto-generated on first start. */
  tokens?: string[];
}

// ---------------------------------------------------------------------------
// Token file management
// ---------------------------------------------------------------------------

function tokenFilePath(): string {
  return join(dkgDir(), 'auth.token');
}

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Load tokens from disk + config. Auto-generates a token file if none exists.
 * Returns the set of valid tokens.
 */
export async function loadTokens(authConfig?: AuthConfig): Promise<Set<string>> {
  const tokens = new Set<string>();

  // Add any config-defined tokens
  if (authConfig?.tokens) {
    for (const t of authConfig.tokens) {
      if (t.length > 0) tokens.add(t);
    }
  }

  // Load or generate the file-based token
  const filePath = tokenFilePath();
  if (existsSync(filePath)) {
    try {
      const raw = await readFile(filePath, 'utf-8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (t.length > 0 && !t.startsWith('#')) tokens.add(t);
      }
    } catch {
      // Unreadable — generate a fresh one
    }
  }

  if (tokens.size === 0) {
    const token = generateToken();
    tokens.add(token);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `# DKG node API token — treat this like a password\n${token}\n`, { mode: 0o600 });
    await chmod(filePath, 0o600);
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Verification (interface-agnostic)
// ---------------------------------------------------------------------------

/**
 * Verify a bearer token against the loaded token set.
 * This is the single entry point any interface (HTTP, MCP, WS) should use.
 */
export function verifyToken(token: string | undefined, validTokens: Set<string>): boolean {
  if (!token) return false;
  return validTokens.has(token);
}

/**
 * Extract a bearer token from an HTTP Authorization header value.
 * Accepts: "Bearer <token>" or just "<token>".
 */
export function extractBearerToken(headerValue: string | undefined): string | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed.startsWith('Bearer ')) return trimmed.slice(7).trim();
  if (trimmed.startsWith('bearer ')) return trimmed.slice(7).trim();
  return trimmed;
}

// ---------------------------------------------------------------------------
// HTTP middleware
// ---------------------------------------------------------------------------

const PUBLIC_PATHS = new Set([
  '/api/status',
  '/api/chain/rpc-health',
  '/metrics',
  '/api/apps',
]);

const PUBLIC_PREFIXES = [
  '/ui',
  '/apps/',
];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  for (const prefix of PUBLIC_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * HTTP auth guard. Returns true if the request is allowed to proceed,
 * false if a 401 response was sent.
 *
 * Usage in the server handler:
 *   if (!httpAuthGuard(req, res, authEnabled, validTokens)) return;
 */
export function httpAuthGuard(
  req: IncomingMessage,
  res: ServerResponse,
  authEnabled: boolean,
  validTokens: Set<string>,
): boolean {
  if (!authEnabled) return true;
  if (req.method === 'OPTIONS') return true;

  const pathname = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;
  if (isPublicPath(pathname)) return true;

  const token = extractBearerToken(req.headers.authorization);
  if (verifyToken(token, validTokens)) return true;

  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer realm="dkg-node"',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ error: 'Unauthorized — provide a valid Bearer token in the Authorization header' }));
  return false;
}
