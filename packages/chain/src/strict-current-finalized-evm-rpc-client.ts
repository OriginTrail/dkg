import type {
  BlockNumberV1,
  ChainIdV1,
  Digest32V1,
} from '@origintrail-official/dkg-core';

import { CurrentFinalizedEvmCallErrorV1 } from './current-finalized-evm-read-profile.js';
import {
  anchorDependentResourceLimited,
  resourceLimited,
  revertedAtFinalizedAnchor,
  timedOut,
  unavailable,
} from './strict-current-finalized-evm-errors.js';
import type { FinalizedAnchorV1 } from './strict-current-finalized-evm-types.js';
import { isCanonicalLowerHexBytesV1 } from './strict-finalized-evm-bytes.js';

interface RpcErrorEnvelopeV1 {
  readonly code: number;
  readonly message: string;
  readonly data?: string;
}

const CANONICAL_LOWER_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const CANONICAL_DIGEST_32 = /^0x[0-9a-f]{64}$/;
const MAX_U64 = 18_446_744_073_709_551_615n;
const MAX_U256 =
  115_792_089_237_316_195_423_570_985_008_687_907_853_269_984_665_640_564_039_457_584_007_913_129_639_935n;

export async function postStrictFinalizedJsonRpcV1(
  endpoint: string,
  id: number,
  method: string,
  params: readonly unknown[],
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: Object.freeze({
        accept: 'application/json',
        'content-type': 'application/json',
      }),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      redirect: 'error',
      signal,
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw unavailable(`JSON-RPC ${method} transport failed`, cause);
  }

  const body = await readResponseBodyBounded(response, maxResponseBytes);
  if (!response.ok) {
    // An HTTP intermediary/provider failure is transport availability, even if
    // its untrusted body happens to mimic a deterministic JSON-RPC revert. Only
    // a successful JSON-RPC transport response may select an invalidity code.
    throw unavailable(`JSON-RPC ${method} returned HTTP ${response.status}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch (cause) {
    throw unavailable(`JSON-RPC ${method} returned malformed JSON`, cause);
  }
  if (!isPlainRecord(parsed) || parsed.jsonrpc !== '2.0' || parsed.id !== id) {
    throw unavailable(`JSON-RPC ${method} returned a mismatched response envelope`);
  }
  const hasResult = Object.prototype.hasOwnProperty.call(parsed, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(parsed, 'error');
  if (hasResult === hasError) {
    throw unavailable(`JSON-RPC ${method} response must contain exactly one of result or error`);
  }
  if (hasError) {
    const error = parseRpcError(parsed.error);
    if (error === undefined) throw unavailable(`JSON-RPC ${method} returned a malformed error`);
    throw classifyJsonRpcError(method, error);
  }
  return parsed.result;
}

async function readResponseBodyBounded(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const declared = BigInt(contentLength);
    if (declared > BigInt(maxBytes)) {
      await response.body?.cancel().catch(() => undefined);
      throw resourceLimited(
        `Raw JSON-RPC response declared ${declared.toString()} bytes, limit ${maxBytes}`,
      );
    }
  }

  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw resourceLimited(`Raw JSON-RPC response exceeded ${maxBytes} bytes before parsing`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw unavailable('JSON-RPC response body is not valid UTF-8', cause);
  }
}

export function parseStrictFinalizedChainIdV1(input: unknown): ChainIdV1 {
  let parsed: bigint;
  try {
    parsed = parseCanonicalQuantity(input, MAX_U256);
  } catch (cause) {
    throw unavailable('eth_chainId returned a malformed chain ID', cause);
  }
  return parsed.toString(10) as ChainIdV1;
}

export function parseStrictFinalizedAnchorV1(
  input: unknown,
  label: string,
): FinalizedAnchorV1 {
  if (input === null) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'finalized-state-unavailable',
      `${label} is unavailable`,
    );
  }
  if (!isPlainRecord(input)) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'finalized-state-unavailable',
      `${label} is malformed`,
    );
  }

  let blockNumber: bigint;
  try {
    blockNumber = parseCanonicalQuantity(input.number, MAX_U64);
  } catch (cause) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'finalized-state-unavailable',
      `${label} has a malformed block number`,
      { cause },
    );
  }
  if (typeof input.hash !== 'string' || !CANONICAL_DIGEST_32.test(input.hash)) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'finalized-state-unavailable',
      `${label} has a malformed block hash`,
    );
  }
  return Object.freeze({
    blockNumber: blockNumber.toString(10) as BlockNumberV1,
    blockNumberQuantity: input.number as string,
    blockHash: input.hash as Digest32V1,
  });
}

function parseCanonicalQuantity(input: unknown, maximum: bigint): bigint {
  if (typeof input !== 'string' || !CANONICAL_LOWER_QUANTITY.test(input)) {
    throw new Error('not a canonical lowercase JSON-RPC quantity');
  }
  const parsed = BigInt(input);
  if (parsed > maximum) throw new Error('JSON-RPC quantity is out of range');
  return parsed;
}

function parseRpcError(input: unknown): RpcErrorEnvelopeV1 | undefined {
  if (
    !isPlainRecord(input)
    || typeof input.code !== 'number'
    || !Number.isSafeInteger(input.code)
    || typeof input.message !== 'string'
  ) {
    return undefined;
  }
  const data = isCanonicalLowerHexBytesV1(input.data)
    ? input.data
    : undefined;
  return Object.freeze({
    code: input.code,
    message: input.message,
    ...(data === undefined ? {} : { data }),
  });
}

function classifyJsonRpcError(
  method: string,
  error: RpcErrorEnvelopeV1,
): CurrentFinalizedEvmCallErrorV1 {
  const message = error.message.toLowerCase();
  if (method === 'eth_call' && (error.code === 3 || message.includes('revert'))) {
    return revertedAtFinalizedAnchor(error.data);
  }
  if (
    method === 'eth_call'
    && (
      message.includes('out of gas')
      || message.includes('gas limit')
      || message.includes('gas required')
      || message.includes('exceeds allowance')
      || message.includes('intrinsic gas')
    )
  ) {
    return anchorDependentResourceLimited(
      'Finalized contract execution could not complete within the fixed gas cap',
    );
  }
  if (message.includes('timeout') || message.includes('timed out')) {
    return timedOut(`JSON-RPC ${method} timed out`);
  }
  if (
    method === 'eth_getBlockByNumber'
    || message.includes('header not found')
    || message.includes('unknown block')
    || message.includes('block not found')
    || message.includes('canonical')
  ) {
    return new CurrentFinalizedEvmCallErrorV1(
      'finalized-state-unavailable',
      `JSON-RPC ${method} could not prove the required finalized anchor`,
    );
  }
  return unavailable(`JSON-RPC ${method} failed with code ${error.code}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
