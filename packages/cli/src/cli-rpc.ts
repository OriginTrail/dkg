import { ethers } from 'ethers';
import {
  resolveRpcUrls,
  isRetryableRpcError,
  isKnownTransactionError,
  noteRpcFailover,
  noteRpcExhaustion,
  ChainRpcTransportError,
  createRpcTimeoutError,
  RPC_RECEIPT_TIMEOUT_MS,
  resolveReceiptTimeoutMs,
  waitForReceiptWithDeadline,
  type ReceiptLookupOptions,
} from '@origintrail-official/dkg-chain';
import { cliErrorMessage } from './cli-helpers.js';

const CLI_RPC_READ_STALL_TIMEOUT_MS = 4_000;
const CLI_RPC_BROADCAST_TIMEOUT_MS = 10_000;
const CLI_RPC_RECEIPT_ATTEMPT_TIMEOUT_MS = 5_000;
const CLI_RPC_RECEIPT_POLL_INTERVAL_MS = 2_000;
// Backwards-compatible export for command modules that already import the CLI
// name. The chain package owns the default so direct CLI writes cannot drift
// from adapter-backed writes when chain.receiptTimeoutMs is omitted.
const CLI_RPC_RECEIPT_TIMEOUT_MS = RPC_RECEIPT_TIMEOUT_MS;

function cliWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(createRpcTimeoutError(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Backwards-compatible CLI aliases for the canonical classifiers in
 * `@origintrail-official/dkg-chain`. ~25 command modules import these names;
 * they delegate so the CLI write path classifies (and fails over) IDENTICALLY
 * to the daemon. (The chain `isRetryableRpcError` calls `enrichEvmError`, which
 * mutates `err.message` — benign here, since CLI errors are thrown, never
 * reused for control flow.)
 */
function isCliKnownTransactionError(err: unknown): boolean {
  return isKnownTransactionError(err);
}

function isCliRetryableRpcError(err: unknown): boolean {
  return isRetryableRpcError(err);
}

function createCliEvmProviders(rpcUrl: string, rpcUrls?: string[]): {
  urls: string[];
  providers: ethers.JsonRpcProvider[];
  readProvider: ethers.JsonRpcProvider | ethers.FallbackProvider;
} {
  const urls = resolveRpcUrls(rpcUrl, rpcUrls);
  const providers = urls.map((url) => new ethers.JsonRpcProvider(url, undefined, { cacheTimeout: -1 }));
  const readProvider = providers.length === 1
    ? providers[0]
    : new ethers.FallbackProvider(
      providers.map((provider, index) => ({
        provider,
        priority: index + 1,
        stallTimeout: CLI_RPC_READ_STALL_TIMEOUT_MS,
        weight: 1,
      })),
      undefined,
      { quorum: 1 },
    );
  return { urls, providers, readProvider };
}

async function getCliReceiptWithFailover(
  providers: ethers.JsonRpcProvider[],
  txHash: string,
  urls?: string[],
  options: ReceiptLookupOptions & { attemptTimeoutMs?: number } = {},
): Promise<ethers.TransactionReceipt | null> {
  let lastRetryable: unknown;
  let sawNonErrorResponse = false;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? CLI_RPC_RECEIPT_ATTEMPT_TIMEOUT_MS;
  for (let i = 0; i < providers.length; i += 1) {
    const remainingMs = options.deadlineMs === undefined
      ? attemptTimeoutMs
      : options.deadlineMs - Date.now();
    if (remainingMs <= 0) break;
    try {
      const receipt = await cliWithTimeout(
        providers[i].getTransactionReceipt(txHash),
        Math.min(attemptTimeoutMs, remainingMs),
        `receipt lookup via RPC #${i + 1}`,
      );
      sawNonErrorResponse = true;
      if (receipt) return receipt;
    } catch (err) {
      if (!isCliRetryableRpcError(err)) throw err;
      lastRetryable = err;
      const canTryNext = options.deadlineMs === undefined || Date.now() < options.deadlineMs;
      if (urls && i < providers.length - 1 && canTryNext) {
        noteRpcFailover('cli receipt lookup', urls[i], err, urls[i + 1]);
      }
    }
  }
  if (lastRetryable && !sawNonErrorResponse) {
    if (urls) noteRpcExhaustion('cli receipt lookup', urls);
    throw new ChainRpcTransportError(
      'RPC_RECEIPT_LOOKUP_FAILED',
      `Receipt lookup for transaction ${txHash} failed on all configured RPC endpoints: ${cliErrorMessage(lastRetryable)}`,
      { cause: lastRetryable, txHash },
    );
  }
  return null;
}

function assertCliSuccessfulReceipt(receipt: ethers.TransactionReceipt, txHash: string): void {
  if (receipt.status !== 0) return;
  const err = new Error(`Transaction ${txHash} was mined but reverted (status=0)`);
  (err as any).code = 'CALL_EXCEPTION';
  (err as any).receipt = receipt;
  throw err;
}

async function sendCliRawTransactionWithFailover(
  providers: ethers.JsonRpcProvider[],
  signedTx: string,
  txHash: string,
  urls?: string[],
  options: { receiptTimeoutMs?: number } = {},
): Promise<ethers.TransactionReceipt> {
  // Validate every caller-supplied option before broadcasting. A configuration
  // error must never report command failure after the signed transaction has
  // already reached the chain.
  const receiptTimeoutMs = resolveReceiptTimeoutMs(options.receiptTimeoutMs);
  let lastError: unknown;
  for (let i = 0; i < providers.length; i += 1) {
    try {
      await cliWithTimeout(
        providers[i].broadcastTransaction(signedTx),
        CLI_RPC_BROADCAST_TIMEOUT_MS,
        `broadcast via RPC #${i + 1}`,
      );
      lastError = undefined;
      break;
    } catch (err) {
      if (isCliKnownTransactionError(err)) {
        lastError = undefined;
        break;
      }
      if (!isCliRetryableRpcError(err)) throw err;
      lastError = err;
      if (urls && i < providers.length - 1) {
        noteRpcFailover('cli broadcast', urls[i], err, urls[i + 1]);
      }
    }
  }
  if (lastError) {
    if (urls) noteRpcExhaustion('cli broadcast', urls);
    // The typed transport error mirrors the chain adapter so CLI callers (and
    // any daemon-route mapping over CLI flows) can distinguish a transient
    // all-endpoints-exhausted failure from a deterministic revert.
    throw new ChainRpcTransportError(
      'RPC_ENDPOINTS_EXHAUSTED',
      `Broadcast failed on all configured RPC endpoints: ${cliErrorMessage(lastError)}`,
      { cause: lastError, ...(urls ? { rpcUrls: urls } : {}) },
    );
  }

  return waitForReceiptWithDeadline({
    txHash,
    receiptTimeoutMs,
    pollIntervalMs: CLI_RPC_RECEIPT_POLL_INTERVAL_MS,
    getReceipt: (hash, { deadlineMs }) => getCliReceiptWithFailover(
      providers,
      hash,
      urls,
      { deadlineMs },
    ),
    assertSuccessfulReceipt: (receipt) => assertCliSuccessfulReceipt(receipt, txHash),
    formatTimeoutMessage: () =>
      `Transaction ${txHash} was broadcast but no receipt was found within ${receiptTimeoutMs}ms`,
  });
}

export {
  CLI_RPC_READ_STALL_TIMEOUT_MS,
  CLI_RPC_BROADCAST_TIMEOUT_MS,
  CLI_RPC_RECEIPT_ATTEMPT_TIMEOUT_MS,
  CLI_RPC_RECEIPT_POLL_INTERVAL_MS,
  CLI_RPC_RECEIPT_TIMEOUT_MS,
  cliWithTimeout,
  isCliKnownTransactionError,
  isCliRetryableRpcError,
  createCliEvmProviders,
  getCliReceiptWithFailover,
  assertCliSuccessfulReceipt,
  sendCliRawTransactionWithFailover,
};
