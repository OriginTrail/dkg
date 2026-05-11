// daemon/routes/pca.ts
//
// Route handlers for Publishing Conviction Account (PCA) operator
// surface. Lives in its own file (instead of folding into `assertion.ts`)
// because PCAs are a distinct economic primitive: they're the off-chain
// expression of the on-chain `PublishingConvictionAccount` contract,
// driven by an operator standing up the runbook fixtures, not by the
// publish/query data path.
//
// All four routes delegate to the agent facade methods added in
// `packages/agent/src/dkg-agent.ts` (createPublishingConvictionAccount,
// addPCAAuthorizedKey, isPCAAuthorizedKey, getPublishingConvictionAccountInfo,
// addPublishingConvictionAccountFunds), which in turn delegate to the
// chain adapter. Reads are permissionless on chain; writes are
// admin-gated by the on-chain `require(msg.sender == account.admin)`
// check, so the daemon must be running as the PCA admin EOA for
// `POST /api/pca/:id/authorize` and `POST /api/pca/:id/funds` to land.
//
// Adapters that don't expose the underlying chain methods (no-chain
// mode, pre-V10.1 adapter copies) return 503 — same convention as the
// existing `/api/kc/:id/author` route.

import { ethers } from 'ethers';
import { jsonResponse, readBody, SMALL_BODY_BYTES } from '../http-utils.js';
import type { RequestContext } from './context.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const FEATURE_UNAVAILABLE_503 = {
  error:
    'Chain adapter does not expose Publishing Conviction Account methods — ' +
    'V10.1 PCA management is not available on this deployment',
};

function safeParseJson(body: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (e: any) {
    return { ok: false, error: `Invalid JSON: ${e?.message ?? String(e)}` };
  }
}

function parseAccountId(idStr: string): bigint | null {
  if (!/^\d+$/.test(idStr)) return null;
  try {
    const id = BigInt(idStr);
    return id >= 0n ? id : null;
  } catch {
    return null;
  }
}

function parseTokenAmount(raw: unknown, field: string): bigint | { error: string } {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { error: `${field} must be a decimal string of TRAC tokens` };
  }
  const s = String(raw).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    return { error: `${field} must be a positive decimal number of TRAC tokens` };
  }
  try {
    const wei = ethers.parseEther(s);
    if (wei <= 0n) return { error: `${field} must be > 0` };
    return wei;
  } catch (e: any) {
    return { error: `${field} parse error: ${e?.message ?? String(e)}` };
  }
}

function serializeAccountInfo(info: {
  accountId: bigint;
  admin: string;
  balance: bigint;
  initialDeposit: bigint;
  lockEpochs: number;
  conviction: bigint;
  discountBps: number;
}): Record<string, unknown> {
  return {
    accountId: info.accountId.toString(),
    admin: info.admin,
    balance: info.balance.toString(),
    balanceTrac: ethers.formatEther(info.balance),
    initialDeposit: info.initialDeposit.toString(),
    initialDepositTrac: ethers.formatEther(info.initialDeposit),
    lockEpochs: info.lockEpochs,
    conviction: info.conviction.toString(),
    discountBps: info.discountBps,
  };
}

export async function handlePcaRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, path } = ctx;

  if (!path.startsWith('/api/pca')) return;

  // POST /api/pca — create a new PCA, signed by the daemon's EOA. The
  // signer becomes the on-chain `admin` and is auto-authorized.
  // Body: { tokens: "100000", lockEpochs: 12 }
  if (req.method === 'POST' && path === '/api/pca') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body);
    if (!parsed.ok) return jsonResponse(res, 400, { error: parsed.error });
    const { tokens, lockEpochs } = parsed.value ?? {};
    const amount = parseTokenAmount(tokens, 'tokens');
    if (typeof amount !== 'bigint') return jsonResponse(res, 400, amount);
    if (typeof lockEpochs !== 'number' || !Number.isInteger(lockEpochs) || lockEpochs <= 0) {
      return jsonResponse(res, 400, {
        error: 'lockEpochs must be a positive integer (number of epochs to lock)',
      });
    }
    try {
      const result = await agent.createPublishingConvictionAccount(amount, lockEpochs);
      if (result === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, {
        accountId: result.accountId.toString(),
        txHash: result.txHash,
        blockNumber: result.blockNumber,
        committedTokens: ethers.formatEther(amount),
        lockEpochs,
      });
    } catch (err: any) {
      return jsonResponse(res, 500, {
        error: `createConvictionAccount failed: ${err?.message ?? String(err)}`,
      });
    }
  }

  // POST /api/pca/:id/authorize — admin-gated; the daemon's EOA must be
  // the PCA admin. Body: { key: "0x..." }
  if (req.method === 'POST' && /^\/api\/pca\/[^/]+\/authorize$/.test(path)) {
    const idStr = decodeURIComponent(path.split('/')[3] ?? '');
    const accountId = parseAccountId(idStr);
    if (accountId === null) {
      return jsonResponse(res, 400, { error: 'Invalid accountId — must be a non-negative integer' });
    }
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body);
    if (!parsed.ok) return jsonResponse(res, 400, { error: parsed.error });
    const { key } = parsed.value ?? {};
    if (typeof key !== 'string' || !ethers.isAddress(key)) {
      return jsonResponse(res, 400, { error: 'key must be a valid 0x-prefixed EVM address' });
    }
    try {
      const result = await agent.addPCAAuthorizedKey(accountId, key);
      if (result === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      const verified = (await agent.isPCAAuthorizedKey(accountId, key)) ?? null;
      return jsonResponse(res, 200, {
        accountId: idStr,
        key,
        authorized: verified === true,
        txHash: result.txHash,
        blockNumber: result.blockNumber,
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      // Surface the contract's NotAccountAdmin revert as 403 so callers
      // can distinguish "wrong daemon EOA" from "RPC failure" without
      // string-sniffing.
      if (/NotAccountAdmin|admin/i.test(msg)) {
        return jsonResponse(res, 403, {
          error: 'NotAccountAdmin — daemon EOA is not the PCA admin',
          accountId: idStr,
        });
      }
      return jsonResponse(res, 500, { error: `addAuthorizedKey failed: ${msg}` });
    }
  }

  // POST /api/pca/:id/funds — top-up a PCA. Admin-gated. Body: { tokens: "50000" }
  if (req.method === 'POST' && /^\/api\/pca\/[^/]+\/funds$/.test(path)) {
    const idStr = decodeURIComponent(path.split('/')[3] ?? '');
    const accountId = parseAccountId(idStr);
    if (accountId === null) {
      return jsonResponse(res, 400, { error: 'Invalid accountId — must be a non-negative integer' });
    }
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body);
    if (!parsed.ok) return jsonResponse(res, 400, { error: parsed.error });
    const { tokens } = parsed.value ?? {};
    const amount = parseTokenAmount(tokens, 'tokens');
    if (typeof amount !== 'bigint') return jsonResponse(res, 400, amount);
    try {
      const result = await agent.addPublishingConvictionAccountFunds(accountId, amount);
      if (result === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, {
        accountId: idStr,
        addedTokens: ethers.formatEther(amount),
        txHash: result.txHash,
        blockNumber: result.blockNumber,
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (/NotAccountAdmin|admin/i.test(msg)) {
        return jsonResponse(res, 403, {
          error: 'NotAccountAdmin — daemon EOA is not the PCA admin',
          accountId: idStr,
        });
      }
      return jsonResponse(res, 500, { error: `addConvictionFunds failed: ${msg}` });
    }
  }

  // GET /api/pca/:id — read-only PCA snapshot (admin, balance, conviction,
  // current discount). Optional ?key=0x... probes whether `key` is
  // currently on the account's `authorizedKeys` set.
  if (req.method === 'GET' && /^\/api\/pca\/[^/]+$/.test(path)) {
    const idStr = decodeURIComponent(path.split('/')[3] ?? '');
    const accountId = parseAccountId(idStr);
    if (accountId === null) {
      return jsonResponse(res, 400, { error: 'Invalid accountId — must be a non-negative integer' });
    }
    try {
      const info = await agent.getPublishingConvictionAccountInfo(accountId);
      if (info === null) {
        // Either the chain adapter doesn't expose the view, or the
        // account doesn't exist. The adapter contract returns null
        // for both — distinguish by probing the method itself.
        if (typeof (agent as any).chain?.getConvictionAccountInfo !== 'function') {
          return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
        }
        return jsonResponse(res, 404, { error: `Unknown PCA accountId ${idStr}` });
      }
      const probedKey = ctx.url.searchParams.get('key');
      const result: Record<string, unknown> = serializeAccountInfo(info);
      if (probedKey) {
        if (!ethers.isAddress(probedKey)) {
          result.probedKey = { key: probedKey, error: 'invalid EVM address' };
        } else {
          const isAuth = await agent.isPCAAuthorizedKey(accountId, probedKey);
          result.probedKey = {
            key: probedKey,
            authorized: isAuth === true,
            adapterSupported: isAuth !== null,
          };
        }
      }
      return jsonResponse(res, 200, result);
    } catch (err: any) {
      return jsonResponse(res, 500, {
        error: `getConvictionAccountInfo failed: ${err?.message ?? String(err)}`,
      });
    }
  }
}
