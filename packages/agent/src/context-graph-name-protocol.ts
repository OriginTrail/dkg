// SPDX-License-Identifier: Apache-2.0

/**
 * `/dkg/10.0.0/context-graph-name/1`: ask a peer for the cleartext id behind
 * an on-chain Context Graph name hash.
 *
 * The protocol is optional. A node that does not register it simply does not
 * advertise it through identify; requesters skip such peers without dialing,
 * logging or penalising them. It is versioned twice: by the protocol id and by
 * the `version` field of every message.
 *
 * Privacy contract (responder):
 *  - Answer only for a graph this node already keys under a cleartext id whose
 *    exact commitment is the requested hash (a local map lookup: a peer asking
 *    about random hashes costs a Map read, nothing more).
 *  - Reveal it only when this node's own authority state proves the graph's
 *    on-chain access policy is PUBLIC (0). Curated/private graphs keep their
 *    cleartext private by design.
 *  - Every other outcome, including private, unknown policy, unregistered,
 *    unavailable, "never heard of it" and "too many policy reads in flight",
 *    is the same `not-found`. A distinct answer would tell the requester that
 *    this node is a member of a private graph. Load shedding is no exception:
 *    only a request for a graph this node holds ever reaches the policy-read
 *    bound, so a separate `busy` reply would itself be a membership oracle.
 *
 * Requesters never trust an answer: `verifyContextGraphNameCandidate` checks
 * `keccak256(utf8(answer)) === nameHash` before anything is adopted.
 */

import {
  CONTEXT_GRAPH_NAME_CANDIDATE_MAX_LENGTH,
  normalizeContextGraphNameHash,
  verifyContextGraphNameCandidate,
} from './context-graph-name-candidate.js';

export const PROTOCOL_CONTEXT_GRAPH_NAME = '/dkg/10.0.0/context-graph-name/1';
export const CONTEXT_GRAPH_NAME_PROTOCOL_VERSION = 1;
/** A request is one version number and one 66-character hash. */
export const CONTEXT_GRAPH_NAME_MAX_REQUEST_BYTES = 256;
/** A response carries at most one id of at most 256 characters (UTF-8 safe). */
export const CONTEXT_GRAPH_NAME_MAX_RESPONSE_BYTES = 2_048;
const CONTEXT_GRAPH_NAME_POLICY_READ_TIMEOUT_MS = 5_000;
const CONTEXT_GRAPH_NAME_MAX_CONCURRENT_POLICY_READS = 4;

export interface ContextGraphNameRequest {
  readonly version: typeof CONTEXT_GRAPH_NAME_PROTOCOL_VERSION;
  readonly nameHash: string;
}

/**
 * `invalid-request` depends only on the request bytes, never on local state.
 * There is deliberately no `busy`: see the privacy contract above.
 */
export type ContextGraphNameResponse =
  | { readonly version: 1; readonly status: 'found'; readonly contextGraphId: string }
  | { readonly version: 1; readonly status: 'not-found' | 'invalid-request' };

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function parseBoundedJson(bytes: Uint8Array, limit: number): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > limit) {
    return undefined;
  }
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return undefined;
  }
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

export function encodeContextGraphNameRequest(nameHash: string): Uint8Array {
  const normalized = normalizeContextGraphNameHash(nameHash);
  if (normalized === null) throw new Error('Invalid Context Graph name hash');
  const request: ContextGraphNameRequest = {
    version: CONTEXT_GRAPH_NAME_PROTOCOL_VERSION,
    nameHash: normalized,
  };
  return encoder.encode(JSON.stringify(request));
}

/** Strict request decoder: exact keys, current version, well-formed hash. */
export function decodeContextGraphNameRequest(bytes: Uint8Array): ContextGraphNameRequest | null {
  const value = plainRecord(parseBoundedJson(bytes, CONTEXT_GRAPH_NAME_MAX_REQUEST_BYTES));
  if (value === undefined || !hasExactKeys(value, ['version', 'nameHash'])) return null;
  if (value.version !== CONTEXT_GRAPH_NAME_PROTOCOL_VERSION) return null;
  const nameHash = normalizeContextGraphNameHash(value.nameHash);
  return nameHash === null
    ? null
    : { version: CONTEXT_GRAPH_NAME_PROTOCOL_VERSION, nameHash };
}

export function encodeContextGraphNameResponse(response: ContextGraphNameResponse): Uint8Array {
  return encoder.encode(JSON.stringify(response));
}

/**
 * Strict response decoder. Anything that is not a well-formed version-1
 * message decodes to null, which callers treat like `not-found`. The id is
 * only shape-checked here; the caller still verifies its commitment.
 */
export function decodeContextGraphNameResponse(bytes: Uint8Array): ContextGraphNameResponse | null {
  const value = plainRecord(parseBoundedJson(bytes, CONTEXT_GRAPH_NAME_MAX_RESPONSE_BYTES));
  if (value === undefined || value.version !== CONTEXT_GRAPH_NAME_PROTOCOL_VERSION) return null;
  if (value.status === 'found') {
    if (
      !hasExactKeys(value, ['version', 'status', 'contextGraphId'])
      || typeof value.contextGraphId !== 'string'
      || value.contextGraphId.length === 0
      || value.contextGraphId.length > CONTEXT_GRAPH_NAME_CANDIDATE_MAX_LENGTH
    ) return null;
    return { version: 1, status: 'found', contextGraphId: value.contextGraphId };
  }
  if (
    (value.status === 'not-found' || value.status === 'invalid-request')
    && hasExactKeys(value, ['version', 'status'])
  ) {
    return { version: 1, status: value.status };
  }
  return null;
}

/** What a responder needs from its node. Both hooks must fail closed. */
export interface ContextGraphNameRevealSource {
  /**
   * The local cleartext id this node keys the graph under, found by a pure
   * in-memory lookup of the name hash. Null when unknown or when this node
   * itself only knows the hash.
   */
  lookupLocalContextGraphId(nameHash: string): string | null;
  /**
   * True only when this node's own authority state proves the graph's
   * on-chain access policy is public. Private, unknown and unavailable must
   * all be false (or throw, which is treated as false).
   */
  isPublicContextGraph(contextGraphId: string, signal: AbortSignal): Promise<boolean>;
}

export interface ContextGraphNameHandlerOptions {
  readonly maxConcurrentPolicyReads?: number;
  readonly policyReadTimeoutMs?: number;
}

/** Build the protocol handler. It never throws: every outcome is a response. */
export function createContextGraphNameRequestHandler(
  source: ContextGraphNameRevealSource,
  options: ContextGraphNameHandlerOptions = {},
): (data: Uint8Array, peer?: unknown, handlerOptions?: { signal?: AbortSignal }) => Promise<Uint8Array> {
  const maxConcurrent = options.maxConcurrentPolicyReads ?? CONTEXT_GRAPH_NAME_MAX_CONCURRENT_POLICY_READS;
  const timeoutMs = options.policyReadTimeoutMs ?? CONTEXT_GRAPH_NAME_POLICY_READ_TIMEOUT_MS;
  const notFound = encodeContextGraphNameResponse({ version: 1, status: 'not-found' });
  let inflight = 0;
  return async (data, _peer, handlerOptions) => {
    const request = decodeContextGraphNameRequest(data);
    if (request === null) {
      return encodeContextGraphNameResponse({ version: 1, status: 'invalid-request' });
    }
    let localId: string | null;
    try {
      localId = source.lookupLocalContextGraphId(request.nameHash);
    } catch {
      return notFound;
    }
    // Reveal only the exact preimage of the requested commitment.
    const contextGraphId = verifyContextGraphNameCandidate(localId, request.nameHash);
    if (contextGraphId === null) return notFound;
    // Shed load with the ordinary refusal. Only held graphs get this far, so
    // any distinct overload answer would reveal that this node holds one.
    if (inflight >= maxConcurrent) return notFound;
    inflight += 1;
    try {
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = handlerOptions?.signal === undefined
        ? deadline
        : AbortSignal.any([deadline, handlerOptions.signal]);
      const isPublic = await source.isPublicContextGraph(contextGraphId, signal)
        .catch(() => false);
      return isPublic === true
        ? encodeContextGraphNameResponse({ version: 1, status: 'found', contextGraphId })
        : notFound;
    } finally {
      inflight -= 1;
    }
  };
}
