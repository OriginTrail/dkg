/**
 * GH#2942 — shared fixtures for the RPC-preparation suites: the typed transport errors the chain
 * failover module raises, built with the same codes and the same presence/absence of a `txHash`
 * the real producers use (their emission is pinned against the real producers in the chain
 * package's `transient-rpc-transport-failure.unit.test.ts`).
 */
import { ChainRpcTransportError, RpcEndpointsExhaustedError, createRpcTimeoutError } from '@origintrail-official/dkg-chain';

/** A configured RPC URL that carries an API key, as operators really configure them. */
export const KEYED_RPC_URL = 'https://rpc.example/v2/SECRET-API-KEY';

/**
 * `RpcFailoverClient.populateAndSign` exhaustion: every endpoint failed while the publish
 * transaction was being PREPARED. Names no transaction. The text deliberately says "timed out" —
 * the wording that used to select `tx_submit_timeout` — and quotes a keyed URL the way the
 * single-endpoint producer message does (it forwards the provider's own text verbatim).
 */
export function preparationExhausted(): RpcEndpointsExhaustedError {
  return new RpcEndpointsExhaustedError(
    `publish transaction preparation failed on all configured RPC endpoints (rpc.example): request to ${KEYED_RPC_URL} timed out`,
    { rpcUrls: [KEYED_RPC_URL] },
  );
}

/** The local request governor had no capacity before anything was sent. */
export function governorQueueFull(): ChainRpcTransportError {
  return new ChainRpcTransportError('RPC_REQUEST_GOVERNOR_QUEUE_FULL', 'RPC request governor queue wait timed out before the request was sent');
}

/** A bounded request (estimate / fee / nonce read) that ran out of time. */
export function boundedRequestTimeout(): ChainRpcTransportError {
  return createRpcTimeoutError('eth_estimateGas timed out after 10000ms');
}

/** `RpcFailoverClient.broadcast` exhaustion: stamped with the hash of the transaction it carried. */
export function broadcastExhausted(txHash: string): RpcEndpointsExhaustedError {
  return new RpcEndpointsExhaustedError(
    `publish broadcast failed on all configured RPC endpoints (rpc.example) for tx ${txHash}: request timed out`,
    { rpcUrls: [KEYED_RPC_URL], txHash },
  );
}

/** The receipt wait of a SENT transaction timing out: same code as a bounded timeout, but it names the tx. */
export function receiptWaitTimeout(txHash: string): ChainRpcTransportError {
  return createRpcTimeoutError(`receipt wait for ${txHash} timed out`, { txHash });
}

/** Receipt lookup failed on every endpoint — only ever raised for a transaction that was sent. */
export function receiptLookupFailed(): ChainRpcTransportError {
  return new ChainRpcTransportError('RPC_RECEIPT_LOOKUP_FAILED', 'receipt lookup failed on every configured endpoint');
}

/**
 * A multi-endpoint exhaustion message that carries NONE of the words the legacy keyword chain looks
 * for (timeout / timed out / unavailable / query / store / authority / workspace / root): without
 * typed precedence a failure like this one is recorded as the TERMINAL `canonicalization_failed`.
 */
export function exhaustedWithoutKeywords(): RpcEndpointsExhaustedError {
  return new RpcEndpointsExhaustedError(
    'publish transaction preparation failed on all configured RPC endpoints (a.example, b.example): 429 Too Many Requests',
    { rpcUrls: ['https://a.example', 'https://b.example'] },
  );
}
