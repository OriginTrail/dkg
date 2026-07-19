import {
  assertCanonicalChainId,
  type BlockNumberV1,
  type ChainIdV1,
  type Digest32V1,
} from '@origintrail-official/dkg-core';

import {
  CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1,
  CONTROL_EIP1271_GAS_LIMIT_V1,
  CONTROL_EIP1271_MAX_ATTEMPTS_V1,
  CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1,
  CurrentFinalizedEvmCallErrorV1,
  type CurrentFinalizedEvmCallRequestV1,
  type CurrentFinalizedEvmCallResultV1,
} from './control-object-signature-verifier.js';
import {
  snapshotCurrentFinalizedEvmCallRequestV1,
  type CurrentFinalizedEvmChainAdapterV1,
} from './current-finalized-evm-call.js';

export const CURRENT_FINALIZED_EVM_BLOCK_REFERENCE_PROFILES_V1 = Object.freeze([
  'eip1898',
  'trusted-block-number-hash-sandwich',
] as const);

export type CurrentFinalizedEvmBlockReferenceProfileV1 =
  (typeof CURRENT_FINALIZED_EVM_BLOCK_REFERENCE_PROFILES_V1)[number];

export interface StrictCurrentFinalizedEvmRpcConfigV1 {
  /** Canonical decimal chain ID permanently bound to this adapter. */
  readonly chainId: ChainIdV1;
  /** Trusted local configuration, in canonical failover order. */
  readonly endpoints: readonly string[];
  /**
   * EIP-1898 is the default. The number/hash sandwich is an explicit trusted
   * chain profile for deployments whose RPC endpoints cannot execute EIP-1898.
   */
  readonly blockReferenceProfile?: CurrentFinalizedEvmBlockReferenceProfileV1;
}

interface StrictRpcConfigSnapshotV1 {
  readonly chainId: ChainIdV1;
  readonly endpoints: readonly string[];
  readonly blockReferenceProfile: CurrentFinalizedEvmBlockReferenceProfileV1;
}

interface FinalizedAnchorV1 {
  readonly blockNumber: BlockNumberV1;
  readonly blockNumberQuantity: string;
  readonly blockHash: Digest32V1;
}

interface DeadlineScope {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly close: () => void;
}

interface RpcErrorEnvelopeV1 {
  readonly code: number;
  readonly message: string;
}

const CONFIG_REQUIRED_KEYS = Object.freeze(['chainId', 'endpoints'] as const);
const CONFIG_OPTIONAL_KEYS = Object.freeze(['blockReferenceProfile'] as const);
const CANONICAL_LOWER_HEX_BYTES = /^0x(?:[0-9a-f]{2})*$/;
const CANONICAL_LOWER_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const CANONICAL_DIGEST_32 = /^0x[0-9a-f]{64}$/;
const MAX_U64 = 18_446_744_073_709_551_615n;
const MAX_U256 =
  115_792_089_237_316_195_423_570_985_008_687_907_853_269_984_665_640_564_039_457_584_007_913_129_639_935n;
const RPC_CALL_GAS_QUANTITY = `0x${CONTROL_EIP1271_GAS_LIMIT_V1.toString(16)}`;
const ANCHOR_DEPENDENT_RESOURCE_LIMITS_V1 = new WeakSet<object>();

/**
 * Build one strict raw-JSON-RPC adapter from trusted local chain configuration.
 *
 * This transport intentionally bypasses JsonRpcProvider, RpcFailoverClient,
 * and generic timeout wrappers: native fetch gives this lane a streamed
 * pre-parse body cap and an AbortSignal that cancels the actual HTTP I/O. POST
 * requests are never retried, redirected, reordered, or made sticky.
 */
export function createStrictCurrentFinalizedEvmChainAdapterV1(
  input: StrictCurrentFinalizedEvmRpcConfigV1,
): CurrentFinalizedEvmChainAdapterV1 {
  const config = snapshotConfig(input);

  const adapter: CurrentFinalizedEvmChainAdapterV1 = async (inputRequest) => {
    const request = snapshotCurrentFinalizedEvmCallRequestV1(inputRequest);
    if (request.chainId !== config.chainId) {
      throw new CurrentFinalizedEvmCallErrorV1(
        'chain-mismatch',
        `Adapter is configured for chain ${config.chainId}, not ${request.chainId}`,
      );
    }
    if (request.signal.aborted) {
      throw cancelled('Current-finalized EVM call was cancelled before transport admission');
    }

    const totalDeadline = createDeadlineScope(
      request.signal,
      request.totalDeadlineMs,
      'current-finalized total deadline',
    );
    let lastRetryableFailure: CurrentFinalizedEvmCallErrorV1 | undefined;

    try {
      for (let index = 0; index < config.endpoints.length; index += 1) {
        if (request.signal.aborted) {
          throw cancelled('Current-finalized EVM call was cancelled');
        }
        if (totalDeadline.timedOut()) {
          throw timedOut(`Current-finalized total deadline exceeded ${request.totalDeadlineMs}ms`);
        }

        const attemptDeadline = createDeadlineScope(
          totalDeadline.signal,
          request.attemptTimeoutMs,
          `current-finalized endpoint attempt ${index + 1}`,
        );
        try {
          const result = await executeEndpointAttempt(
            config,
            config.endpoints[index]!,
            request,
            attemptDeadline.signal,
          );
          // Close races where transport completion and abort/deadline become
          // observable in the same turn. A late response never escapes merely
          // because its promise callback ran before the timer callback.
          if (request.signal.aborted) {
            throw cancelled('Current-finalized EVM call was cancelled');
          }
          if (totalDeadline.timedOut()) {
            throw timedOut(
              `Current-finalized total deadline exceeded ${request.totalDeadlineMs}ms`,
            );
          }
          if (attemptDeadline.timedOut()) {
            throw timedOut(
              `Current-finalized endpoint attempt exceeded ${request.attemptTimeoutMs}ms`,
            );
          }
          return result;
        } catch (cause) {
          const failure = classifyAttemptFailure(
            cause,
            request.signal,
            totalDeadline,
            attemptDeadline,
          );
          if (isTerminalAttemptFailure(failure)) throw failure;
          lastRetryableFailure = failure;
        } finally {
          attemptDeadline.close();
        }
      }

      if (request.signal.aborted) {
        throw cancelled('Current-finalized EVM call was cancelled');
      }
      if (totalDeadline.timedOut()) {
        throw timedOut(`Current-finalized total deadline exceeded ${request.totalDeadlineMs}ms`);
      }
      throw lastRetryableFailure ?? unavailable('No configured current-finalized endpoint succeeded');
    } finally {
      totalDeadline.close();
    }
  };

  return Object.freeze(adapter);
}

async function executeEndpointAttempt(
  config: StrictRpcConfigSnapshotV1,
  endpoint: string,
  request: CurrentFinalizedEvmCallRequestV1,
  signal: AbortSignal,
): Promise<CurrentFinalizedEvmCallResultV1> {
  let requestId = 0;
  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    requestId += 1;
    return postJsonRpc(endpoint, requestId, method, params, request.maxRpcResponseBytes, signal);
  };

  const remoteChainId = parseChainId(await rpc('eth_chainId', Object.freeze([])));
  if (remoteChainId !== config.chainId) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'chain-mismatch',
      `Configured endpoint attempt reported chain ${remoteChainId}, expected ${config.chainId}`,
    );
  }

  const anchor = parseFinalizedAnchor(
    await rpc('eth_getBlockByNumber', Object.freeze(['finalized', false])),
    'current finalized header',
  );
  const callObject = Object.freeze({
    from: request.from,
    to: request.to,
    data: request.data,
    gas: RPC_CALL_GAS_QUANTITY,
  });

  let returnData: string;
  if (config.blockReferenceProfile === 'eip1898') {
    const blockReference = Object.freeze({
      blockHash: anchor.blockHash,
      requireCanonical: true as const,
    });
    const code = await rpc('eth_getCode', Object.freeze([request.to, blockReference]));
    assertDeployedCode(code);
    returnData = parseContractReturn(
      await rpc('eth_call', Object.freeze([callObject, blockReference])),
      request.maxReturnBytes,
    );
  } else {
    // Number-selected code/call evidence is not deterministic until the
    // same-endpoint post-read closes the hash sandwich. Hold anchor-dependent
    // outcomes until then, so a reorg cannot manufacture no-code/revert, a
    // malformed return, or an execution-cap failure and poison admission.
    let anchorDependentFailure: CurrentFinalizedEvmCallErrorV1 | undefined;
    let provisionalReturnData: string | undefined;
    try {
      const code = await rpc(
        'eth_getCode',
        Object.freeze([request.to, anchor.blockNumberQuantity]),
      );
      assertDeployedCode(code);
      provisionalReturnData = parseContractReturn(
        await rpc('eth_call', Object.freeze([callObject, anchor.blockNumberQuantity])),
        request.maxReturnBytes,
      );
    } catch (cause) {
      if (
        cause instanceof CurrentFinalizedEvmCallErrorV1
        && (
          cause.code === 'no-code'
          || cause.code === 'revert'
          || cause.code === 'malformed-return'
          || isAnchorDependentResourceLimit(cause)
        )
      ) {
        anchorDependentFailure = cause;
      } else {
        throw cause;
      }
    }

    const postAnchor = parseFinalizedAnchor(
      await rpc('eth_getBlockByNumber', Object.freeze([anchor.blockNumberQuantity, false])),
      'post-call numbered header',
    );
    if (
      postAnchor.blockNumber !== anchor.blockNumber
      || postAnchor.blockHash !== anchor.blockHash
    ) {
      throw new CurrentFinalizedEvmCallErrorV1(
        'finalized-state-unavailable',
        'Block-number fallback hash sandwich did not preserve the resolved finalized anchor',
      );
    }
    if (anchorDependentFailure !== undefined) throw anchorDependentFailure;
    if (provisionalReturnData === undefined) {
      throw unavailable('Block-number fallback produced no contract result');
    }
    returnData = provisionalReturnData;
  }

  return Object.freeze({
    chainId: config.chainId,
    blockNumber: anchor.blockNumber,
    blockHash: anchor.blockHash,
    returnData,
  });
}

async function postJsonRpc(
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
    // Discard the untrusted error body without reading it through the bounded
    // cap: a large 5xx HTML page must stay `rpc-unavailable` (failover-eligible)
    // rather than becoming a terminal `resource-limit` that halts the loop.
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

function parseChainId(input: unknown): ChainIdV1 {
  let parsed: bigint;
  try {
    parsed = parseCanonicalQuantity(input, MAX_U256);
  } catch (cause) {
    throw unavailable('eth_chainId returned a malformed chain ID', cause);
  }
  return parsed.toString(10) as ChainIdV1;
}

function parseFinalizedAnchor(input: unknown, label: string): FinalizedAnchorV1 {
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

function assertDeployedCode(input: unknown): void {
  if (typeof input !== 'string' || !CANONICAL_LOWER_HEX_BYTES.test(input)) {
    throw unavailable('eth_getCode returned malformed code bytes');
  }
  if (input === '0x') {
    throw new CurrentFinalizedEvmCallErrorV1(
      'no-code',
      'EIP-1271 issuer has no deployed code at the resolved finalized anchor',
    );
  }
}

function parseContractReturn(input: unknown, maxBytes: number): string {
  if (typeof input !== 'string' || !CANONICAL_LOWER_HEX_BYTES.test(input)) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'malformed-return',
      'EIP-1271 eth_call returned malformed bytes',
    );
  }
  const byteLength = (input.length - 2) / 2;
  if (byteLength > maxBytes || byteLength !== 32) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'malformed-return',
      `EIP-1271 eth_call returned ${byteLength} bytes; exactly 32 are required`,
    );
  }
  return input;
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
  return Object.freeze({ code: input.code, message: input.message });
}

function classifyJsonRpcError(
  method: string,
  error: RpcErrorEnvelopeV1,
): CurrentFinalizedEvmCallErrorV1 {
  const message = error.message.toLowerCase();
  // Explicit revert evidence is deterministic even when a gateway decorates
  // the message with gas-related text (for example, code 3 plus
  // "execution reverted: out of gas"). A fixed-cap exhaustion that did not
  // execute a REVERT remains a resource refusal below, but a proven REVERT
  // must win so callers cannot misclassify invalid EIP-1271 evidence as merely
  // unsupported.
  if (method === 'eth_call' && (error.code === 3 || message.includes('revert'))) {
    return new CurrentFinalizedEvmCallErrorV1(
      'revert',
      'EIP-1271 contract call reverted at the resolved finalized anchor',
    );
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
      'EIP-1271 execution could not complete within the fixed gas cap',
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

function classifyAttemptFailure(
  cause: unknown,
  callerSignal: AbortSignal,
  totalDeadline: DeadlineScope,
  attemptDeadline: DeadlineScope,
): CurrentFinalizedEvmCallErrorV1 {
  if (callerSignal.aborted) return cancelled('Current-finalized EVM call was cancelled');
  if (totalDeadline.timedOut()) {
    return timedOut(`Current-finalized total deadline exceeded ${CONTROL_EIP1271_TOTAL_DEADLINE_MS_V1}ms`);
  }
  if (attemptDeadline.timedOut()) {
    return timedOut(`Current-finalized endpoint attempt exceeded ${CONTROL_EIP1271_ATTEMPT_TIMEOUT_MS_V1}ms`);
  }
  if (cause instanceof CurrentFinalizedEvmCallErrorV1) return cause;
  return unavailable('Current-finalized endpoint attempt failed closed', cause);
}

function isTerminalAttemptFailure(error: CurrentFinalizedEvmCallErrorV1): boolean {
  return error.code === 'unsupported-chain'
    || error.code === 'resource-limit'
    || error.code === 'revert'
    || error.code === 'no-code'
    || error.code === 'malformed-return';
}

function createDeadlineScope(
  parent: AbortSignal,
  timeoutMs: number,
  label: string,
): DeadlineScope {
  const controller = new AbortController();
  let didTimeOut = false;
  const expiresAt = performance.now() + timeoutMs;
  const parentAbort = (): void => controller.abort(parent.reason);
  if (parent.aborted) parentAbort();
  else parent.addEventListener('abort', parentAbort, { once: true });
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new Error(`${label} exceeded ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  return Object.freeze({
    signal: controller.signal,
    timedOut: () => didTimeOut || performance.now() >= expiresAt,
    close: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', parentAbort);
    },
  });
}

function snapshotConfig(input: StrictCurrentFinalizedEvmRpcConfigV1): StrictRpcConfigSnapshotV1 {
  if (!isPlainRecord(input)) {
    throw new TypeError('Strict current-finalized RPC config must be a plain data record');
  }
  assertConfigDataProperties(input);
  try {
    assertCanonicalChainId(input.chainId, 'strict current-finalized chainId');
  } catch {
    throw new TypeError('Strict current-finalized chainId must be canonical decimal u256');
  }

  const endpoints = snapshotNormalizedEndpoints(input.endpoints);
  const blockReferenceProfile = input.blockReferenceProfile ?? 'eip1898';
  if (!CURRENT_FINALIZED_EVM_BLOCK_REFERENCE_PROFILES_V1.includes(blockReferenceProfile)) {
    throw new TypeError('Unsupported strict current-finalized block reference profile');
  }
  return Object.freeze({
    chainId: input.chainId,
    endpoints,
    blockReferenceProfile,
  });
}

function assertConfigDataProperties(input: Record<string, unknown>): void {
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('Strict current-finalized RPC config cannot contain symbol keys');
  }
  const allowed = new Set<string>([...CONFIG_REQUIRED_KEYS, ...CONFIG_OPTIONAL_KEYS]);
  if (
    !CONFIG_REQUIRED_KEYS.every((key) => keys.includes(key))
    || (keys as string[]).some((key) => !allowed.has(key))
  ) {
    throw new TypeError('Strict current-finalized RPC config has unknown or missing fields');
  }
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TypeError('Strict current-finalized RPC config fields must be enumerable data properties');
    }
  }
}

function snapshotNormalizedEndpoints(input: unknown): readonly string[] {
  const normalized: string[] = [];
  try {
    if (!Array.isArray(input)) throw new Error('not an array');
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
    if (
      lengthDescriptor === undefined
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || typeof lengthDescriptor.value !== 'number'
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) {
      throw new Error('invalid length');
    }
    const length = lengthDescriptor.value;
    const ownKeys = Reflect.ownKeys(input);
    if (
      ownKeys.length !== length + 1
      || ownKeys.some((key) => (
        typeof key !== 'string'
        || (key !== 'length' && !isCanonicalArrayIndex(key, length))
      ))
    ) {
      throw new Error('not a dense ordinary array');
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new Error('entry is not a data property');
      }
      const endpoint = normalizeEndpoint(descriptor.value);
      if (!normalized.includes(endpoint)) normalized.push(endpoint);
    }
  } catch (cause) {
    if (cause instanceof TypeError) throw cause;
    throw new TypeError('Strict current-finalized endpoints must be a dense data-only array');
  }
  if (normalized.length === 0 || normalized.length > CONTROL_EIP1271_MAX_ATTEMPTS_V1) {
    throw new TypeError(
      `Strict current-finalized RPC requires 1..${CONTROL_EIP1271_MAX_ATTEMPTS_V1} distinct endpoints`,
    );
  }
  return Object.freeze(normalized);
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function normalizeEndpoint(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new TypeError('Strict current-finalized RPC endpoint must be a nonempty URL string');
  }
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new TypeError('Strict current-finalized RPC endpoint must be an absolute URL');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hash !== '') {
    throw new TypeError('Strict current-finalized RPC endpoint must use HTTP(S) without a fragment');
  }
  return url.href;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unavailable(message: string, cause?: unknown): CurrentFinalizedEvmCallErrorV1 {
  return new CurrentFinalizedEvmCallErrorV1(
    'rpc-unavailable',
    message,
    cause === undefined ? undefined : { cause },
  );
}

function timedOut(message: string): CurrentFinalizedEvmCallErrorV1 {
  return new CurrentFinalizedEvmCallErrorV1('rpc-timeout', message);
}

function resourceLimited(message: string): CurrentFinalizedEvmCallErrorV1 {
  return new CurrentFinalizedEvmCallErrorV1('resource-limit', message);
}

function anchorDependentResourceLimited(message: string): CurrentFinalizedEvmCallErrorV1 {
  const error = resourceLimited(message);
  ANCHOR_DEPENDENT_RESOURCE_LIMITS_V1.add(error);
  return error;
}

function isAnchorDependentResourceLimit(
  error: CurrentFinalizedEvmCallErrorV1,
): boolean {
  return error.code === 'resource-limit'
    && ANCHOR_DEPENDENT_RESOURCE_LIMITS_V1.has(error);
}

function cancelled(message: string): CurrentFinalizedEvmCallErrorV1 {
  // Caller intent is authenticated by the verifier-owned AbortSignal. Keep
  // the adapter error retryable so a foreign gateway cannot forge a cancelled
  // disposition merely by throwing a public error code; the verifier observes
  // its caller signal first and maps this exact path to `cancelled`.
  return new CurrentFinalizedEvmCallErrorV1('rpc-unavailable', message);
}
