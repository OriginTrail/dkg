import type { IncomingMessage, ServerResponse } from 'node:http';
import { PayloadTooLargeError } from '@origintrail-official/dkg-core';
import { type AllowedHttpAuthentication } from '../auth.js';
import { resolveSharedMemoryTtlMs, type DkgConfig } from '../config.js';
import { jsonResponse, readBody, SMALL_BODY_BYTES } from './http-utils.js';
import { requireNodeAdmin } from './node-admin-guard.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SHARED_MEMORY_TTL_MS = 30 * DAY_MS;

// V10 name first; `workspace-ttl` is the legacy name of the same setting.
const SHARED_MEMORY_TTL_PATHS = new Set([
  '/api/settings/shared-memory-ttl',
  '/api/settings/workspace-ttl',
]);

/**
 * Shared memory (workspace) TTL setting. Any authenticated caller may read it;
 * changing it rewrites the node's config, so a PUT requires a node-level admin
 * token. Returns false for requests this route does not own.
 */
export async function handleSharedMemoryTtlSettingsRequest(input: {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly pathname: string;
  readonly authentication: AllowedHttpAuthentication;
  readonly config: DkgConfig;
  readonly setSharedMemoryTtlMs: (ttlMs: number) => void;
  readonly saveConfig: (config: DkgConfig) => Promise<void>;
}): Promise<boolean> {
  const { req, res, config } = input;
  if (!SHARED_MEMORY_TTL_PATHS.has(input.pathname)) return false;

  if (req.method === 'GET') {
    const ttlMs = resolveSharedMemoryTtlMs(config) ?? DEFAULT_SHARED_MEMORY_TTL_MS;
    jsonResponse(res, 200, { ttlMs, ttlDays: Math.round(ttlMs / DAY_MS) });
    return true;
  }
  if (req.method !== 'PUT') return false;

  if (!requireNodeAdmin(input.authentication, res, `PUT ${input.pathname}`, 'change node settings')) {
    return true;
  }
  try {
    const bodyStr = await readBody(req, SMALL_BODY_BYTES);
    const { ttlDays } = JSON.parse(bodyStr ?? '{}') as { ttlDays?: number };
    if (typeof ttlDays !== 'number' || !Number.isFinite(ttlDays) || ttlDays < 0) {
      jsonResponse(res, 400, { error: 'ttlDays must be a finite non-negative number' });
      return true;
    }
    const ttlMs = Math.round(ttlDays * DAY_MS);
    config.sharedMemoryTtlMs = ttlMs;
    config.workspaceTtlMs = ttlMs;
    input.setSharedMemoryTtlMs(ttlMs);
    await input.saveConfig(config);
    jsonResponse(res, 200, { ok: true, ttlMs, ttlDays });
  } catch (err: any) {
    if (err instanceof PayloadTooLargeError) throw err;
    jsonResponse(res, 500, { error: err.message ?? 'Failed to update shared memory TTL' });
  }
  return true;
}
