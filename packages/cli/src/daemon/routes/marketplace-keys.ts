// OT-RFC-27 buyer gateway key administration (spec §10.4) — node-admin only,
// OUTSIDE the gateway prefix, dispatched from `handleMarketplaceRoutes`:
//
//   GET  /api/marketplace/keys                  → { keys: PublicGatewayKeyRecord[] }
//   POST /api/marketplace/keys                  → 201 { key: <plaintext, shown once>, record }
//   POST /api/marketplace/keys/:keyId/revoke    → { keyId, revokedAt } (idempotent; 404 unknown)
//
// A gateway key is never accepted here (it is not a daemon token, so
// `authenticateHttpRequest` already 401s it before this module runs). The
// key HASH never leaves the store; the plaintext appears only in the mint
// response and is never logged.

import { ethers } from 'ethers';
import {
  canonicalModelId,
  publicGatewayKeyRecord,
  type GatewayKeyScopes,
} from '@origintrail-official/dkg-agent/dist/marketplace/gateway-domain.js';
import { jsonResponse, readBody, SMALL_BODY_BYTES } from '../http-utils.js';
import type { RequestContext } from './context.js';
import { dkgDir } from '../../config.js';
import { parseMarketplaceUint } from '../../marketplace-config.js';
import { openGatewayKeyStore, type MarketplaceGatewayKeyStore } from '../../marketplace-gateway-key-store.js';

export const MARKETPLACE_KEYS_PATH = '/api/marketplace/keys';
const REVOKE_PATH = /^\/api\/marketplace\/keys\/([^/]+)\/revoke$/;
const KEY_ID_PATTERN = /^gw_[0-9a-f]{8}$/;
const DEFAULT_RPS = 5;
const MAX_EXPIRES_IN_SECONDS = 10 * 365 * 86_400;
const MAX_ALLOWLIST = 256;

/** The shared key store of this daemon (the gateway dispatch opens the same one). */
export function daemonGatewayKeyStore(): MarketplaceGatewayKeyStore {
  return openGatewayKeyStore(dkgDir());
}

function parseBudgetWei(body: Record<string, unknown>): bigint {
  const { budgetWei, budgetTrac } = body;
  if ((budgetWei === undefined) === (budgetTrac === undefined)) {
    throw new Error('pass exactly one of budgetWei (decimal wei string) or budgetTrac (decimal TRAC)');
  }
  let wei: bigint;
  if (budgetWei !== undefined) {
    wei = parseMarketplaceUint(budgetWei, 'budgetWei', 96);
  } else {
    if (typeof budgetTrac !== 'string' && typeof budgetTrac !== 'number') {
      throw new Error('budgetTrac must be a decimal number of TRAC tokens');
    }
    const text = String(budgetTrac).trim();
    if (!/^\d+(\.\d{1,18})?$/.test(text)) throw new Error('budgetTrac must be a positive decimal number of TRAC tokens');
    wei = ethers.parseEther(text);
    if (wei >= 1n << 96n) throw new Error('budgetTrac must fit in uint96 wei');
  }
  if (wei <= 0n) throw new Error('the key budget must be > 0');
  return wei;
}

function parseExpiry(body: Record<string, unknown>, nowSeconds: number): number | null {
  const { expiresAt, expiresInSeconds } = body;
  if (expiresAt !== undefined && expiresInSeconds !== undefined) {
    throw new Error('pass at most one of expiresAt (unix seconds) or expiresInSeconds');
  }
  if (expiresAt !== undefined && expiresAt !== null) {
    if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds) {
      throw new Error('expiresAt must be a future unix timestamp in seconds');
    }
    return expiresAt;
  }
  if (expiresInSeconds !== undefined && expiresInSeconds !== null) {
    if (typeof expiresInSeconds !== 'number' || !Number.isSafeInteger(expiresInSeconds)
      || expiresInSeconds < 1 || expiresInSeconds > MAX_EXPIRES_IN_SECONDS) {
      throw new Error(`expiresInSeconds must be an integer 1..${MAX_EXPIRES_IN_SECONDS}`);
    }
    return nowSeconds + expiresInSeconds;
  }
  return null;
}

function parseAllowlist(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length > MAX_ALLOWLIST) {
    throw new Error(`modelAllowlist must be null or an array of at most ${MAX_ALLOWLIST} model ids`);
  }
  const out: string[] = [];
  raw.forEach((entry, index) => {
    const canonical = canonicalModelId(entry);
    if (typeof entry !== 'string' || canonical === undefined) {
      throw new Error(`modelAllowlist[${index}] is not a valid model id`);
    }
    if (!out.includes(canonical)) out.push(canonical);
  });
  return out;
}

/** Parse the mint body into ledger scopes (400 on any fault, naming the field). */
export function parseGatewayKeyMintBody(raw: unknown, nowSeconds: number): GatewayKeyScopes {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('body must be a JSON object');
  const body = raw as Record<string, unknown>;
  if (body.label !== undefined && (typeof body.label !== 'string' || body.label.length > 64)) {
    throw new Error('label must be a string of at most 64 characters');
  }
  if (body.allowQuery !== undefined && typeof body.allowQuery !== 'boolean') {
    throw new Error('allowQuery must be a boolean');
  }
  if (body.rps !== undefined
    && (typeof body.rps !== 'number' || !Number.isSafeInteger(body.rps) || body.rps < 1 || body.rps > 1000)) {
    throw new Error('rps must be an integer 1..1000');
  }
  return {
    label: (body.label as string | undefined) ?? '',
    budgetWei: parseBudgetWei(body),
    expiresAt: parseExpiry(body, nowSeconds),
    modelAllowlist: parseAllowlist(body.modelAllowlist),
    allowQuery: (body.allowQuery as boolean | undefined) ?? true,
    rps: (body.rps as number | undefined) ?? DEFAULT_RPS,
  };
}

/**
 * The key admin routes. Returns true when it answered. `requireNodeAdmin`
 * writes the 403 itself; the caller already proved the path is under
 * `/api/marketplace/keys`.
 */
export async function handleMarketplaceKeyRoutes(
  ctx: RequestContext,
  requireNodeAdmin: () => boolean,
  openStore: () => MarketplaceGatewayKeyStore = daemonGatewayKeyStore,
): Promise<boolean> {
  const { req, res, path } = ctx;
  const isList = path === MARKETPLACE_KEYS_PATH;
  const revokeMatch = REVOKE_PATH.exec(path);
  if (!isList && !revokeMatch) return false;
  if (!requireNodeAdmin()) return true;
  if ((isList && req.method !== 'GET' && req.method !== 'POST') || (revokeMatch && req.method !== 'POST')) {
    jsonResponse(res, 405, { error: `${req.method} is not supported on ${path}` });
    return true;
  }
  const store = openStore();
  if (!store.available) {
    // The path rides in `file`: error-shaped fields are path-scrubbed on egress.
    jsonResponse(res, 500, {
      error: 'the gateway key store is unusable; fix or remove the file, then restart the node',
      code: 'KEY_STORE_UNAVAILABLE',
      file: store.path,
      reason: store.loadError,
    });
    return true;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (isList && req.method === 'GET') {
    jsonResponse(res, 200, { keys: store.ledger().list().map(publicGatewayKeyRecord) });
    return true;
  }

  if (isList) {
    let scopes: GatewayKeyScopes;
    try {
      const text = await readBody(req, SMALL_BODY_BYTES);
      scopes = parseGatewayKeyMintBody(text.trim() === '' ? {} : JSON.parse(text), nowSeconds);
    } catch (err: any) {
      if (err?.name === 'PayloadTooLargeError') throw err;
      jsonResponse(res, 400, { error: err instanceof SyntaxError ? `Invalid JSON: ${err.message}` : err?.message ?? String(err) });
      return true;
    }
    try {
      const { plaintext, record } = await store.mint(scopes, nowSeconds);
      // The plaintext is in THIS response only; it is never stored or logged.
      jsonResponse(res, 201, { key: plaintext, record: publicGatewayKeyRecord(record) });
    } catch (err: any) {
      if (err?.name === 'GatewayKeyScopeError') {
        jsonResponse(res, 400, { error: err.message });
      } else {
        jsonResponse(res, 500, { error: `could not persist the new gateway key (nothing was minted): ${err?.message ?? String(err)}` });
      }
    }
    return true;
  }

  const keyId = decodeURIComponentSafe(revokeMatch![1]);
  if (keyId === undefined || !KEY_ID_PATTERN.test(keyId)) {
    jsonResponse(res, 404, { error: 'unknown gateway key' });
    return true;
  }
  try {
    const record = await store.revoke(keyId, nowSeconds);
    if (!record) {
      jsonResponse(res, 404, { error: 'unknown gateway key' });
      return true;
    }
    jsonResponse(res, 200, { keyId: record.keyId, revokedAt: record.revokedAt });
  } catch (err: any) {
    jsonResponse(res, 500, {
      error: `the key is revoked for this daemon run but the revocation could not be persisted: ${err?.message ?? String(err)}`,
    });
  }
  return true;
}

function decodeURIComponentSafe(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
