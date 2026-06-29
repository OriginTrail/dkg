// V10 Publishing Conviction NFT operator routes (see ARCHITECTURE.md
// § #519). Owner-gated writes: owner revert → 403, no-chain → 503.

import { ethers } from 'ethers';
import {
  isPcaUnavailableError,
  type V10PublishingConvictionAccountInfo,
} from '@origintrail-official/dkg-chain';
import { jsonResponse, readBody, SMALL_BODY_BYTES, respondIfChainRpcTransportError } from '../http-utils.js';
import type { RequestContext } from './context.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const FEATURE_UNAVAILABLE_503 = {
  error:
    'Chain adapter does not expose V10 Publishing Conviction NFT methods — ' +
    'PCA management is not available on this deployment',
};

function safeParseJson(body: string): { ok: true; value: any } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (e: any) {
    return { ok: false, error: `Invalid JSON: ${e?.message ?? String(e)}` };
  }
}

// Owner-gated write by a non-owner daemon EOA → 403 (distinct from 500
// RPC / 503 no-chain). `NotAccountAdmin` kept for legacy parity.
function isOwnerRevert(msg: string): boolean {
  return /NotAccountOwner|NotAccountAdmin/i.test(msg);
}

// NoChainAdapter throws `noChain()` instead of returning null → 503.
function isNoChain(msg: string): boolean {
  return /No blockchain configured/i.test(msg);
}

// DKGPublishingConvictionNFT undeployed on the Hub → 503 (capability
// gap, not a caller error). Typed error first, message fallback second.
function isPcaUnavailable(err: unknown, msg: string): boolean {
  return isPcaUnavailableError(err) || /not deployed on this Hub/i.test(msg);
}

// Deterministic PCA contract custom-error reverts → 4xx so clients can
// tell a bad request from a retryable outage. ethers wraps the name.
function classifyPcaRevert(msg: string): { status: number; error: string } | null {
  if (/\bInvalidAmount\b/.test(msg)) return { status: 400, error: 'InvalidAmount' };
  if (/\bZeroAgentAddress\b/.test(msg)) return { status: 400, error: 'ZeroAgentAddress' };
  if (/\bTokenTransferFailed\b/.test(msg)) return { status: 400, error: 'TokenTransferFailed' };
  if (/\bAgentAlreadyRegistered\b/.test(msg)) return { status: 409, error: 'AgentAlreadyRegistered' };
  if (/\bAgentNotRegistered\b/.test(msg)) return { status: 409, error: 'AgentNotRegistered' };
  if (/\bAgentCapReached\b/.test(msg)) return { status: 409, error: 'AgentCapReached' };
  if (/\bAccountExpired\b/.test(msg)) return { status: 409, error: 'AccountExpired' };
  if (/\bAccountAlreadyFullySettled\b/.test(msg)) return { status: 409, error: 'AccountAlreadyFullySettled' };
  // OT-RFC-51 primary-node reverts. `PrimaryNodeNotInShardingTable` is reachable
  // from POST /api/pca (createAccount validates a non-zero node against the
  // sharding table) → a bad-but-well-formed node id is a 400, not a 500. The
  // rest are setPrimaryNode-only (re-designation, not yet wired via the daemon)
  // but classified here so they map cleanly the moment that route lands.
  if (/\bPrimaryNodeNotInShardingTable\b/.test(msg)) return { status: 400, error: 'PrimaryNodeNotInShardingTable' };
  if (/\bZeroPrimaryNode\b/.test(msg)) return { status: 400, error: 'ZeroPrimaryNode' };
  if (/\bPrimaryNodeUnchanged\b/.test(msg)) return { status: 409, error: 'PrimaryNodeUnchanged' };
  if (/\bPrimaryNodeChangeRateLimited\b/.test(msg)) return { status: 409, error: 'PrimaryNodeChangeRateLimited' };
  // OZ v5 _requireOwned on an unminted NFT id → caller mistake, 404.
  // Legacy string-revert fallback for older OZ ERC721 builds.
  if (/\bERC721NonexistentToken\b/.test(msg) ||
      /nonexistent token|owner query for nonexistent token|ERC721: invalid token ID/i.test(msg)) {
    return { status: 404, error: 'UnknownAccount' };
  }
  return null;
}

// B10: resolve WHICH account already holds `agentAddr` for an
// AgentAlreadyRegistered conflict, so the UI can deep-link ("approved on
// PCA #N — deregister it there first"). Primary: the decoded revert arg —
// `enrichEvmError` (run on every pcaWrite) sets `err.revert.args` from
// AgentAlreadyRegistered(agent, existingAccountId). Fallback: some RPCs strip
// revert data, so resolve via the on-chain reverse map. NEVER throws — a
// failed lookup must not mask the 409; it just omits `existingAccountId`.
// Returns the id string only when resolvable and > 0n.
async function resolveConflictingAccountId(
  err: any,
  agentAddr: string,
  agent: { getConvictionAgentAccountId(agent: string, opts?: { strict?: boolean }): Promise<bigint | null> },
): Promise<string | undefined> {
  let existing: bigint | null = null;
  const rv: any = err?.revert;
  if (rv?.name === 'AgentAlreadyRegistered') {
    const raw = rv.args?.existingAccountId ?? rv.args?.[1];
    if (raw != null) { try { existing = BigInt(raw); } catch { /* unparseable arg */ } }
  }
  if (existing == null || existing <= 0n) {
    try {
      const viaMap = await agent.getConvictionAgentAccountId(agentAddr);
      if (viaMap != null && viaMap > 0n) existing = viaMap;
    } catch { /* reverse-map fallback is best-effort; never mask the 409 */ }
  }
  return existing != null && existing > 0n ? existing.toString() : undefined;
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

// OT-RFC-51: a PCA's committed TRAC funds the publishing factor P(t) of ONE
// node (`primaryNode`), seeded per-epoch over the lock. The value is that
// node's identityId (uint72). `0` is the contract's "no designated node"
// sentinel — but the daemon does not expose `setPrimaryNode`, so a PCA created
// here with node 0 would be permanently inert (it funds nobody and cannot be
// re-pointed). We therefore REQUIRE an explicit, non-zero node at creation.
const MAX_UINT72 = (1n << 72n) - 1n;

function parsePrimaryNode(raw: unknown): bigint | { error: string } {
  if (typeof raw === 'number') {
    // A uint72 identityId can exceed Number.MAX_SAFE_INTEGER. By the time we
    // see a JSON number, JSON.parse has ALREADY rounded it to the nearest
    // double — so String(raw)/BigInt() below would silently read a different
    // node. Only safe-integer numbers survive losslessly; larger ids must come
    // as strings.
    if (!Number.isSafeInteger(raw)) {
      return { error: 'primaryNode exceeds JSON safe-integer range — pass the node identityId as a string' };
    }
  } else if (typeof raw !== 'string') {
    return { error: 'primaryNode is required: the node identityId (uint72) this PCA allocates publishing to' };
  }
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) {
    return { error: 'primaryNode must be a positive integer node identityId' };
  }
  let id: bigint;
  try {
    id = BigInt(s);
  } catch (e: any) {
    return { error: `primaryNode parse error: ${e?.message ?? String(e)}` };
  }
  if (id <= 0n) {
    return { error: 'primaryNode must be > 0 (0 designates no node; daemon-created PCAs must allocate to a node)' };
  }
  if (id > MAX_UINT72) return { error: 'primaryNode exceeds the uint72 node identityId range' };
  return id;
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

function serializeAccountInfo(
  accountId: bigint,
  info: V10PublishingConvictionAccountInfo,
): Record<string, unknown> {
  return {
    accountId: accountId.toString(),
    owner: info.owner,
    committedTRAC: info.committedTRAC.toString(),
    committedTRACTrac: ethers.formatEther(info.committedTRAC),
    baseEpochAllowance: info.baseEpochAllowance.toString(),
    topUpBuffer: info.topUpBuffer.toString(),
    topUpBufferTrac: ethers.formatEther(info.topUpBuffer),
    createdAtEpoch: info.createdAtEpoch,
    expiresAtEpoch: info.expiresAtEpoch,
    createdAtTimestamp: info.createdAtTimestamp,
    expiresAtTimestamp: info.expiresAtTimestamp,
    discountBps: info.discountBps,
    agentCount: info.agentCount,
    lastSettledWindow: info.lastSettledWindow,
    fullySwept: info.fullySwept,
  };
}

export async function handlePcaRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, path } = ctx;

  if (!path.startsWith('/api/pca')) return;

  // POST /api/pca — mint a conviction NFT to the daemon EOA (the owner).
  // No `lockEpochs` (global protocol param). Body: { tokens: "100000",
  // primaryNode: "42" } — `primaryNode` (the node identityId this PCA funds,
  // OT-RFC-51) is REQUIRED; see parsePrimaryNode for why node 0 is rejected.
  if (req.method === 'POST' && path === '/api/pca') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body);
    if (!parsed.ok) return jsonResponse(res, 400, { error: parsed.error });
    const { tokens, primaryNode } = parsed.value ?? {};
    const amount = parseTokenAmount(tokens, 'tokens');
    if (typeof amount !== 'bigint') return jsonResponse(res, 400, amount);
    const node = parsePrimaryNode(primaryNode);
    if (typeof node !== 'bigint') return jsonResponse(res, 400, node);
    try {
      const result = await agent.createPublishingConvictionAccount(amount, node);
      if (result === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, {
        accountId: result.accountId.toString(),
        txHash: result.hash,
        blockNumber: result.blockNumber,
        committedTokens: ethers.formatEther(amount),
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (isNoChain(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (isPcaUnavailable(err, msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (respondIfChainRpcTransportError(res, err)) return;
      const revert = classifyPcaRevert(msg);
      if (revert) return jsonResponse(res, revert.status, { error: revert.error });
      return jsonResponse(res, 500, {
        error: `createPublishingConvictionAccount failed: ${msg}`,
      });
    }
  }

  // POST /api/pca/:id/agent — register a publishing agent. Owner-gated;
  // the daemon's EOA must be the PCA NFT owner. Body: { agent: "0x..." }
  if (req.method === 'POST' && /^\/api\/pca\/[^/]+\/agent$/.test(path)) {
    const idStr = decodeURIComponent(path.split('/')[3] ?? '');
    const accountId = parseAccountId(idStr);
    if (accountId === null) {
      return jsonResponse(res, 400, { error: 'Invalid accountId — must be a non-negative integer' });
    }
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body);
    if (!parsed.ok) return jsonResponse(res, 400, { error: parsed.error });
    const { agent: agentAddr } = parsed.value ?? {};
    if (typeof agentAddr !== 'string' || !ethers.isAddress(agentAddr)) {
      return jsonResponse(res, 400, { error: 'agent must be a valid 0x-prefixed EVM address' });
    }
    // Fast-reject zero address before any RPC; ZeroAgentAddress→400 in
    // classifyPcaRevert remains as defense-in-depth.
    if (agentAddr.toLowerCase() === ZERO) {
      return jsonResponse(res, 400, { error: 'agent must not be the zero address' });
    }
    try {
      const result = await agent.registerPublishingConvictionAgent(accountId, agentAddr);
      if (result === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      // Tx mined → authoritative 200. Verification is best-effort: own
      // try/catch keeps a probe failure off the outer catch (no false 500).
      let verified: boolean | null = null;
      try {
        verified = await agent.isPublishingConvictionAgent(accountId, agentAddr);
      } catch {
        verified = null;
      }
      return jsonResponse(res, 200, {
        accountId: idStr,
        agent: agentAddr,
        registered: verified === true,
        adapterSupported: verified !== null,
        txHash: result.hash,
        blockNumber: result.blockNumber,
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (isNoChain(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (isPcaUnavailable(err, msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (respondIfChainRpcTransportError(res, err)) return;
      if (isOwnerRevert(msg)) {
        return jsonResponse(res, 403, {
          error: 'NotAccountOwner — daemon EOA is not the PCA owner',
          accountId: idStr,
        });
      }
      const revert = classifyPcaRevert(msg);
      if (revert) {
        const body: Record<string, unknown> = { error: revert.error, accountId: idStr };
        if (revert.error === 'AgentAlreadyRegistered') {
          const existingAccountId = await resolveConflictingAccountId(err, agentAddr, agent);
          if (existingAccountId) body.existingAccountId = existingAccountId;
        }
        return jsonResponse(res, revert.status, body);
      }
      return jsonResponse(res, 500, { error: `registerPublishingConvictionAgent failed: ${msg}` });
    }
  }

  // DELETE /api/pca/:id/agent/:address — deregister a publishing agent.
  // Owner-gated; the daemon's EOA must be the PCA NFT owner.
  if (req.method === 'DELETE' && /^\/api\/pca\/[^/]+\/agent\/[^/]+$/.test(path)) {
    const parts = path.split('/');
    const idStr = decodeURIComponent(parts[3] ?? '');
    const agentAddr = decodeURIComponent(parts[5] ?? '');
    const accountId = parseAccountId(idStr);
    if (accountId === null) {
      return jsonResponse(res, 400, { error: 'Invalid accountId — must be a non-negative integer' });
    }
    if (!ethers.isAddress(agentAddr)) {
      return jsonResponse(res, 400, { error: 'agent must be a valid 0x-prefixed EVM address' });
    }
    // Fast-reject zero address before any RPC; ZeroAgentAddress→400 in
    // classifyPcaRevert remains as defense-in-depth.
    if (agentAddr.toLowerCase() === ZERO) {
      return jsonResponse(res, 400, { error: 'agent must not be the zero address' });
    }
    try {
      const result = await agent.deregisterPublishingConvictionAgent(accountId, agentAddr);
      if (result === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, {
        accountId: idStr,
        agent: agentAddr,
        deregistered: true,
        txHash: result.hash,
        blockNumber: result.blockNumber,
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (isNoChain(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (isPcaUnavailable(err, msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (respondIfChainRpcTransportError(res, err)) return;
      if (isOwnerRevert(msg)) {
        return jsonResponse(res, 403, {
          error: 'NotAccountOwner — daemon EOA is not the PCA owner',
          accountId: idStr,
        });
      }
      const revert = classifyPcaRevert(msg);
      if (revert) return jsonResponse(res, revert.status, { error: revert.error, accountId: idStr });
      return jsonResponse(res, 500, { error: `deregisterPublishingConvictionAgent failed: ${msg}` });
    }
  }

  // POST /api/pca/:id/funds — top-up a PCA. Owner-gated. Body: { tokens: "50000" }
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
      const result = await agent.topUpPublishingConvictionAccount(accountId, amount);
      if (result === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, {
        accountId: idStr,
        addedTokens: ethers.formatEther(amount),
        txHash: result.hash,
        blockNumber: result.blockNumber,
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (isNoChain(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (isPcaUnavailable(err, msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (respondIfChainRpcTransportError(res, err)) return;
      if (isOwnerRevert(msg)) {
        return jsonResponse(res, 403, {
          error: 'NotAccountOwner — daemon EOA is not the PCA owner',
          accountId: idStr,
        });
      }
      const revert = classifyPcaRevert(msg);
      if (revert) return jsonResponse(res, revert.status, { error: revert.error, accountId: idStr });
      return jsonResponse(res, 500, { error: `topUpPublishingConvictionAccount failed: ${msg}` });
    }
  }

  // POST /api/pca/:id/settle — run the lazy-settlement sweep. The
  // contract method is permissionless, so no owner gating here.
  if (req.method === 'POST' && /^\/api\/pca\/[^/]+\/settle$/.test(path)) {
    const idStr = decodeURIComponent(path.split('/')[3] ?? '');
    const accountId = parseAccountId(idStr);
    if (accountId === null) {
      return jsonResponse(res, 400, { error: 'Invalid accountId — must be a non-negative integer' });
    }
    try {
      const result = await agent.settlePublishingConvictionAccount(accountId);
      if (result === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, {
        accountId: idStr,
        settled: true,
        txHash: result.hash,
        blockNumber: result.blockNumber,
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (isNoChain(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (isPcaUnavailable(err, msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (respondIfChainRpcTransportError(res, err)) return;
      const revert = classifyPcaRevert(msg);
      if (revert) return jsonResponse(res, revert.status, { error: revert.error, accountId: idStr });
      return jsonResponse(res, 500, { error: `settlePublishingConvictionAccount failed: ${msg}` });
    }
  }

  // GET /api/pca/agent/:address — reverse-lookup which PCA a wallet is a
  // registered publishing agent of (GAP-3, for S5/S6 discovery). Returns the
  // bare on-chain `agentToAccountId` fact (may be an account this node does
  // NOT track — that is the point for edge discovery); the UI routes the id
  // through coverage classification, never treating "registered" as "covered".
  // Two-segment path: no collision with the generic GET :id, but declared
  // ahead of it for explicit ordering.
  if (req.method === 'GET' && /^\/api\/pca\/agent\/[^/]+$/.test(path)) {
    const addr = decodeURIComponent(path.split('/')[4] ?? '');
    if (!ethers.isAddress(addr)) {
      return jsonResponse(res, 400, { error: 'address must be a valid 0x-prefixed EVM address' });
    }
    // Capability gate (mirror B3 / GET :id): an adapter without the PCA surface
    // answers 503 — never a 200 a UI would read as "registered nowhere".
    if (!agent.supportsPublishingConvictionNft) {
      return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
    }
    try {
      // STRICT discovery read: surfaces NFT-undeployed (PcaUnavailableError →
      // 503) and read failures (CALL_EXCEPTION → 503) instead of the selector's
      // fail-safe 0n. Otherwise a transient blip would resolve `accountId:null`
      // = a CONFIRMED "registered nowhere", flipping a covered wallet to a
      // false-DANGER fall-through in S5 (#9). A 0n from a healthy read is a
      // genuine "unregistered" → accountId:null.
      const accountId = await agent.getConvictionAgentAccountId(addr, { strict: true });
      if (accountId === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, {
        agent: ethers.getAddress(addr),
        accountId: accountId > 0n ? accountId.toString() : null,
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (isNoChain(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (isPcaUnavailable(err, msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (respondIfChainRpcTransportError(res, err)) return;
      // A CALL_EXCEPTION on the mapping getter is a real read failure (the
      // getter never reverts for an unregistered address) → 503 retryable, NOT
      // a 200 the UI would read as a confirmed "registered nowhere".
      if (err?.code === 'CALL_EXCEPTION') {
        return jsonResponse(res, 503, {
          error: 'PCA agent lookup temporarily unavailable — chain read failed',
          code: 'PCA_LOOKUP_READ_FAILED',
        });
      }
      return jsonResponse(res, 500, {
        error: `getConvictionAgentAccountId failed: ${msg}`,
      });
    }
  }

  // GET /api/pca/:id/agents — enumerate the operational wallets registered
  // as publishing agents on this PCA (B3). Mirrors the GET :id existence
  // check first, so an unknown account is a 404 (not an empty list): a 200
  // with `agents: []` means the account EXISTS but has no approved wallets.
  // Declared before the generic GET :id below (it matches single-segment ids
  // only, but the explicit ordering keeps the two-segment route unambiguous).
  if (req.method === 'GET' && /^\/api\/pca\/[^/]+\/agents$/.test(path)) {
    const idStr = decodeURIComponent(path.split('/')[3] ?? '');
    const accountId = parseAccountId(idStr);
    if (accountId === null) {
      return jsonResponse(res, 400, { error: 'Invalid accountId — must be a non-negative integer' });
    }
    try {
      // Existence gate (mirror GET :id): null = view absent OR account
      // missing; the facade capability signal disambiguates 503 vs 404.
      const info = await agent.getPublishingConvictionAccountInfo(accountId);
      if (info === null) {
        if (!agent.supportsPublishingConvictionNft) {
          return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
        }
        return jsonResponse(res, 404, { error: `Unknown PCA accountId ${idStr}` });
      }
      const agents = await agent.getPublishingConvictionAgents(accountId);
      // getInfo succeeded but the adapter lacks the enumerator → capability gap.
      if (agents === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, { accountId: idStr, agents });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (isNoChain(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (isPcaUnavailable(err, msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (respondIfChainRpcTransportError(res, err)) return;
      const revert = classifyPcaRevert(msg);
      if (revert) return jsonResponse(res, revert.status, { error: revert.error, accountId: idStr });
      return jsonResponse(res, 500, {
        error: `getPublishingConvictionAgents failed: ${msg}`,
      });
    }
  }

  // GET /api/pca/:id — V10 conviction NFT snapshot. Optional ?key=0x...
  // probes whether that address is a registered agent.
  if (req.method === 'GET' && /^\/api\/pca\/[^/]+$/.test(path)) {
    const idStr = decodeURIComponent(path.split('/')[3] ?? '');
    const accountId = parseAccountId(idStr);
    if (accountId === null) {
      return jsonResponse(res, 400, { error: 'Invalid accountId — must be a non-negative integer' });
    }
    try {
      const info = await agent.getPublishingConvictionAccountInfo(accountId);
      if (info === null) {
        // null = view absent OR account missing; the facade capability
        // signal disambiguates (no chain surface → 503, else genuine 404).
        if (!agent.supportsPublishingConvictionNft) {
          return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
        }
        return jsonResponse(res, 404, { error: `Unknown PCA accountId ${idStr}` });
      }
      const probedKey = ctx.url.searchParams.get('key');
      const result: Record<string, unknown> = serializeAccountInfo(accountId, info);
      if (probedKey) {
        if (!ethers.isAddress(probedKey)) {
          result.probedKey = { key: probedKey, error: 'invalid EVM address' };
        } else {
          const isAgent = await agent.isPublishingConvictionAgent(accountId, probedKey);
          result.probedKey = {
            key: probedKey,
            registered: isAgent === true,
            adapterSupported: isAgent !== null,
          };
        }
      }
      return jsonResponse(res, 200, result);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (isNoChain(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (isPcaUnavailable(err, msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (respondIfChainRpcTransportError(res, err)) return;
      return jsonResponse(res, 500, {
        error: `getPublishingConvictionAccountInfo failed: ${msg}`,
      });
    }
  }
}
