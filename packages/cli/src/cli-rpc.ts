import { ethers } from 'ethers';
import {
  resolveRpcUrls,
  isRetryableRpcError,
  isKnownTransactionError,
  noteRpcFailover,
  noteRpcExhaustion,
  ChainRpcTransportError,
  createRpcTimeoutError,
  resolveReceiptTimeoutMs,
  waitForTransactionReceiptWithFailover,
} from '@origintrail-official/dkg-chain';
import { cliErrorMessage } from './cli-helpers.js';

const CLI_RPC_READ_STALL_TIMEOUT_MS = 4_000;
const CLI_RPC_BROADCAST_TIMEOUT_MS = 10_000;

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

interface CliEvmRpcContext {
  urls: string[];
  providers: ethers.JsonRpcProvider[];
  readProvider: ethers.JsonRpcProvider | ethers.FallbackProvider;
  /** Resolved once with the endpoint set so direct writes cannot drop it. */
  receiptTimeoutMs: number;
}

function createCliEvmProviders(
  rpcUrl: string,
  rpcUrls?: string[],
  receiptTimeoutMs?: number,
): CliEvmRpcContext {
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
  return {
    urls,
    providers,
    readProvider,
    receiptTimeoutMs: resolveReceiptTimeoutMs(receiptTimeoutMs),
  };
}

async function sendCliRawTransactionWithFailover(
  context: Pick<CliEvmRpcContext, 'providers' | 'urls' | 'receiptTimeoutMs'>,
  signedTx: string,
  txHash: string,
): Promise<ethers.TransactionReceipt> {
  const { providers, urls } = context;
  // Validate every caller-supplied option before broadcasting. A configuration
  // error must never report command failure after the signed transaction has
  // already reached the chain.
  const receiptTimeoutMs = resolveReceiptTimeoutMs(context.receiptTimeoutMs);
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
      if (i < providers.length - 1) {
        noteRpcFailover('cli broadcast', urls[i], err, urls[i + 1]);
      }
    }
  }
  if (lastError) {
    noteRpcExhaustion('cli broadcast', urls);
    // The typed transport error mirrors the chain adapter so CLI callers (and
    // any daemon-route mapping over CLI flows) can distinguish a transient
    // all-endpoints-exhausted failure from a deterministic revert.
    throw new ChainRpcTransportError(
      'RPC_ENDPOINTS_EXHAUSTED',
      `Broadcast failed on all configured RPC endpoints: ${cliErrorMessage(lastError)}`,
      { cause: lastError, rpcUrls: urls },
    );
  }

  const receiptEndpoints = providers.map((provider, index) => {
    const rpcUrl = urls[index];
    return rpcUrl ? { provider, rpcUrl } : { provider };
  });
  return waitForTransactionReceiptWithFailover(receiptEndpoints, txHash, {
    receiptTimeoutMs,
    logLabel: 'cli',
  });
}

export {
  CLI_RPC_READ_STALL_TIMEOUT_MS,
  CLI_RPC_BROADCAST_TIMEOUT_MS,
  cliWithTimeout,
  isCliKnownTransactionError,
  isCliRetryableRpcError,
  createCliEvmProviders,
  sendCliRawTransactionWithFailover,
};
