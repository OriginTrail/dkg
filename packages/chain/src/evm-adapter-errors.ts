// SPDX-License-Identifier: Apache-2.0

/**
 * EVM error decoding / classification helpers extracted from
 * evm-adapter.ts. Covers low-level error-shape extraction
 * (`errorMessage` / `errorCode` / `errorStatus`), custom-error ABI
 * decoding (`decodeEvmError` / `enrichEvmError` and the lazily-cached
 * error/PCA interfaces), the Hub-stale revert markers, and the
 * `TooLowAllowance` classifier. Bodies are a 1:1 move from the original
 * module.
 */
import { ethers, Interface } from 'ethers';
import { loadAbi } from './evm-adapter-abi.js';

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

export function errorCode(err: unknown): string {
  return String((err as any)?.code ?? (err as any)?.error?.code ?? '').toUpperCase();
}

export function errorStatus(err: unknown): number | undefined {
  // Walk the nested wrapper chains ethers v6 / managed RPCs actually populate, so
  // a provider HTTP status buried at e.g. `err.cause.info.error.status` is still
  // found (a shallow one-level read misses it and the caller would misclassify a
  // 401/403/429 as a non-status error). Depth- and cycle-bounded.
  const seen = new Set<unknown>();
  const visit = (e: any, depth: number): number | undefined => {
    if (e == null || typeof e !== 'object' || depth > 5 || seen.has(e)) return undefined;
    seen.add(e);
    for (const raw of [e.status, e.statusCode, e.response?.status, e.error?.status, e.error?.statusCode]) {
      // Numeric, OR a digit-only string ("429"/"401") — several wrapped RPC/fetch
      // errors serialize the HTTP status as a string, so coerce those too rather
      // than missing them and falling back to message heuristics.
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      if (typeof raw === 'string' && /^\d{3}$/.test(raw.trim())) return Number(raw);
    }
    for (const k of ['cause', 'info', 'error']) {
      const found = visit(e[k], depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(err, 0);
}

export const ERROR_ABI_CONTRACTS = [
  'KnowledgeAssets', 'KnowledgeAssetsLifecycle', 'KnowledgeAssetsStorage',
  'DKGKnowledgeAssets', 'ContextGraphs', 'ContextGraphStorage',
  'ContextGraphNameRegistry', 'Profile', 'Identity', 'IdentityStorage',
  'Staking', 'StakingStorage', 'StakingV10', 'StakingKPI',
  'ConvictionStakingStorage',
  'DKGStakingConvictionNFT', 'DKGPublishingConvictionNFT',
  // Post PR #650 split — PCA business errors are declared on the logic
  // and storage contracts, NOT the slim wrapper. Both must be in this
  // list so wrapper-bubbled reverts (e.g. NoConvictionAccount, AccountExpired,
  // UnknownAccount, InvalidAmount, AgentAlreadyRegistered) decode at runtime.
  'PublishingConviction', 'PublishingConvictionStorage',
  'Hub', 'Token', 'Ask', 'AskStorage',
  'Paymaster', 'ShardingTable', 'ParametersStorage',
  'PublishingConvictionAccount',
  'RandomSampling', 'RandomSamplingStorage',
];

/**
 * Substrings we treat as "the Hub no longer recognises this contract
 * as a registered participant" — i.e. the cached address is stale and
 * the next call should re-resolve from the Hub. Conservative match on
 * the canonical revert wording from `ContractStatus.onlyContracts` /
 * `UnauthorizedAccess(Only Contracts in Hub)` so we don't accidentally
 * drop the cache on an unrelated authorization failure.
 */
export const HUB_STALE_ERROR_MARKERS = [
  'Only Contracts in Hub',
  'UnauthorizedAccess(Only Contracts in Hub)',
];

let _errorInterface: Interface | null = null;
let _pcaLogicInterface: Interface | null = null;

/**
 * Lazy-cached `ethers.Interface` over the `PublishingConviction` (logic)
 * contract ABI.
 *
 * Post PR #650, all PCA state-change events (`AccountCreated`, `ToppedUp`,
 * `CostCovered`, `WindowSettled`, `AccountFinalSwept`,
 * `AgentRegistered`, `AgentDeregistered`) are emitted by the logic contract
 * — NOT by the `DKGPublishingConvictionNFT` wrapper. Receipt-log parsing
 * for those events MUST go through this interface; parsing through the
 * wrapper's interface returns `null` because the wrapper ABI no longer
 * declares those events. See `DKGPublishingConvictionNFT.sol` NatSpec
 * "Deliberate breaks in the v2.x → v3.0.0 wrapper bump".
 */
export function getPcaLogicInterface(): Interface {
  if (_pcaLogicInterface) return _pcaLogicInterface;
  _pcaLogicInterface = new Interface(loadAbi('PublishingConviction') as any[]);
  return _pcaLogicInterface;
}

export function getErrorInterface(): Interface {
  if (_errorInterface) return _errorInterface;
  const errorFragments: string[] = [];
  for (const name of ERROR_ABI_CONTRACTS) {
    try {
      const abi = loadAbi(name) as any[];
      for (const entry of abi) {
        if (entry.type === 'error') {
          const params = (entry.inputs ?? []).map((i: any) => `${i.type} ${i.name}`).join(', ');
          errorFragments.push(`error ${entry.name}(${params})`);
        }
      }
    } catch { /* ABI not available */ }
  }
  _errorInterface = new Interface([...new Set(errorFragments)]);
  return _errorInterface;
}

/**
 * Decode an EVM custom error selector into a human-readable string.
 * Returns null if the selector doesn't match any known contract error.
 */
export function decodeEvmError(data: string | Uint8Array): { name: string; args: ethers.Result } | null {
  try {
    const hex = typeof data === 'string' ? data : ethers.hexlify(data);
    if (hex.length < 10) return null;
    const parsed = getErrorInterface().parseError(hex);
    return parsed ? { name: parsed.name, args: parsed.args } : null;
  } catch {
    return null;
  }
}

/**
 * Enrich a caught EVM error with a decoded custom error name.
 * Modifies the error message in-place and returns the decoded name (if any).
 */
export function enrichEvmError(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  // Match the revert-data hex across the RPC-shape variants we see in the
  // wild. CH-10:
  //   - Hardhat:        ... data="0x..."             (key="value", quoted)
  //   - Geth:           ... data: "0x..."            (key: value, JS-object)
  //   - Geth no-quote:  ... data=0x...               (key=value, unquoted)
  //   - Infura/Alchemy: ... errorData="0x..."        (errorData= prefix)
  //   - JSON body:      ... "data":"0x..."           (JSON-encoded provider error)
  // Leading non-letter (or string start) ensures `errorData` doesn't match
  // as `data`. Separator class accepts any combination of `=`, `:`, `"`,
  // `'`, whitespace.
  const match = err.message.match(
    /(?:^|[^a-zA-Z])(?:errorData|data)["':=\s]+(0x[0-9a-fA-F]+)/,
  );
  if (!match) return null;
  const decoded = decodeEvmError(match[1]);
  if (!decoded) return null;
  const argsStr = decoded.args.length > 0 ? `(${decoded.args.join(', ')})` : '';
  const decodedStr = `${decoded.name}${argsStr}`;
  err.message = err.message.replace('unknown custom error', decodedStr);
  return decoded.name;
}

/**
 * #888 — true iff `err` is the V10 publish `TooLowAllowance(TRAC, ...)`
 * custom-error revert.
 *
 * The on-chain allowance read that gates the auto-approve and the
 * `estimateGas` that ethers runs while populating the publish tx can
 * observe a *stale* allowance on an internally load-balanced RPC: a
 * just-consumed per-publish `1`-wei floor still reads as `1` (so the
 * re-approve is skipped), or a freshly-sent approve has not yet
 * propagated to the read replica. Either way the contract reverts
 * `TooLowAllowance` during gas estimation — strictly BEFORE broadcast —
 * and the publisher can recover by forcing a fresh approve and retrying.
 *
 * Matches ethers v6's decoded custom-error shape (`err.revert.name`) and
 * falls back to string matching on the message / shortMessage / reason /
 * nested cause so a stringified or re-wrapped revert is still caught.
 */
export function isTooLowAllowanceError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    revert?: { name?: unknown };
    message?: unknown;
    shortMessage?: unknown;
    reason?: unknown;
    cause?: unknown;
  };
  if (typeof e.revert?.name === 'string' && e.revert.name === 'TooLowAllowance') {
    return true;
  }
  const causeMessage =
    e.cause && typeof e.cause === 'object'
      ? (e.cause as { message?: unknown }).message
      : undefined;
  const haystack = [e.message, e.shortMessage, e.reason, causeMessage]
    .filter((s): s is string => typeof s === 'string')
    .join(' ');
  return /TooLowAllowance/i.test(haystack);
}
