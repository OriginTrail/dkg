import type {
  BlockNumberV1,
  ChainIdV1,
  Digest32V1,
} from '@origintrail-official/dkg-core';
import {
  BoundedResponseBodyLimitError,
  readResponseBodyBytesBounded,
} from '@origintrail-official/dkg-http-utils';

import { CurrentFinalizedEvmCallErrorV1 } from './current-finalized-evm-read-profile.js';
import { resolveEvmFinalityAnchorBlockV1 } from './evm-finality-anchor.js';
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

  if (!response.ok) {
    // An HTTP intermediary/provider failure is transport availability, even if
    // its untrusted body happens to mimic a deterministic JSON-RPC revert. Only
    // a successful JSON-RPC transport response may select an invalidity code.
    // Do not run the successful-response byte cap over an error page first:
    // oversized proxy/provider bodies must remain failover-eligible transport
    // failures, not become terminal resource-limit evidence.
    await response.body?.cancel().catch(() => undefined);
    throw unavailable(`JSON-RPC ${method} returned HTTP ${response.status}`);
  }

  const body = await readResponseBodyBounded(response, maxResponseBytes);

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
  let bytes: Uint8Array;
  try {
    bytes = await readResponseBodyBytesBounded(response, maxBytes);
  } catch (error) {
    if (!(error instanceof BoundedResponseBodyLimitError)) throw error;
    if (error.source === 'content-length') {
      throw resourceLimited(
        `Raw JSON-RPC response declared ${error.actualBytes.toString()} bytes, limit ${maxBytes}`,
      );
    }
    throw resourceLimited(`Raw JSON-RPC response exceeded ${maxBytes} bytes before parsing`);
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

/**
 * Resolve the strict transports' anchor at the node's SINGLE definition of
 * finality — `chain.finalityConfirmations` — instead of the endpoint's
 * `finalized` block tag.
 *
 * The tag is the RPC provider's own consensus-finality marker; on Base Sepolia
 * it trails head by ~600 blocks / ~20 minutes and no operator setting can move
 * it. `latest` is read instead, and the shared resolver turns that head into the
 * anchor with the SAME arithmetic every other subsystem uses. Confirmation 1 —
 * the default — makes the head itself the anchor, so the common case still costs
 * exactly ONE header read, which matters on a path with a non-queueing admission
 * gate and a hard total deadline. That reuse is the shared resolver's, not this
 * module's: every subsystem gets the same one-read behaviour at depth 1 and the
 * same second read below it.
 *
 * The anchor DISCIPLINE these transports are named for is unchanged: every read
 * runs against the same endpoint inside one attempt, the deeper anchor is
 * fetched by NUMBER and must come back as exactly that height, and its canonical
 * quantity is the endpoint's own echo, so the EIP-1898 / hash-sandwich pinning
 * downstream still compares like for like.
 */
export async function readStrictFinalityAnchorV1(
  rpc: (method: string, params: readonly unknown[]) => Promise<unknown>,
  finalityConfirmations: number,
  label: string,
): Promise<FinalizedAnchorV1> {
  const readAnchorAtTag = async (blockTag: string) => {
    const anchor = parseStrictFinalizedAnchorV1(
      await rpc('eth_getBlockByNumber', Object.freeze([blockTag, false])),
      label,
    );
    return Object.freeze({
      number: anchorHeightV1(anchor),
      hash: anchor.blockHash as string,
      anchor,
    });
  };
  const resolved = await resolveEvmFinalityAnchorBlockV1({
    finalityConfirmations,
    readHead: () => readAnchorAtTag('latest'),
    readBlockAt: (anchorBlockNumber) => readAnchorAtTag(
      `0x${anchorBlockNumber.toString(16)}`,
    ),
    unavailable: (detail) => new CurrentFinalizedEvmCallErrorV1(
      'finalized-state-unavailable',
      `${label}: ${detail}`,
    ),
  });
  return resolved.anchor;
}

/**
 * A height the finality arithmetic can use, or `NaN` for one it cannot.
 *
 * `NaN` never equals the requested anchor and is never a safe integer, so the
 * shared resolver rejects it instead of comparing rounded values.
 */
function anchorHeightV1(anchor: FinalizedAnchorV1): number {
  const height = Number(anchor.blockNumber);
  return Number.isSafeInteger(height) ? height : Number.NaN;
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
