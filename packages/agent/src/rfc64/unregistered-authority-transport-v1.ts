// SPDX-License-Identifier: Apache-2.0

/**
 * RFC-64 unregistered-authority seed transport.
 *
 * A wallet-namespaced Context Graph (`0x<wallet>/<name>`) that is not
 * registered on-chain has its read authority defined by an owner-signed policy
 * envelope (the "seed"). Until now that seed travelled only through the
 * ontology system graph (durable sync / gossip), so a replica that connected
 * after the graph was created, or an edge that never syncs the ontology graph,
 * could not authenticate the graph and every subscribe attempt ended in
 * CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE.
 *
 * This is a narrow, policy-less query/response. The requester names one
 * (networkId, wallet-namespaced contextGraphId) scope and a provider answers
 * with the canonical signed envelope bytes it holds, or not-found. No held
 * policy is required on either side because the envelope is public and
 * self-authenticating: its issuer signature is checked against the wallet
 * prefix of the graph id and its payload is bound to the exact network and
 * graph. Holding the envelope grants nothing by itself; the requester must
 * still prove finalized on-chain absence through the existing reconcile path
 * before the policy is accepted.
 *
 * Bounded by construction: a 2 KiB request, a 4 KiB seed (the single
 * `RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1` bound the keyed store and
 * its SQL CHECK enforce) plus one status byte on the response, one keyed read
 * plus one signature recovery per request, and never an unbounded store scan.
 * The requester also hands the router that response cap as its per-call read
 * ceiling, so it stops buffering the moment a peer exceeds it. Non-wallet-
 * namespaced ids are rejected on both sides before any I/O: a signature must
 * never self-assign ownership of an arbitrary global name.
 *
 * This transport does not persist, accept, or schedule anything; the agent
 * owns persistence (keyed seed store) and acceptance (reconcile fences).
 */

import {
  assertContextGraphIdV1,
  assertNetworkIdV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type ProtocolRouter,
  type SendOptions,
  type SignedContextGraphPolicyEnvelopeV1,
  type SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';

import {
  assertRfc64ExactIssuerSignatureProofV1,
  createRfc64CatalogTransportWireAdapterV1,
  encodeRfc64FoundStatusResponseV1,
  parseRfc64StatusResponsePayloadV1,
  rethrowRfc64CatalogTransportWireUtilityErrorV1,
  type Rfc64CatalogTransportWireAdapterV1,
} from './catalog-transport-wire-v1-internal.js';
import {
  RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1,
  resolveRfc64WalletNamespaceOwnerV1,
} from './unregistered-authority-seed-store-v1.js';
import {
  Rfc64UnregisteredReplicaAuthorityErrorV1,
  authenticateRfc64UnregisteredReplicaAuthorityEnvelopeV1,
} from './unregistered-replica-authority-v1.js';

// One seed bound for the store, the SQL CHECK, the ontology carrier and this
// wire; re-exported so the package surface keeps its historical name.
export { RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1 };

/** `/catalog/1` is the declared wire-compat boundary shared with the other RFC-64 protocols. */
export const RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1 =
  '/dkg/catalog/1/unregistered-authority' as const;
export const RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1 =
  'rfc64-unregistered-authority-query-v1' as const;

export const RFC64_UNREGISTERED_AUTHORITY_QUERY_MAX_BYTES_V1 = 2 * 1024;
/**
 * Found response = one status byte + the canonical seed (~1.3 KiB, bounded by
 * the shared 4 KiB seed cap). Deliberately far below MAX_CONTROL_OBJECT_BYTES
 * (8 MiB) so neither side ever buffers or parses a large payload on this
 * policy-less path; the requester passes it to the router as its read ceiling.
 */
export const RFC64_UNREGISTERED_AUTHORITY_RESPONSE_MAX_BYTES_V1 =
  RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1 + 1;

/** Replica fan-out bounds: few peers, short per-peer deadline, first verified wins. */
export const RFC64_UNREGISTERED_AUTHORITY_MAX_FANOUT_PEERS_V1 = 8;
export const RFC64_UNREGISTERED_AUTHORITY_FANOUT_CONCURRENCY_V1 = 4;
export const RFC64_UNREGISTERED_AUTHORITY_PEER_TIMEOUT_MS_V1 = 5_000;
export const RFC64_UNREGISTERED_AUTHORITY_FANOUT_TIMEOUT_MS_V1 = 20_000;

const SEED_NOT_FOUND = 0;
const SEED_DENIED = 2;

const QUERY_KEYS = Object.freeze([
  'contextGraphId',
  'kind',
  'networkId',
] as const);

const SEED_WIRE: Rfc64CatalogTransportWireAdapterV1 =
  createRfc64CatalogTransportWireAdapterV1({
    fail,
    wireCode: 'unregistered-authority-wire',
    inputCode: 'unregistered-authority-input',
    messages: {
      encodePlainObject: 'RFC-64 unregistered-authority query must be a plain object',
      encodeFieldShape: 'RFC-64 unregistered-authority query accepts only string or null fields',
      encodeOversized: (maxBytes) => `RFC-64 unregistered-authority query exceeds ${maxBytes} bytes`,
      parseOversized: 'RFC-64 unregistered-authority query is empty or oversized',
      parseStrictJson: 'RFC-64 unregistered-authority query is not strict UTF-8 JSON',
      parsePlainObject: 'RFC-64 unregistered-authority query must be a plain JSON object',
      parseExactKeys: 'RFC-64 unregistered-authority query has missing or unknown fields',
      parseNoncanonical: 'RFC-64 unregistered-authority query bytes are not canonical JCS',
      snapshot: (wireError) => wireError.message.replace(
        'RFC-64 wire',
        'RFC-64 unregistered-authority query',
      ),
      evmAddress: (label) => `${label} must be a canonical lowercase nonzero EVM address`,
      peerIdType: 'remotePeerId must be a string',
      peerIdCanonical: 'remotePeerId is empty, oversized, or noncanonical',
    },
  });

export interface Rfc64UnregisteredAuthorityScopeV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
}

export interface Rfc64UnregisteredAuthorityQueryV1 extends Rfc64UnregisteredAuthorityScopeV1 {
  readonly kind: typeof RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1;
}

/** One authenticated seed: exact owner, exact scope, exact issuer proof, exact bytes. */
export interface Rfc64VerifiedUnregisteredAuthoritySeedV1 extends Rfc64UnregisteredAuthorityScopeV1 {
  readonly ownerAddress: EvmAddressV1;
  readonly policyDigest: Digest32V1;
  readonly envelope: SignedContextGraphPolicyEnvelopeV1;
  readonly issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
  readonly canonicalBytes: Uint8Array;
}

export type Rfc64UnregisteredAuthorityVerifyIssuerSignatureV1 = (
  envelope: SignedControlEnvelopeV1,
) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;

export interface Rfc64UnregisteredAuthorityTransportOptionsV1 {
  /**
   * Point lookup of the locally held canonical seed bytes for one scope. This
   * must be a keyed read (never an unbounded store scan) and is consulted only
   * after the query parsed as a wallet-namespaced scope.
   */
  readonly readSeedEnvelopeBytes: (
    scope: Rfc64UnregisteredAuthorityScopeV1,
    signal?: AbortSignal,
  ) => Promise<Uint8Array | null>;
  readonly verifyIssuerSignature: Rfc64UnregisteredAuthorityVerifyIssuerSignatureV1;
  /**
   * Kill-switch style serving gate. Defaults to serving. This is deliberately
   * NOT a requester policy check: a bootstrapping replica holds no policy yet.
   */
  readonly isServingAllowed?: (contextGraphId: ContextGraphIdV1) => boolean;
}

export const RFC64_UNREGISTERED_AUTHORITY_ERROR_CODES_V1 = Object.freeze([
  'unregistered-authority-input',
  'unregistered-authority-wire',
  'unregistered-authority-denied',
  'unregistered-authority-signature',
  'unregistered-authority-mismatch',
  'unregistered-authority-state',
] as const);

export type Rfc64UnregisteredAuthorityErrorCodeV1 =
  (typeof RFC64_UNREGISTERED_AUTHORITY_ERROR_CODES_V1)[number];

export class Rfc64UnregisteredAuthorityTransportErrorV1 extends Error {
  constructor(
    readonly code: Rfc64UnregisteredAuthorityErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64UnregisteredAuthorityTransportErrorV1';
  }
}

/**
 * The only admissible owner derivation: the lowercase wallet prefix of the CG
 * id (the keyed store's wallet-namespace grammar, so the wire, the store and
 * the ontology loader agree by construction). Null for every other id.
 */
export function rfc64UnregisteredAuthorityOwnerV1(
  contextGraphId: string,
): EvmAddressV1 | null {
  return resolveRfc64WalletNamespaceOwnerV1(contextGraphId);
}

/**
 * Authenticate canonical seed bytes against one exact scope. Shared by the
 * responder (before serving), the requester (before persisting), and the
 * deprecated ontology-carrier fallback. The checks themselves are the single
 * predicate in unregistered-replica-authority-v1.ts (byte bound, canonical
 * parse, issuer signature through the injected verifier, owner == wallet
 * prefix, network/graph binding, generation-0 public-policy shape); this
 * layer only maps its failure codes onto the wire error codes and binds the
 * returned proof to the exact envelope.
 */
export async function authenticateRfc64UnregisteredAuthorityEnvelopeV1(
  canonicalBytes: Uint8Array,
  scopeInput: Rfc64UnregisteredAuthorityScopeV1,
  verifyIssuerSignature: Rfc64UnregisteredAuthorityVerifyIssuerSignatureV1,
  signal?: AbortSignal,
): Promise<Rfc64VerifiedUnregisteredAuthoritySeedV1> {
  throwIfAborted(signal);
  const scope = validateScope(scopeInput);
  let authenticated;
  try {
    authenticated = await authenticateRfc64UnregisteredReplicaAuthorityEnvelopeV1(canonicalBytes, {
      networkId: scope.networkId,
      contextGraphId: scope.contextGraphId,
      signal,
      verifyIssuerSignature,
    });
  } catch (cause) {
    throwIfAborted(signal);
    if (!(cause instanceof Rfc64UnregisteredReplicaAuthorityErrorV1)) throw cause;
    switch (cause.code) {
      case 'seed-bytes':
        fail('unregistered-authority-wire', 'unregistered-authority seed bytes are empty or oversized', cause);
      case 'not-wallet-namespaced':
        fail(
          'unregistered-authority-wire',
          'RFC-64 unregistered-authority scope must name a wallet-namespaced Context Graph',
          cause,
        );
      case 'seed-canonical':
        fail(
          'unregistered-authority-wire',
          'unregistered-authority seed is not a canonical signed Context Graph policy envelope',
          cause,
        );
      case 'issuer-signature':
        fail('unregistered-authority-signature', 'unregistered-authority seed issuer signature failed', cause);
      default:
        // owner-mismatch, scope-mismatch, policy-shape: the signature proves
        // who signed; what they signed is not the public generation-0 policy
        // of THIS graph on THIS network owned by the wallet the id names.
        fail(
          'unregistered-authority-mismatch',
          'unregistered-authority seed is not the owner-signed public generation-0 policy of the requested graph',
          cause,
        );
    }
  }
  throwIfAborted(signal);
  const { envelope, issuerSignature } = authenticated;
  try {
    assertRfc64ExactIssuerSignatureProofV1(envelope, issuerSignature);
  } catch (cause) {
    rethrowRfc64CatalogTransportWireUtilityErrorV1(cause, fail, {
      'issuer-proof-unminted': {
        code: 'unregistered-authority-signature',
        message: 'issuer signature proof was not minted by the verifier',
      },
    }, {
      code: 'unregistered-authority-signature',
      message: 'issuer signature proof is not bound to the exact seed envelope',
    });
  }
  return Object.freeze({
    networkId: scope.networkId,
    contextGraphId: scope.contextGraphId,
    ownerAddress: authenticated.ownerAddress,
    policyDigest: authenticated.policyDigest,
    envelope,
    issuerSignature,
    canonicalBytes: authenticated.canonicalEnvelopeBytes,
  });
}

/**
 * Policy-less seed query/response on a production ProtocolRouter. A returned
 * seed is authenticated but NOT accepted: the caller persists it and lets the
 * existing finalized-absence reconcile decide.
 */
export class Rfc64UnregisteredAuthorityTransportV1 {
  #started = false;
  readonly #isServingAllowed: (contextGraphId: ContextGraphIdV1) => boolean;

  constructor(
    private readonly router: ProtocolRouter,
    private readonly options: Rfc64UnregisteredAuthorityTransportOptionsV1,
  ) {
    if (typeof options?.readSeedEnvelopeBytes !== 'function') {
      fail('unregistered-authority-input', 'readSeedEnvelopeBytes must be a function');
    }
    if (typeof options.verifyIssuerSignature !== 'function') {
      fail('unregistered-authority-input', 'verifyIssuerSignature must be a function');
    }
    if (
      options.isServingAllowed !== undefined
      && typeof options.isServingAllowed !== 'function'
    ) {
      fail('unregistered-authority-input', 'isServingAllowed must be a function when configured');
    }
    this.#isServingAllowed = options.isServingAllowed ?? (() => true);
  }

  get started(): boolean {
    return this.#started;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    try {
      this.router.register(
        RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1,
        async (data, peerId, handlerOptions) =>
          this.handleQuery(data, peerId.toString(), handlerOptions?.signal),
        { maxReadBytes: RFC64_UNREGISTERED_AUTHORITY_QUERY_MAX_BYTES_V1 },
      );
    } catch (cause) {
      this.#started = false;
      this.router.unregister(RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1);
      throw cause;
    }
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.router.unregister(RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1);
  }

  /**
   * Ask one peer for the seed of one scope. Resolves null on not-found and
   * throws on denial, wire, signature, or scope-mismatch failures so the
   * caller's fan-out treats every non-verified answer as a per-peer failure.
   */
  async fetchUnregisteredAuthority(
    remotePeerIdInput: string,
    scopeInput: Rfc64UnregisteredAuthorityScopeV1,
    sendOptions?: SendOptions,
  ): Promise<Rfc64VerifiedUnregisteredAuthoritySeedV1 | null> {
    this.requireStarted();
    const remotePeerId = snapshotPeerId(remotePeerIdInput);
    const scope = validateScope(scopeInput);
    // Reject non-wallet ids before any network I/O.
    const query = parseQuery(encodeQuery({
      kind: RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1,
      networkId: scope.networkId,
      contextGraphId: scope.contextGraphId,
    }));
    // The router stops reading at the v1 response cap instead of buffering up
    // to its router-wide default; a per-call cap can only tighten that limit.
    const response = await this.router.send(
      remotePeerId,
      RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1,
      encodeQuery(query),
      { ...sendOptions, maxReadBytes: RFC64_UNREGISTERED_AUTHORITY_RESPONSE_MAX_BYTES_V1 },
    );
    const payload = parseResponse(response);
    if (payload === null) return null;
    return authenticateRfc64UnregisteredAuthorityEnvelopeV1(
      payload,
      query,
      this.options.verifyIssuerSignature,
      sendOptions?.signal,
    );
  }

  private async handleQuery(
    data: Uint8Array,
    remotePeerIdInput: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    throwIfAborted(signal);
    this.requireStarted();
    snapshotPeerId(remotePeerIdInput);
    // parseQuery rejects non-wallet-namespaced ids before the store is touched.
    const query = parseQuery(data);
    if (!this.#isServingAllowed(query.contextGraphId)) {
      return Uint8Array.of(SEED_DENIED);
    }
    throwIfAborted(signal);

    let stored: Uint8Array | null;
    try {
      stored = await this.options.readSeedEnvelopeBytes(
        Object.freeze({ networkId: query.networkId, contextGraphId: query.contextGraphId }),
        signal,
      );
    } catch (cause) {
      fail('unregistered-authority-state', 'unregistered-authority seed lookup failed', cause);
    }
    throwIfAborted(signal);
    if (stored === null) return Uint8Array.of(SEED_NOT_FOUND);

    // Re-authenticate before serving so corrupt, foreign, or replayed local
    // bytes never leave this node. A failure aborts the stream (fail closed)
    // rather than answering not-found, so it stays observable in router logs.
    const verified = await authenticateRfc64UnregisteredAuthorityEnvelopeV1(
      stored,
      query,
      this.options.verifyIssuerSignature,
      signal,
    );
    throwIfAborted(signal);
    return foundResponse(verified.canonicalBytes);
  }

  private requireStarted(): void {
    if (!this.#started) {
      fail('unregistered-authority-state', 'RFC-64 unregistered-authority transport is not started');
    }
  }
}

export function encodeRfc64UnregisteredAuthorityQueryV1(
  input: Rfc64UnregisteredAuthorityQueryV1,
): Uint8Array {
  return encodeQuery(input);
}

export function parseRfc64UnregisteredAuthorityQueryV1(
  input: Uint8Array,
): Rfc64UnregisteredAuthorityQueryV1 {
  return parseQuery(input);
}

function encodeQuery(input: Rfc64UnregisteredAuthorityQueryV1): Uint8Array {
  const snapshot = validateQuery(input);
  return SEED_WIRE.encodeFlatCanonicalJson(
    snapshot,
    RFC64_UNREGISTERED_AUTHORITY_QUERY_MAX_BYTES_V1,
  );
}

function parseQuery(input: Uint8Array): Rfc64UnregisteredAuthorityQueryV1 {
  const parsed = SEED_WIRE.parseFlatCanonicalJson(
    input,
    QUERY_KEYS,
    RFC64_UNREGISTERED_AUTHORITY_QUERY_MAX_BYTES_V1,
  );
  return validateQuery(parsed);
}

function validateQuery(value: unknown): Rfc64UnregisteredAuthorityQueryV1 {
  // Consume caller-owned values exactly once through own data descriptors so a
  // switching Proxy cannot emit bytes that were never validated.
  const snapshot = SEED_WIRE.snapshotExactWireRecord(value, QUERY_KEYS);
  if (snapshot.kind !== RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1) {
    fail(
      'unregistered-authority-wire',
      `RFC-64 unregistered-authority query kind must be ${RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1}`,
    );
  }
  const scope = validateScope({
    networkId: snapshot.networkId as NetworkIdV1,
    contextGraphId: snapshot.contextGraphId as ContextGraphIdV1,
  });
  return Object.freeze({
    kind: RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1,
    networkId: scope.networkId,
    contextGraphId: scope.contextGraphId,
  });
}

function validateScope(value: Rfc64UnregisteredAuthorityScopeV1): Rfc64UnregisteredAuthorityScopeV1 {
  let networkId: unknown;
  let contextGraphId: unknown;
  try {
    networkId = value.networkId;
    contextGraphId = value.contextGraphId;
    assertNetworkIdV1(networkId);
    assertContextGraphIdV1(contextGraphId);
  } catch (cause) {
    fail('unregistered-authority-wire', 'RFC-64 unregistered-authority scope contains an invalid scalar', cause);
  }
  if (rfc64UnregisteredAuthorityOwnerV1(contextGraphId) === null) {
    fail(
      'unregistered-authority-wire',
      'RFC-64 unregistered-authority scope must name a wallet-namespaced Context Graph',
    );
  }
  return Object.freeze({ networkId, contextGraphId });
}

function foundResponse(canonicalBytes: Uint8Array): Uint8Array {
  try {
    return encodeRfc64FoundStatusResponseV1(
      canonicalBytes,
      RFC64_UNREGISTERED_AUTHORITY_RESPONSE_MAX_BYTES_V1,
    );
  } catch (cause) {
    fail('unregistered-authority-wire', 'unregistered-authority response exceeds its v1 cap', cause);
  }
}

function parseResponse(input: Uint8Array): Uint8Array | null {
  let framed;
  try {
    framed = parseRfc64StatusResponsePayloadV1(
      input,
      RFC64_UNREGISTERED_AUTHORITY_RESPONSE_MAX_BYTES_V1,
    );
  } catch (cause) {
    rethrowRfc64CatalogTransportWireUtilityErrorV1(cause, fail, {
      'response-trailing': {
        code: 'unregistered-authority-wire',
        message: input[0] === SEED_NOT_FOUND
          ? 'not-found unregistered-authority response has trailing bytes'
          : 'denied unregistered-authority response has trailing bytes',
      },
      'response-status': {
        code: 'unregistered-authority-wire',
        message: 'unregistered-authority response has an invalid status',
      },
    }, {
      code: 'unregistered-authority-wire',
      message: 'unregistered-authority response is empty or oversized',
    });
  }
  if (framed.status === 'not-found') return null;
  if (framed.status === 'denied') {
    fail('unregistered-authority-denied', 'remote peer denied the unregistered-authority query');
  }
  return framed.payload;
}

function snapshotPeerId(value: unknown): string {
  return SEED_WIRE.snapshotPeerId(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('RFC-64 unregistered-authority request was aborted', {
    cause: signal.reason,
  });
}

function fail(
  code: Rfc64UnregisteredAuthorityErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64UnregisteredAuthorityTransportErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
