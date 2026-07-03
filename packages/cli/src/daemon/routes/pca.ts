// V10 Publishing Conviction NFT operator routes (see ARCHITECTURE.md
// § #519). Owner-gated writes: owner revert → 403, no-chain → 503.

import { ethers } from 'ethers';
import {
  isPcaUnavailableError,
  type PcaContracts,
  type PcaRpcMethod,
  type V10PublishingConvictionAccountInfo,
} from '@origintrail-official/dkg-chain';
import {
  classifyChainRpcTransportStatus,
  jsonResponse,
  readBody,
  SMALL_BODY_BYTES,
  respondIfChainRpcTransportError,
  sanitizeRpcMessage,
} from '../http-utils.js';
import type { RequestContext } from './context.js';
import { parseUint72Decimal } from '@origintrail-official/dkg-core';
import { pcaConfirmationToWire, type RegisterPcaAgentResponse } from '../../pca-confirmation-wire.js';
import type { PcaConfirmationOutcome } from '@origintrail-official/dkg-agent';

const ZERO = '0x0000000000000000000000000000000000000000';
const PCA_RPC_PROXY_PATH = '/api/pca/rpc';
const PCA_RPC_ALLOWED_METHODS = new Set<PcaRpcMethod>([
  'eth_chainId',
  'eth_call',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_blockNumber',
  'eth_getBlockByNumber',
]);
const PCA_RPC_NULL_RESULT_METHODS = new Set<PcaRpcMethod>([
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_getBlockByNumber',
]);
const PCA_RPC_NFT_CALL_SELECTORS = new Set([
  '0x70a08231', // balanceOf(address)
  '0x2f745c59', // tokenOfOwnerByIndex(address,uint256)
  '0x6352211e', // ownerOf(uint256)
  '0xfe57623b', // getDiscountBps(uint96)
]);
const PCA_RPC_TOKEN_CALL_SELECTORS = new Set([
  '0x70a08231', // balanceOf(address)
  '0xdd62ed3e', // allowance(address,address)
]);
const PCA_RPC_MAX_BATCH = 20;
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

// PCA RPC proxy guard: allow the browser HW layer's bounded read calls only.
// Unsupported methods fail before any adapter delegation.
type JsonRpcId = string | number | null;

function jsonRpcId(value: unknown): JsonRpcId {
  return typeof value === 'string' || typeof value === 'number' || value === null ? value : null;
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

function jsonRpcSuccess(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function isPcaRpcMethod(method: string): method is PcaRpcMethod {
  return PCA_RPC_ALLOWED_METHODS.has(method as PcaRpcMethod);
}

function walletRpcUrlsForResponse(contracts: PcaContracts): string[] {
  return (contracts.walletRpcUrls ?? []).filter((rpcUrl) => /^https?:\/\//i.test(rpcUrl));
}

function supportsPcaRpcBridge(agent: RequestContext['agent']): boolean {
  const candidate = agent as RequestContext['agent'] & {
    supportsPublishingConvictionRpc?: unknown;
    requestPublishingConvictionRpc?: unknown;
  };
  if (typeof candidate.supportsPublishingConvictionRpc === 'boolean') {
    return candidate.supportsPublishingConvictionRpc;
  }
  return typeof candidate.requestPublishingConvictionRpc === 'function';
}

function pcaRpcEthCallError(params: unknown[] | undefined, contracts: Pick<PcaContracts, 'nft' | 'token'>): string | null {
  if (!Array.isArray(params) || params.length === 0) return 'PCA RPC eth_call params must include a transaction object';
  const tx = params[0];
  if (!tx || typeof tx !== 'object' || Array.isArray(tx)) return 'PCA RPC eth_call params must include a transaction object';
  const { to, data } = tx as { to?: unknown; data?: unknown };
  if (typeof to !== 'string' || typeof data !== 'string' || !/^0x[0-9a-fA-F]+$/.test(data) || data.length < 10) {
    return 'PCA RPC eth_call requires a target address and function selector';
  }
  let target: string;
  let nft: string;
  let token: string;
  try {
    target = ethers.getAddress(to).toLowerCase();
    nft = ethers.getAddress(contracts.nft).toLowerCase();
    token = ethers.getAddress(contracts.token).toLowerCase();
  } catch {
    return 'PCA RPC eth_call target address is invalid';
  }
  const selector = data.slice(0, 10).toLowerCase();
  if (target === nft && PCA_RPC_NFT_CALL_SELECTORS.has(selector)) return null;
  if (target === token && PCA_RPC_TOKEN_CALL_SELECTORS.has(selector)) return null;
  return 'PCA RPC eth_call target or selector is not allowed';
}

function isHex32(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isBlockQuantity(value: unknown): value is string {
  return typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value);
}

function pcaRpcParamsError(method: PcaRpcMethod, params: unknown[] | undefined): string | null {
  const p = params ?? [];
  switch (method) {
    case 'eth_chainId':
    case 'eth_blockNumber':
      return p.length === 0 ? null : `PCA RPC ${method} does not accept params`;
    case 'eth_getTransactionReceipt':
    case 'eth_getTransactionByHash':
      return p.length === 1 && isHex32(p[0]) ? null : `PCA RPC ${method} requires one 32-byte transaction hash`;
    case 'eth_getBlockByNumber': {
      if (p.length !== 2) return 'PCA RPC eth_getBlockByNumber requires block id and includeTransactions=false';
      const block = p[0];
      const includeTransactions = p[1];
      const namedBlock = block === 'latest' || block === 'safe' || block === 'finalized';
      const exactBlock = isBlockQuantity(block);
      const allowed =
        (namedBlock && includeTransactions === false) ||
        (exactBlock && (includeTransactions === false || includeTransactions === true));
      if (!allowed) {
        return 'PCA RPC eth_getBlockByNumber only allows latest/safe/finalized with includeTransactions=false, or exact hex block ids with includeTransactions true/false';
      }
      return null;
    }
    case 'eth_call':
      if (p.length < 1 || p.length > 2) return 'PCA RPC eth_call requires a transaction object and optional block id';
      if (p.length === 2) {
        const block = p[1];
        const allowedBlock = block === 'latest' || block === 'safe' || block === 'finalized' || isBlockQuantity(block);
        if (!allowedBlock) return 'PCA RPC eth_call only allows latest/safe/finalized or hex block ids';
      }
      return null;
  }
}

async function handlePcaRpcRequest(
  agent: RequestContext['agent'],
  raw: unknown,
): Promise<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return jsonRpcError(null, -32600, 'Invalid JSON-RPC request');
  }
  const request = raw as { id?: unknown; method?: unknown; params?: unknown };
  const id = jsonRpcId(request.id ?? null);
  if (typeof request.method !== 'string' || request.method.length === 0) {
    return jsonRpcError(id, -32600, 'Invalid JSON-RPC method');
  }
  if (!isPcaRpcMethod(request.method)) {
    return jsonRpcError(id, -32601, `PCA RPC method not allowed: ${request.method}`);
  }
  if (request.params !== undefined && !Array.isArray(request.params)) {
    return jsonRpcError(id, -32602, 'PCA RPC params must be an array');
  }
  const paramsError = pcaRpcParamsError(request.method, request.params);
  if (paramsError) return jsonRpcError(id, -32602, paramsError);
  try {
    if (request.method === 'eth_call') {
      const contracts = await agent.getPublishingConvictionContracts();
      if (contracts === null) return jsonRpcError(id, -32004, FEATURE_UNAVAILABLE_503.error);
      const ethCallError = pcaRpcEthCallError(request.params, contracts);
      if (ethCallError) return jsonRpcError(id, -32602, ethCallError);
    }
    const result = await agent.requestPublishingConvictionRpc(request.method, request.params ?? []);
    if (result === null && !PCA_RPC_NULL_RESULT_METHODS.has(request.method)) {
      return jsonRpcError(id, -32004, FEATURE_UNAVAILABLE_503.error);
    }
    return jsonRpcSuccess(id, result);
  } catch (err: any) {
    const transport = classifyChainRpcTransportStatus(err);
    if (transport) {
      return jsonRpcError(id, -32002, String(transport.body.error ?? 'Chain RPC transport unavailable'), {
        code: transport.body.code,
        ...(transport.body.txHash ? { txHash: transport.body.txHash } : {}),
      });
    }
    const msg = sanitizeRpcMessage(err?.message ?? String(err));
    if (isNoChain(msg) || isPcaUnavailable(err, msg)) {
      return jsonRpcError(id, -32004, FEATURE_UNAVAILABLE_503.error);
    }
    return jsonRpcError(id, -32000, `PCA RPC read failed: ${msg}`);
  }
}

// Owner-gated write by a non-owner daemon EOA -> 403 (distinct from 500
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
  // `UnknownAccount`/`NoConvictionAccount` are the PublishingConviction-logic
  // forms (e.g. settle() forwards directly without _requireOwned); enrichEvmError
  // decodes the logic name into the message so this matches on the write paths.
  if (/\bERC721NonexistentToken\b/.test(msg) ||
      /\bUnknownAccount\b/.test(msg) || /\bNoConvictionAccount\b/.test(msg) ||
      /nonexistent token|owner query for nonexistent token|ERC721: invalid token ID/i.test(msg)) {
    return { status: 404, error: 'UnknownAccount' };
  }
  return null;
}

function positiveAccountIdString(value: unknown): string | null {
  if (typeof value === 'bigint') return value > 0n ? value.toString() : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  return null;
}

function agentAlreadyRegisteredAccountIdFromError(err: any, msg: string): string | null {
  const args = err?.revert?.args;
  const named = positiveAccountIdString(args?.existingAccountId ?? args?.accountId);
  if (named) return named;
  if (Array.isArray(args)) {
    const positional = positiveAccountIdString(args[1]);
    if (positional) return positional;
  }
  const match = /\bAgentAlreadyRegistered\s*\([^,]+,\s*([0-9]+)\s*\)/.exec(msg);
  return match ? positiveAccountIdString(match[1]) : null;
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
  const parsed = parseUint72Decimal(s);
  if (!parsed.ok) {
    if (parsed.reason === 'range') {
      return { error: 'primaryNode exceeds the uint72 node identityId range' };
    }
    return {
      error: parsed.message
        ? `primaryNode parse error: ${parsed.message}`
        : 'primaryNode must be a positive integer node identityId',
    };
  }
  const id = parsed.value;
  if (id <= 0n) {
    return { error: 'primaryNode must be > 0 (0 designates no node; daemon-created PCAs must allocate to a node)' };
  }
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
  extra?: { primaryNode?: bigint | null; fundsThisNode?: boolean; owned?: boolean },
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
    // GAP-4/5 - present only on the extended read (S3 budget widget); omitted
    // (not zeroed) when absent so the UI can tell "unknown" from a real value.
    ...(info.primaryNode !== undefined ? { primaryNode: info.primaryNode.toString() } : {}),
    ...(info.lastPrimaryNodeChangeEpoch !== undefined ? { lastPrimaryNodeChangeEpoch: info.lastPrimaryNodeChangeEpoch } : {}),
    ...(info.remainingAllowance !== undefined
      ? { remainingAllowance: info.remainingAllowance.toString(), remainingAllowanceTrac: ethers.formatEther(info.remainingAllowance) }
      : {}),
    ...(info.currentEpoch !== undefined ? { currentEpoch: info.currentEpoch } : {}),
    // OT-RFC-51 node association: the node identityId this PCA funds.
    // `0` = unset. `fundsThisNode` is true when it equals this node's identity.
    ...(extra?.primaryNode != null ? { primaryNode: extra.primaryNode.toString() } : {}),
    ...(extra?.fundsThisNode !== undefined ? { fundsThisNode: extra.fundsThisNode } : {}),
    // Whether this PCA is owned (and thus manageable) by this node's wallets.
    ...(extra?.owned !== undefined ? { owned: extra.owned } : {}),
  };
}

/**
 * #1346 — POST /api/pca/:id/agent orchestration + response assembly, kept as a
 * route-local helper so the handler stays parse/dispatch. Returns the status +
 * body the route serializes (input validation and chain-error classification
 * stay in the route). Paths: `null` chain surface → 503; a mined-but-reverted
 * tx (`success:false`) → 502 (never reported as registered); otherwise the mined
 * tx is authoritative (`registered:true`) and the advisory `PcaConfirmationOutcome`
 * is derived to the wire `{ verified, adapterSupported }` here at the boundary.
 */
async function registerPcaAgentResponse(
  agent: {
    registerPublishingConvictionAgent(accountId: bigint, agent: string): Promise<{ hash: string; blockNumber: number; success: boolean } | null>;
    confirmPublishingConvictionAgentRegistration(accountId: bigint, agent: string): Promise<PcaConfirmationOutcome>;
  },
  accountId: bigint,
  agentAddr: string,
  idStr: string,
): Promise<{ status: number; body: RegisterPcaAgentResponse | { error: string } }> {
  const result = await agent.registerPublishingConvictionAgent(accountId, agentAddr);
  if (result === null) return { status: 503, body: FEATURE_UNAVAILABLE_503 };
  if (result.success === false) {
    return { status: 502, body: { error: 'PCA agent registration transaction was mined but did not succeed on-chain' } };
  }
  // Spread the advisory object (do NOT destructure) so its discriminated-union
  // correlation between `verified` and `adapterSupported` is preserved for the
  // typed `RegisterPcaAgentResponse` body.
  const advisory = pcaConfirmationToWire(
    await agent.confirmPublishingConvictionAgentRegistration(accountId, agentAddr),
  );
  return {
    status: 200,
    body: {
      accountId: idStr,
      agent: agentAddr,
      registered: true,
      ...advisory,
      txHash: result.hash,
      blockNumber: result.blockNumber,
    },
  };
}

export async function handlePcaRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, path, config, requestToken, validTokens, opWallets } = ctx;

  if (!path.startsWith('/api/pca')) return;

  // The node can SERVER-MANAGE a PCA only when its ERC-721 owner is the daemon's
  // PRIMARY operational wallet (opWallets.wallets[0]) — that is the single signer
  // every server-side, bearer-token-driven PCA write is signed with. Admin keys
  // and secondary operational wallets cannot drive these writes (the chain
  // adapter holds only the primary signer for the PCA path), so flagging a PCA
  // they own as owned:true would light up a manage UI whose owner-gated writes
  // revert on-chain (ownerOf mismatch), not a clean 403. Ownership for the
  // wallet-connect (client-signed) path is resolved separately in the browser.
  const serverSignerAddr = opWallets.wallets[0]?.address.toLowerCase() ?? null;
  const isOwnedByNode = (owner: string): boolean =>
    serverSignerAddr != null && owner.toLowerCase() === serverSignerAddr;

  // PCA writes are signed with the daemon's OWNER EOA, so the on-chain
  // owner gate is satisfied by the daemon for every node-owned PCA — the
  // bearer token is the only caller gate. Creating/funding/re-pointing a PCA
  // or attaching a publishing agent are operator actions: require a node-level
  // admin token, not a per-agent (dkg_at_) token. Mirrors isNodeAdminCaller in
  // context-graph.ts. Reads and the permissionless `settle` are NOT gated.
  const authEnabled = config.auth?.enabled !== false;
  const isNodeAdmin = (): boolean =>
    !authEnabled ||
    (!!requestToken && validTokens.has(requestToken) && !agent.resolveAgentByToken(requestToken));
  const requireNodeAdmin = (): boolean => {
    if (isNodeAdmin()) return true;
    jsonResponse(res, 403, {
      error: 'Node-admin token required (~/.dkg/auth.token) to manage Publishing Conviction Accounts; agent-scoped tokens cannot drive owner-signed PCA writes.',
    });
    return false;
  };

  // GET /api/pca — list the PCAs owned by this node's operational wallet
  // (ERC721Enumerable), each annotated with its OT-RFC-51 `primaryNode`
  // association and `fundsThisNode`. These are the accounts this node can
  // manage; accounts that fund this node but are owned elsewhere are loadable
  // by id via GET /api/pca/:id.
  if (req.method === 'GET' && path === '/api/pca') {
    try {
      const list = await agent.listNodePublishingConvictionAccounts();
      if (list === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, {
        accounts: list.map((a) =>
          serializeAccountInfo(a.accountId, a.info, {
            primaryNode: a.primaryNode,
            fundsThisNode: a.fundsThisNode,
            owned: true, // the list enumerates accounts owned by this node's wallet
          }),
        ),
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (isNoChain(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (isPcaUnavailable(err, msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (respondIfChainRpcTransportError(res, err)) return;
      return jsonResponse(res, 500, {
        error: `listNodePublishingConvictionAccounts failed: ${msg}`,
      });
    }
  }

  // POST /api/pca — mint a conviction NFT to the daemon EOA (the owner).
  // No `lockEpochs` (global protocol param). Body: { tokens: "100000",
  // primaryNode: "42" } — `primaryNode` (the node identityId this PCA funds,
  // OT-RFC-51) is REQUIRED; see parsePrimaryNode for why node 0 is rejected.
  if (req.method === 'POST' && path === '/api/pca') {
    if (!requireNodeAdmin()) return;
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
    if (!requireNodeAdmin()) return;
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
      // Orchestration + response assembly live in the route-local
      // registerPcaAgentResponse (above); this handler owns input validation +
      // chain-error classification (the catch below).
      const r = await registerPcaAgentResponse(agent, accountId, agentAddr, idStr);
      return jsonResponse(res, r.status, r.body);
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
        if (revert.error === 'AgentAlreadyRegistered') {
          const body: { error: string; accountId: string; existingAccountId?: string } = {
            error: revert.error,
            accountId: idStr,
          };
          const existingFromError = agentAlreadyRegisteredAccountIdFromError(err, msg);
          if (existingFromError) {
            body.existingAccountId = existingFromError;
          } else {
            try {
              const lookup = (agent as any).getConvictionAgentAccountId;
              if (typeof lookup === 'function') {
                const existing = positiveAccountIdString(await lookup.call(agent, agentAddr));
                if (existing) body.existingAccountId = existing;
              }
            } catch {
              // Preserve the deterministic 409 even when the best-effort reverse lookup flakes.
            }
          }
          return jsonResponse(res, revert.status, body);
        }
        return jsonResponse(res, revert.status, { error: revert.error, accountId: idStr });
      }
      return jsonResponse(res, 500, { error: `registerPublishingConvictionAgent failed: ${msg}` });
    }
  }

  // DELETE /api/pca/:id/agent/:address — deregister a publishing agent.
  // Owner-gated; the daemon's EOA must be the PCA NFT owner.
  if (req.method === 'DELETE' && /^\/api\/pca\/[^/]+\/agent\/[^/]+$/.test(path)) {
    if (!requireNodeAdmin()) return;
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
    if (!requireNodeAdmin()) return;
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

  // POST /api/pca/:id/primary-node — OT-RFC-51 owner-gated re-designation of
  // the node this PCA funds. Body: { node: "42" } (required, non-zero uint72).
  // Rate-limited on-chain to once per epoch (→ 409 PrimaryNodeChangeRateLimited).
  if (req.method === 'POST' && /^\/api\/pca\/[^/]+\/primary-node$/.test(path)) {
    if (!requireNodeAdmin()) return;
    const idStr = decodeURIComponent(path.split('/')[3] ?? '');
    const accountId = parseAccountId(idStr);
    if (accountId === null) {
      return jsonResponse(res, 400, { error: 'Invalid accountId — must be a non-negative integer' });
    }
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body);
    if (!parsed.ok) return jsonResponse(res, 400, { error: parsed.error });
    const node = parsePrimaryNode((parsed.value ?? {}).node);
    if (typeof node !== 'bigint') return jsonResponse(res, 400, node);
    try {
      const result = await agent.setPublishingConvictionPrimaryNode(accountId, node);
      if (result === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, {
        accountId: idStr,
        primaryNode: node.toString(),
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
      return jsonResponse(res, 500, { error: `setPublishingConvictionPrimaryNode failed: ${msg}` });
    }
  }

  // GET /api/pca/agent/:address - reverse-lookup which PCA a wallet is a
  // registered publishing agent of (GAP-3, for S5/S6 discovery). Returns the
  // bare on-chain `agentToAccountId` fact; coverage classification happens in
  // the caller, never by treating "registered" as "covered".
  if (req.method === 'GET' && /^\/api\/pca\/agent\/[^/]+$/.test(path)) {
    const addr = decodeURIComponent(path.split('/')[4] ?? '');
    if (!ethers.isAddress(addr)) {
      return jsonResponse(res, 400, { error: 'address must be a valid 0x-prefixed EVM address' });
    }
    if (!agent.supportsPublishingConvictionNft) {
      return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
    }
    try {
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
      if (err?.code === 'CALL_EXCEPTION') {
        return jsonResponse(res, 503, {
          error: 'PCA agent lookup temporarily unavailable - chain read failed',
          code: 'PCA_LOOKUP_READ_FAILED',
        });
      }
      return jsonResponse(res, 500, {
        error: `getConvictionAgentAccountId failed: ${msg}`,
      });
    }
  }

  // GET /api/pca/:id/agents - enumerate the operational wallets registered as
  // publishing agents on this PCA. This is declared before the generic GET :id
  // matcher so an existing account with zero approved wallets returns 200 []
  // while an unknown account returns 404.
  if (req.method === 'GET' && /^\/api\/pca\/[^/]+\/agents$/.test(path)) {
    const idStr = decodeURIComponent(path.split('/')[3] ?? '');
    const accountId = parseAccountId(idStr);
    if (accountId === null) {
      return jsonResponse(res, 400, { error: 'Invalid accountId - must be a non-negative integer' });
    }
    try {
      const info = await agent.getPublishingConvictionAccountInfo(accountId);
      if (info === null) {
        if (!agent.supportsPublishingConvictionNft) {
          return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
        }
        return jsonResponse(res, 404, { error: `Unknown PCA accountId ${idStr}` });
      }
      const agents = await agent.getPublishingConvictionAgents(accountId);
      if (agents === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, { accountId: idStr, agents });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (isNoChain(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (isPcaUnavailable(err, msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (respondIfChainRpcTransportError(res, err)) return;
      if (err?.code === 'CALL_EXCEPTION') {
        return jsonResponse(res, 503, {
          error: 'PCA agent enumeration temporarily unavailable - chain read failed',
          code: 'PCA_LOOKUP_READ_FAILED',
        });
      }
      const revert = classifyPcaRevert(msg);
      if (revert) return jsonResponse(res, revert.status, { error: revert.error, accountId: idStr });
      return jsonResponse(res, 500, {
        error: `getPublishingConvictionAgents failed: ${msg}`,
      });
    }
  }

  // GET /api/pca/mine - enumerate every PCA the node relates to (owned + agent-on
  // across the node's operational wallets). Exact path before the generic :id
  // matcher, otherwise "mine" would parse as an account id.
  if (req.method === 'GET' && path === '/api/pca/mine') {
    if (!agent.supportsPublishingConvictionNft) {
      return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
    }
    const wallets = ctx.opWallets.wallets.map((wallet) => wallet.address);
    try {
      const accounts = await agent.listPublishingConvictionAccountsForWallets(wallets);
      if (accounts === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      const hydrate = ctx.url.searchParams.get('hydrate') === '1';
      if (!hydrate) {
        return jsonResponse(res, 200, {
          accounts: accounts.map((account) => ({
            accountId: account.accountId.toString(),
            relation: account.relation,
          })),
        });
      }

      const hydrated: Array<Record<string, unknown>> = [];
      for (const account of accounts) {
        const entry: Record<string, unknown> = {
          accountId: account.accountId.toString(),
          relation: account.relation,
        };
        try {
          const info = await agent.getPublishingConvictionAccountInfo(account.accountId);
          if (info) Object.assign(entry, serializeAccountInfo(account.accountId, info));
        } catch {
          // Per-account hydration is best-effort; the relation row is still useful.
        }
        hydrated.push(entry);
      }
      return jsonResponse(res, 200, { accounts: hydrated });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (isNoChain(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (isPcaUnavailable(err, msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (respondIfChainRpcTransportError(res, err)) return;
      if (err?.code === 'CALL_EXCEPTION') {
        return jsonResponse(res, 503, {
          error: 'PCA enumeration temporarily unavailable - chain read failed',
          code: 'PCA_LOOKUP_READ_FAILED',
        });
      }
      return jsonResponse(res, 500, {
        error: `listPublishingConvictionAccountsForWallets failed: ${msg}`,
      });
    }
  }

  // GET /api/pca/designatable-nodes - full sharding table of nodes that can be
  // designated as a PCA primary node. ?fresh=1 bypasses adapter cache.
  if (req.method === 'GET' && path === '/api/pca/designatable-nodes') {
    if (!agent.supportsPublishingConvictionNft) {
      return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
    }
    const fresh = ctx.url.searchParams.get('fresh') === '1';
    try {
      const nodes = await agent.listDesignatableNodes({ fresh });
      if (nodes === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, {
        nodes: nodes.map((node) => ({
          nodeId: node.nodeId,
          identityId: node.identityId.toString(),
          ask: node.ask.toString(),
          stake: node.stake.toString(),
        })),
        total: nodes.length,
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (isNoChain(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (isPcaUnavailable(err, msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (respondIfChainRpcTransportError(res, err)) return;
      if (err?.code === 'CALL_EXCEPTION' || err?.code === 'BAD_DATA') {
        return jsonResponse(res, 503, {
          error: 'Designatable-node list temporarily unavailable - sharding-table read failed',
          code: 'SHARDING_TABLE_READ_FAILED',
        });
      }
      return jsonResponse(res, 500, {
        error: `listDesignatableNodes failed: ${msg}`,
      });
    }
  }

  // GET /api/pca/contracts — browser bootstrap (sub-PR #2 HW signing). Hands the
  // in-browser viem layer resolved PCA addresses plus the same-origin daemon RPC
  // proxy. Raw adapter RPC URLs may carry operator API keys, so they remain
  // daemon-internal and never cross this HTTP boundary. Matched EXACTLY before
  // the generic GET :id below, else 'contracts' parses as an accountId and 400s.
  if (req.method === 'GET' && path === '/api/pca/contracts') {
    if (!agent.supportsPublishingConvictionNft || !supportsPcaRpcBridge(agent)) {
      return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
    }
    try {
      const contracts = await agent.getPublishingConvictionContracts();
      if (contracts === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, {
        ...contracts,
        rpcUrls: [PCA_RPC_PROXY_PATH],
        walletRpcUrls: walletRpcUrlsForResponse(contracts),
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (isNoChain(msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (isPcaUnavailable(err, msg)) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      if (respondIfChainRpcTransportError(res, err)) return;
      // A CALL_EXCEPTION/BAD_DATA here is an address-resolution read failure (the
      // adapter may Hub-read) → 503 retryable with a DEDICATED code, NOT a 500 a
      // browser bootstrap would treat as terminal.
      if (err?.code === 'CALL_EXCEPTION' || err?.code === 'BAD_DATA') {
        return jsonResponse(res, 503, {
          error: 'PCA contract addresses temporarily unavailable — chain read failed',
          code: 'CONTRACTS_READ_FAILED',
        });
      }
      return jsonResponse(res, 500, {
        error: `getPublishingConvictionContracts failed: ${sanitizeRpcMessage(msg)}`,
      });
    }
  }

  // POST /api/pca/rpc - restricted JSON-RPC read proxy for the browser HW
  // layer. It forwards only the read methods viem needs for PCA discovery,
  // allowance reads, and receipt polling. It never exposes upstream URLs.
  if (req.method === 'POST' && path === PCA_RPC_PROXY_PATH) {
    if (!agent.supportsPublishingConvictionNft || !supportsPcaRpcBridge(agent)) {
      return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
    }
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body);
    if (!parsed.ok) return jsonResponse(res, 400, { error: parsed.error });
    if (Array.isArray(parsed.value)) {
      if (parsed.value.length === 0) {
        return jsonResponse(res, 400, { error: 'JSON-RPC batch must contain at least one request' });
      }
      if (parsed.value.length > PCA_RPC_MAX_BATCH) {
        return jsonResponse(res, 400, { error: `JSON-RPC batch must contain at most ${PCA_RPC_MAX_BATCH} requests` });
      }
      const responses = await Promise.all(parsed.value.map((item) => handlePcaRpcRequest(agent, item)));
      return jsonResponse(res, 200, responses);
    }
    return jsonResponse(res, 200, await handlePcaRpcRequest(agent, parsed.value));
  }

  // GET /api/pca/:id — V10 conviction NFT snapshot. Optional ?key=0x...
  // probes whether that address is a registered agent. Optional ?extended=1
  // adds the GAP-4/5 budget fields (primaryNode + current-epoch allowance);
  // default-OFF so the hot S1/S5 polling path stays cheap (no extra reads).
  if (req.method === 'GET' && /^\/api\/pca\/[^/]+$/.test(path)) {
    const idStr = decodeURIComponent(path.split('/')[3] ?? '');
    const accountId = parseAccountId(idStr);
    if (accountId === null) {
      return jsonResponse(res, 400, { error: 'Invalid accountId — must be a non-negative integer' });
    }
    try {
      const extended = ctx.url.searchParams.get('extended') === '1';
      const info = await agent.getPublishingConvictionAccountInfo(accountId, { extended });
      if (info === null) {
        // null = view absent OR account missing; the facade capability
        // signal disambiguates (no chain surface → 503, else genuine 404).
        if (!agent.supportsPublishingConvictionNft) {
          return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
        }
        return jsonResponse(res, 404, { error: `Unknown PCA accountId ${idStr}` });
      }
      // OT-RFC-51 node association — a separate read (getAccountInfo omits it).
      // Best-effort: a probe failure must not 500 the snapshot.
      let primaryNode: bigint | null = null;
      try {
        primaryNode = await agent.getConvictionPrimaryNode(accountId);
      } catch {
        primaryNode = null;
      }
      // Annotate fundsThisNode + owned so the UI can highlight the association
      // and disable owner-gated actions for accounts owned elsewhere — this is
      // the lookup-by-id path, which is exactly the cross-owner case.
      let fundsThisNode: boolean | undefined;
      try {
        const myIdentity = await agent.getNodeIdentityId();
        if (primaryNode != null) fundsThisNode = myIdentity !== 0n && primaryNode === myIdentity;
      } catch {
        fundsThisNode = undefined;
      }
      const probedKey = ctx.url.searchParams.get('key');
      const result: Record<string, unknown> = serializeAccountInfo(accountId, info, {
        primaryNode,
        fundsThisNode,
        owned: isOwnedByNode(info.owner),
      });
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
      // A CALL_EXCEPTION on the `isAgent` probe is a read failure (the view
      // returns false for a normal not-approved wallet), so it must stay
      // inconclusive instead of becoming `registered:false`.
      if (err?.code === 'CALL_EXCEPTION') {
        return jsonResponse(res, 503, {
          error: 'PCA agent probe temporarily unavailable — chain read failed',
          code: 'PCA_LOOKUP_READ_FAILED',
        });
      }
      return jsonResponse(res, 500, {
        error: `getPublishingConvictionAccountInfo failed: ${msg}`,
      });
    }
  }
}
