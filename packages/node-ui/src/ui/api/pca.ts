// Publisher Conviction Accounts (PCA) — daemon `/api/pca/*` client.
//
// Extracted from api.ts (#1345). Behavior is unchanged; api.ts re-exports this
// module (`export * from './api/pca.js'`) so every existing `../api.js` import
// keeps resolving. Transport comes from the shared ../http.ts.
import { HttpError, getJson, post, delJson } from '../http.js';

// --- Publisher Conviction Accounts (PCA) ----------------------------------
//
// Client helpers for the daemon's `/api/pca/*` routes (see
// `packages/cli/src/daemon/routes/pca.ts`). They route through the shared
// `getJson`/`post`/`delJson` (from `../http.ts`) so they inherit same-origin base, bearer auth, and
// `HttpError`-shaped failures — never hand-roll `fetch` here.
//
// Terminology discipline (PCA UX §P1): the registered identity is the
// OPERATIONAL WALLET that signs publishes (`msg.sender`). User-facing copy in
// `describePcaError` says "approved publishing wallet" / "operational wallet",
// never the contract word "agent" (which survives only in the route/field
// identifiers like `pcaAddAgent` and the `AgentAlreadyRegistered` error code).

/** A wallet-probe result, present on `fetchPca(id, key)` (the `?key=` query). */
export interface PcaProbedKey {
  key: string;
  /** Whether `key` is an approved publishing wallet on this account. */
  registered?: boolean;
  /** False only when the chain adapter can't answer (capability gap). */
  adapterSupported?: boolean;
  /** Set instead of `registered` when `key` isn't a valid EVM address. */
  error?: string;
}

/**
 * A PCA snapshot — mirrors the daemon's `serializeAccountInfo`
 * (`pca.ts:138`). Wei amounts are decimal strings (`committedTRAC`); the
 * matching `*Trac` fields are pre-formatted ether strings. Epoch indices and
 * timestamps are numbers; `*Timestamp` are unix SECONDS (multiply by 1000 for
 * a JS `Date`).
 *
 * The EXTENDED group (`primaryNode`, `lastPrimaryNodeChangeEpoch`,
 * `remainingAllowance`(+Trac), `currentEpoch`) is GAP-4/5, only serialized when
 * the GET route is called with `{ extended: true }`. They are optional because
 * the daemon can fail-soft an extended chain read and still return the core
 * snapshot. `extendedRequested` is a client-side marker added by `fetchPca` so
 * coverage code can tell "not requested" from "requested but unavailable".
 */
export interface PcaSnapshot {
  accountId: string;
  owner: string;
  committedTRAC: string;
  committedTRACTrac: string;
  baseEpochAllowance: string;
  topUpBuffer: string;
  topUpBufferTrac: string;
  createdAtEpoch: number;
  expiresAtEpoch: number;
  createdAtTimestamp: number;
  expiresAtTimestamp: number;
  discountBps: number;
  agentCount: number;
  lastSettledWindow: number;
  fullySwept: boolean;
  probedKey?: PcaProbedKey;
  // --- Extended (P2 / `?extended=1` only — undefined in P0) ---
  /** The node identityId this PCA directs publishing-reward weight to (uint72 string). */
  primaryNode?: string;
  /** Epoch index of the last `setPrimaryNode` change. */
  lastPrimaryNodeChangeEpoch?: number;
  /** Spendable allowance remaining in the current epoch (wei string). */
  remainingAllowance?: string;
  /** Pre-formatted ether form of `remainingAllowance`. */
  remainingAllowanceTrac?: string;
  /** The current protocol epoch index (resolves the lock-period readout). */
  currentEpoch?: number;
  /** Client-side only: this snapshot came from a `fetchPca(..., { extended:true })` read. */
  extendedRequested?: boolean;
}

export interface CreatePcaResult {
  accountId: string;
  txHash?: string;
  blockNumber?: number;
  committedTokens: string;
}

export interface PcaAddAgentResult {
  accountId: string;
  agent: string;
  /** The daemon re-reads the chain after the tx; trust this over a bare 200. */
  registered: boolean;
  adapterSupported: boolean;
  txHash?: string;
  blockNumber?: number;
}

export interface PcaRemoveAgentResult {
  accountId: string;
  agent: string;
  deregistered: boolean;
  txHash?: string;
  blockNumber?: number;
}

export interface PcaTopUpResult {
  accountId: string;
  addedTokens: string;
  txHash?: string;
  blockNumber?: number;
}

export interface PcaSettleResult {
  accountId: string;
  settled: boolean;
  txHash?: string;
  blockNumber?: number;
}

/**
 * GET a PCA snapshot. Pass `key` (an operational wallet address) to additionally
 * probe whether that wallet is an approved publishing wallet on the account
 * (the result lands on `snapshot.probedKey`). `GET` is permissionless.
 *
 * `opts.extended` (`?extended=1`) requests the GAP-4/5 extended fields
 * (primaryNode / remainingAllowance / currentEpoch). The returned snapshot is
 * marked with `extendedRequested` because the daemon may fail-soft and omit the
 * optional fields; spend-time coverage must then become inconclusive instead of
 * falling back to nominal `baseEpochAllowance`.
 */
export const fetchPca = (
  accountId: string,
  key?: string,
  opts?: { extended?: boolean },
) => {
  const params = new URLSearchParams();
  if (key) params.set('key', key);
  if (opts?.extended) params.set('extended', '1');
  const qs = params.toString();
  return getJson<PcaSnapshot>(`/api/pca/${encodeURIComponent(accountId)}${qs ? `?${qs}` : ''}`)
    .then((snap) => (opts?.extended ? { ...snap, extendedRequested: true } : snap));
};

/** Create a PCA (commit TRAC for a publishing discount). Owner = the daemon EOA. */
export const createPca = (args: { tokens: string; primaryNode: string }) =>
  post<CreatePcaResult>('/api/pca', { tokens: args.tokens, primaryNode: args.primaryNode });

/** Approve an operational wallet as a publishing wallet on a PCA (owner-gated). */
export const pcaAddAgent = (accountId: string, address: string) =>
  post<PcaAddAgentResult>(`/api/pca/${encodeURIComponent(accountId)}/agent`, { agent: address });

/** Remove an approved publishing wallet from a PCA (owner-gated). */
export const pcaRemoveAgent = (accountId: string, address: string) =>
  delJson<PcaRemoveAgentResult>(
    `/api/pca/${encodeURIComponent(accountId)}/agent/${encodeURIComponent(address)}`,
  );

/** Top up a PCA's spendable buffer (owner-gated). Does NOT extend the lock period. */
export const pcaTopUp = (accountId: string, tokens: string) =>
  post<PcaTopUpResult>(`/api/pca/${encodeURIComponent(accountId)}/funds`, { tokens });

/** Run the lazy-settlement sweep (permissionless — enabled even for non-owners). */
export const pcaSettle = (accountId: string) =>
  post<PcaSettleResult>(`/api/pca/${encodeURIComponent(accountId)}/settle`, {});

export interface PcaAgentsResult {
  accountId: string;
  /** The FULL set of approved publishing-wallet addresses (checksummed). `[]` = a
   *  real 0-approved account, distinct from a 404 (unknown account). */
  agents: string[];
}

/**
 * B3 — list the approved publishing wallets on a PCA (the full on-chain enumerator,
 * vs just this node's wallets the detail view can probe). Existence-checked like
 * {@link fetchPca}: an unknown account 404s (so the caller distinguishes "no such
 * account" from `agents: []`); 503 = capability/transport. `GET` is permissionless.
 */
export const listPcaAgents = (accountId: string) =>
  getJson<PcaAgentsResult>(`/api/pca/${encodeURIComponent(accountId)}/agents`);

export interface PcaAgentAccountResult {
  /** Echoed checksummed address that was queried. */
  agent: string;
  /** The PCA this wallet is an approved publishing wallet on, or `null` if none. A
   *  wallet is approved on at most one account, so this is a direct answer. */
  accountId: string | null;
}

/**
 * GAP-3 — resolve which PCA (if any) an operational wallet is an approved publishing
 * wallet on (`GET /api/pca/agent/:address`). A faster/authoritative path than probing
 * each tracked account; `accountId: null` = not a publishing agent anywhere. 400 =
 * invalid address, 503 = capability/transport. NOTE: this is a discovery/optimization
 * primitive only — coverage MUST still resolve via `fetchPca` → `classifyCoverage`
 * (registered ≠ covered; the #1344 honesty line). `GET` is permissionless.
 */
export const pcaAgentAccount = (address: string) =>
  getJson<PcaAgentAccountResult>(`/api/pca/agent/${encodeURIComponent(address)}`);

export interface MyPcaEntry extends Partial<PcaSnapshot> {
  accountId: string;
  relation: 'owned' | 'agent' | 'both';
}

/**
 * GAP-1 enumeration route: every PCA this node relates to through owned PCA
 * NFTs and/or approved operational publishing wallets. Hydration is best
 * effort server-side, so relation rows remain useful even when snapshot fields
 * are omitted.
 */
export const fetchMyPcas = (opts?: { hydrate?: boolean }) =>
  getJson<{ accounts: MyPcaEntry[] }>(`/api/pca/mine${opts?.hydrate ? '?hydrate=1' : ''}`);

/**
 * One staked sharding-table node, as the API returns it. `identityId` (DECIMAL string) is the
 * on-chain id a PCA designates as its `primaryNode` (the value Create submits); `nodeId` is a HEX
 * string (on-chain `bytes`, the node's self-reported id → shown only as an "unverified" label);
 * `stake`/`ask` are wei strings. `ask` is REQUIRED on the API type — the route always sends it; the
 * picker just doesn't display it, so its separate prop type omits `ask` (don't loosen this contract).
 */
export interface DesignatableNode {
  /** Hex string (`0x…`) — the node's self-reported id; display-only ("unverified"). */
  nodeId: string;
  /** Decimal string — the on-chain identity; the value passed as `primaryNode`. */
  identityId: string;
  /** Wei string. */
  stake: string;
  /** Wei string; returned by the route, not shown in the picker. */
  ask: string;
}

/** The sharding table is capped (≤500), read+cached whole, and the UI drains it whole, so the route
 *  returns the FULL list in one response (no offset pagination). */
export interface DesignatableNodesResult {
  nodes: DesignatableNode[];
  /** Total nodes in the sharding table. */
  total: number;
}

/**
 * The staked sharding-table nodes for the PrimaryNodePicker. The daemon reads the whole (≤500) table,
 * TTL-caches it, and returns it in ONE response (no pagination). A read failure 503s
 * (`SHARDING_TABLE_READ_FAILED` / transport / capability) — all retryable; the picker shows a retry,
 * and `primaryNode` is required so edge can't proceed until it loads. `fresh:true` BYPASSES the
 * daemon's 30s TTL cache + repopulates it — used by the picker Retry + the
 * `PrimaryNodeNotInShardingTable` recovery so a just-(un)staked node is seen immediately, not after
 * the stale window. `GET` is permissionless.
 */
export const listDesignatableNodes = (opts?: { fresh?: boolean }) =>
  getJson<DesignatableNodesResult>(
    `/api/pca/designatable-nodes${opts?.fresh ? '?fresh=1' : ''}`,
  );

/**
 * Resolved PCA contract addresses + chain — the bootstrap the in-browser wallet (web3) layer needs.
 * The daemon resolves these via its Hub config (the browser does NOT re-resolve the Hub). Minimal
 * set: the NFT wrapper (every wallet-signed write + the ERC721Enumerable owned-PCA walk + the mint
 * `Transfer` accountId decode all target it), the TRAC token (approve/allowance), the chain id, and
 * the browser-safe RPC endpoints for a viem publicClient. `nativeCurrency` is NOT here — the browser
 * derives the gas symbol from `nativeGasSymbol(chainId)`.
 */
export interface PcaContracts {
  /** DKGPublishingConvictionNFT address (EIP-55). */
  nft: string;
  /** TRAC ERC-20 address (EIP-55) — `approve`/`allowance`. */
  token: string;
  /** Chain id; may be the compound `"slug:chainId"` form (e.g. `"base:84532"`) — extract the numeric
   *  tail for the viem `Chain.id`. */
  chainId: string | number;
  /** Browser-safe RPC endpoints for the viem publicClient (reads + receipt polling). */
  rpcUrls: string[];
  /** Optional wallet-public RPC endpoints safe to hand to wallet_addEthereumChain. */
  walletRpcUrls?: string[];
}

/**
 * Bootstrap the in-browser web3 layer (contract addresses + chain). `GET` is permissionless. A node
 * without the PCA contract deployed 503s `FEATURE_UNAVAILABLE` (same family as the other PCA routes →
 * a clean "unavailable" state); an address-read failure 503s `CONTRACTS_READ_FAILED` (retryable).
 */
export const listPcaContracts = () => getJson<PcaContracts>('/api/pca/contracts');

/** Normalized, terminology-disciplined PCA error code (UI branches on this). */
export type PcaErrorCode =
  | 'FEATURE_UNAVAILABLE'
  | 'CONTRACTS_READ_FAILED'
  | 'InvalidAmount'
  | 'PrimaryNodeNotInShardingTable'
  | 'ZeroPrimaryNode'
  | 'PrimaryNodeUnchanged'
  | 'PrimaryNodeChangeRateLimited'
  | 'ZeroAgentAddress'
  | 'TokenTransferFailed'
  | 'NotAccountOwner'
  | 'UnknownAccount'
  | 'AgentAlreadyRegistered'
  | 'AgentNotRegistered'
  | 'AgentCapReached'
  | 'AccountExpired'
  | 'AccountAlreadyFullySettled'
  | 'BadRequest'
  | 'Conflict'
  | 'ServerError'
  | 'Unknown';

export interface PcaErrorInfo {
  code: PcaErrorCode;
  status: number;
  /** User-facing copy ("approved publishing wallet", never "agent"). */
  message: string;
  /**
   * B10: the conviction account a wallet is ALREADY approved on, surfaced on
   * `AgentAlreadyRegistered`. The P1 daemon NOW returns it (`resolveConflictingAccountId`
   * + the register route populate it), so `describePcaError` names "PCA #M — deregister
   * it there first". It is `undefined` only on the rare case the daemon can't resolve the
   * id, where the copy degrades to "another PCA".
   */
  existingAccountId?: string;
}

/**
 * A transient RPC-transport failure (the daemon's failover layer exhausted /
 * timed out), distinguished by the body code: `RPC_*` (e.g. RPC_ENDPOINTS_EXHAUSTED
 * → 503, RPC_RECEIPT_LOOKUP_FAILED → 503) OR the bare `TIMEOUT` the chain-tx
 * timeout 504 carries (http-utils RPC_TIMEOUT surfaces as `code:'TIMEOUT'`). NOT
 * a capability gap — the feature exists, the chain read just hiccupped, so it
 * must not gate the tab. (The double-mint guard is UNAFFECTED — it keys on
 * `err.status===504` directly, before this.)
 */
export function isRpcTransportError(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  const code = (err.body as { code?: string } | undefined)?.code;
  return typeof code === 'string' && (code.startsWith('RPC_') || code === 'TIMEOUT');
}

/**
 * Whether an error is the daemon's CAPABILITY 503 — PCA isn't deployed on this
 * network. A transport 503/504 (`RPC_*` code) is explicitly excluded so a
 * transient RPC blip during the mount probe doesn't falsely lock the whole tab.
 */
export function isPcaFeatureUnavailable(err: unknown): boolean {
  return err instanceof HttpError && err.status === 503 && !isRpcTransportError(err);
}

export function isPcaReadFailed(err: unknown): boolean {
  if (!(err instanceof HttpError) || err.status !== 503) return false;
  const body = err.body as { code?: string; error?: string } | undefined;
  return body?.code === 'PCA_LOOKUP_READ_FAILED' || body?.error === 'PCA_LOOKUP_READ_FAILED';
}

// Code tokens the daemon embeds in the `{ error }` body (a bare code on a
// contract revert, or a longer sentence like "NotAccountOwner — daemon EOA is
// not the PCA owner"). Matched by word boundary, most-specific intent first.
const PCA_ERROR_CODES: PcaErrorCode[] = [
  'PrimaryNodeNotInShardingTable',
  'PrimaryNodeUnchanged',
  'PrimaryNodeChangeRateLimited',
  'ZeroPrimaryNode',
  'InvalidAmount',
  'ZeroAgentAddress',
  'TokenTransferFailed',
  'NotAccountOwner',
  'AgentAlreadyRegistered',
  'AgentNotRegistered',
  'AgentCapReached',
  'AccountExpired',
  'AccountAlreadyFullySettled',
  'UnknownAccount',
];

/**
 * Map a PCA route failure to terminology-disciplined, user-facing copy —
 * the PCA counterpart to {@link describePromoteError}. Branches on
 * `HttpError.status` + the `{ error }` body code. Returns `null` for
 * non-`HttpError` throwables so the caller falls back to `err.message`;
 * for any `HttpError` it always returns a populated `PcaErrorInfo`.
 *
 * `opts.accountId` lets the copy name the precise "PCA #N".
 */
export function describePcaError(
  err: unknown,
  opts: { accountId?: string } = {},
): PcaErrorInfo | null {
  if (!(err instanceof HttpError)) return null;
  const status = err.status;
  const body = (err.body ?? {}) as { error?: string; existingAccountId?: string | number };
  const raw = typeof body.error === 'string' && body.error.length > 0 ? body.error : err.message;
  const pcaRef = opts.accountId ? `PCA #${opts.accountId}` : 'this Publisher Conviction Account';
  const existingAccountId =
    body.existingAccountId != null ? String(body.existingAccountId) : undefined;

  // Transient RPC-transport outage (RPC_* code, 503/504) — NOT a capability gap.
  // Check before the capability-503 branch so a failover blip reads as
  // "try again", not "not available on this network".
  if (isRpcTransportError(err)) {
    return {
      code: 'ServerError',
      status,
      message: 'The chain RPC is temporarily unavailable — try again.',
    };
  }

  // 503 (without an RPC_* code) is the network-capability gate.
  if (status === 503) {
    return {
      code: 'FEATURE_UNAVAILABLE',
      status,
      message: "Publisher Conviction Accounts aren't available on this network.",
    };
  }

  const matched = PCA_ERROR_CODES.find((c) => new RegExp(`\\b${c}\\b`).test(raw));
  if (matched) {
    let message: string;
    switch (matched) {
      case 'InvalidAmount':
        message = 'Enter a TRAC amount greater than 0.';
        break;
      case 'PrimaryNodeNotInShardingTable':
        message = "That primary node isn't a staked node in the sharding table.";
        break;
      case 'ZeroPrimaryNode':
        message = 'Choose a staked node as the primary node.';
        break;
      case 'PrimaryNodeUnchanged':
        message = "That's already this account's primary node.";
        break;
      case 'PrimaryNodeChangeRateLimited':
        message = 'The primary node was changed too recently — try again later.';
        break;
      case 'ZeroAgentAddress':
        message = 'Enter a valid operational wallet address.';
        break;
      case 'TokenTransferFailed':
        message = "The TRAC transfer failed — check the owner wallet's TRAC balance and allowance.";
        break;
      case 'NotAccountOwner':
        message = `This node isn't the owner of ${pcaRef}, so it can't manage it.`;
        break;
      case 'UnknownAccount':
        message = `${pcaRef} doesn't exist.`;
        break;
      case 'AgentAlreadyRegistered':
        message = existingAccountId
          ? `This operational wallet is already an approved publishing wallet on PCA #${existingAccountId} — deregister it there first.`
          : 'This operational wallet is already approved on another PCA — deregister it there first.';
        break;
      case 'AgentNotRegistered':
        message = `This operational wallet isn't an approved publishing wallet on ${pcaRef}.`;
        break;
      case 'AgentCapReached':
        message = `${pcaRef} already has the maximum 100 approved publishing wallets.`;
        break;
      case 'AccountExpired':
        message = `${pcaRef} has expired.`;
        break;
      case 'AccountAlreadyFullySettled':
        message = `${pcaRef} is already fully settled.`;
        break;
      default:
        message = raw;
    }
    return { code: matched, status, message, ...(existingAccountId ? { existingAccountId } : {}) };
  }

  // No code token matched — fall back to a status-shaped default. 404 (the
  // GET route returns "Unknown PCA accountId N", which carries no code token)
  // and 403 still get friendly copy; 400 surfaces the daemon's validation
  // sentence (already readable); 5xx is generic.
  if (status === 404) {
    return { code: 'UnknownAccount', status, message: `${pcaRef} doesn't exist.` };
  }
  if (status === 403) {
    return {
      code: 'NotAccountOwner',
      status,
      message: `This node isn't the owner of ${pcaRef}, so it can't manage it.`,
    };
  }
  if (status === 400) {
    return { code: 'BadRequest', status, message: raw };
  }
  if (status === 409) {
    return { code: 'Conflict', status, message: raw };
  }
  if (status >= 500) {
    return {
      code: 'ServerError',
      status,
      message: 'Something went wrong talking to the chain — try again.',
    };
  }
  return { code: 'Unknown', status, message: raw };
}
