// Node identity operational-wallet (Identity operational-key) management.
//
//   GET    /api/operational-wallets            — list the node's local operational
//                                                 wallets (addresses ONLY) with their
//                                                 on-chain authorization status.
//   POST   /api/operational-wallets {address}  — authorize an address as an operational
//                                                 key on the node identity (admin-signed).
//   DELETE /api/operational-wallets/:address   — de-authorize an operational key
//                                                 (admin-signed); refuses the primary wallet.
//
// Writes are signed server-side by the configured admin key (the contract's
// `onlyAdmin` gate). The chain stores keccak HASHES of operational keys, not
// addresses, so the displayed list is sourced from the node's local wallet
// store (~/.dkg/wallets.json) — never the private keys — and annotated with
// on-chain status. Owner of the protection is on-chain (admin key) + the
// daemon bearer-token guard; there is no separate admin tier in transport.

import { ethers } from 'ethers';
import { jsonResponse, readBody, SMALL_BODY_BYTES, respondIfChainRpcTransportError } from '../http-utils.js';
import type { ServerResponse } from 'node:http';
import type { InternalRequestContext as RequestContext } from './context.js';

const FEATURE_UNAVAILABLE_503 = {
  error:
    'Chain adapter does not expose operational-wallet management — ' +
    'not available on this deployment',
};

// NoChainAdapter throws `noChain()` → 503.
function isNoChain(msg: string): boolean {
  return /No blockchain configured/i.test(msg);
}
function isNoAdminKey(msg: string): boolean {
  return /adminPrivateKey is not configured|not registered on-chain as an admin key/i.test(msg);
}
function isNoProfile(msg: string): boolean {
  return /has no on-chain profile/i.test(msg);
}
function isRefusePrimary(msg: string): boolean {
  return /refusing to remove the node's primary operational wallet/i.test(msg);
}

// Deterministic Profile/Identity custom-error reverts → 4xx.
function classifyKeyRevert(msg: string): { status: number; error: string } | null {
  if (/\bOperationalKeyTaken\b/.test(msg)) return { status: 409, error: 'OperationalKeyTaken' };
  if (/\bAdminEqualsOperational\b/.test(msg)) return { status: 400, error: 'AdminEqualsOperational' };
  if (/\bOperationalAddressZero\b/.test(msg)) return { status: 400, error: 'OperationalAddressZero' };
  if (/\bKeyNotAttached\b/.test(msg)) return { status: 404, error: 'KeyNotAttached' };
  if (/\bCannotDeleteOnlyOperationalKey\b/.test(msg)) return { status: 409, error: 'CannotDeleteOnlyOperationalKey' };
  if (/\bCannotDeleteOnlyAdminKey\b/.test(msg)) return { status: 409, error: 'CannotDeleteOnlyAdminKey' };
  if (/ProfileDoesntExist|ProfileDoesNotExist/.test(msg)) return { status: 409, error: 'ProfileDoesNotExist' };
  return null;
}

function safeParseJson(body: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (e: any) {
    return { ok: false, error: `Invalid JSON: ${e?.message ?? String(e)}` };
  }
}

// Shared error mapping for the add/remove write paths.
function respondKeyError(res: ServerResponse, err: unknown, address: string): void {
  const msg = (err as any)?.message ?? String(err);
  if (isNoChain(msg)) {
    jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
    return;
  }
  if (respondIfChainRpcTransportError(res, err)) return;
  if (isRefusePrimary(msg)) {
    jsonResponse(res, 409, { error: 'CannotRemovePrimaryOperationalWallet', address, detail: msg });
    return;
  }
  if (isNoAdminKey(msg)) {
    jsonResponse(res, 409, { error: 'AdminKeyNotConfigured', address, detail: msg });
    return;
  }
  if (isNoProfile(msg)) {
    jsonResponse(res, 409, { error: 'ProfileDoesNotExist', address });
    return;
  }
  const revert = classifyKeyRevert(msg);
  if (revert) {
    jsonResponse(res, revert.status, { error: revert.error, address });
    return;
  }
  jsonResponse(res, 500, { error: `operational wallet update failed: ${msg}` });
}

export async function handleOperationalWalletRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, path, opWallets, config, requestToken, validTokens } = ctx;

  if (!path.startsWith('/api/operational-wallets')) return;

  // These routes admin-sign on-chain identity-key mutations with the daemon's
  // OWN admin key, so the on-chain `onlyAdmin` gate is always satisfied by the
  // daemon — the bearer token is the ONLY caller gate. Mutating the node
  // identity is an operator action: require a node-level admin token, not a
  // per-agent (dkg_at_) token (which the global guard would otherwise accept).
  // Mirrors isNodeAdminCaller in context-graph.ts. Reads are not gated here.
  const authEnabled = config.auth?.enabled !== false;
  const isNodeAdmin = (): boolean =>
    !authEnabled ||
    (!!requestToken && validTokens.has(requestToken) && !agent.resolveAgentByToken(requestToken));
  const requireNodeAdmin = (): boolean => {
    if (isNodeAdmin()) return true;
    jsonResponse(res, 403, {
      error: 'Node-admin token required (~/.dkg/auth.token) to manage operational wallets; agent-scoped tokens cannot mutate the node identity.',
    });
    return false;
  };

  // GET /api/operational-wallets — addresses ONLY (never private keys) + status.
  if (req.method === 'GET' && path === '/api/operational-wallets') {
    const adminKeyConfigured = Boolean(opWallets.adminWallet);
    const adminAddr = opWallets.adminWallet?.address ?? null;
    const primaryAddr = opWallets.wallets[0]?.address ?? null;
    try {
      const identityId = await agent.getNodeIdentityId();

      // De-dup the local wallet addresses (operational pool + admin wallet).
      const seen = new Set<string>();
      const ordered: string[] = [];
      for (const w of opWallets.wallets) {
        const a = ethers.getAddress(w.address);
        if (seen.has(a.toLowerCase())) continue;
        seen.add(a.toLowerCase());
        ordered.push(a);
      }
      if (adminAddr) {
        const a = ethers.getAddress(adminAddr);
        if (!seen.has(a.toLowerCase())) {
          seen.add(a.toLowerCase());
          ordered.push(a);
        }
      }

      const wallets = await Promise.all(
        ordered.map(async (address) => {
          let registered: boolean | null = null;
          if (identityId !== 0n) {
            try {
              registered = await agent.isOperationalWalletRegistered(identityId, address);
            } catch {
              registered = null;
            }
          }
          return {
            address,
            isAdmin: adminAddr != null && address.toLowerCase() === adminAddr.toLowerCase(),
            isPrimary: primaryAddr != null && address.toLowerCase() === primaryAddr.toLowerCase(),
            registered,
          };
        }),
      );

      return jsonResponse(res, 200, {
        identityId: identityId.toString(),
        hasProfile: identityId !== 0n,
        adminKeyConfigured,
        // Add/remove require BOTH a configured admin key and an on-chain profile.
        canManage: adminKeyConfigured && identityId !== 0n,
        wallets,
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (isNoChain(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (respondIfChainRpcTransportError(res, err)) return;
      return jsonResponse(res, 500, { error: `listOperationalWallets failed: ${msg}` });
    }
  }

  // POST /api/operational-wallets — authorize an address on-chain. Body: { address }.
  if (req.method === 'POST' && path === '/api/operational-wallets') {
    if (!requireNodeAdmin()) return;
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body);
    if (!parsed.ok) return jsonResponse(res, 400, { error: parsed.error });
    const { address } = parsed.value ?? {};
    if (typeof address !== 'string' || !ethers.isAddress(address)) {
      return jsonResponse(res, 400, { error: 'address must be a valid 0x-prefixed EVM address' });
    }
    const checksum = ethers.getAddress(address);
    try {
      const result = await agent.addOperationalWallet(checksum);
      if (result === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, {
        address: checksum,
        added: true,
        txHash: result.hash,
        blockNumber: result.blockNumber,
      });
    } catch (err: any) {
      return respondKeyError(res, err, checksum);
    }
  }

  // DELETE /api/operational-wallets/:address — de-authorize an operational key.
  if (req.method === 'DELETE' && /^\/api\/operational-wallets\/[^/]+$/.test(path)) {
    if (!requireNodeAdmin()) return;
    const address = decodeURIComponent(path.split('/')[3] ?? '');
    if (!ethers.isAddress(address)) {
      return jsonResponse(res, 400, { error: 'address must be a valid 0x-prefixed EVM address' });
    }
    const checksum = ethers.getAddress(address);
    try {
      const result = await agent.removeOperationalWallet(checksum);
      if (result === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, {
        address: checksum,
        removed: true,
        txHash: result.hash,
        blockNumber: result.blockNumber,
      });
    } catch (err: any) {
      return respondKeyError(res, err, checksum);
    }
  }
}
