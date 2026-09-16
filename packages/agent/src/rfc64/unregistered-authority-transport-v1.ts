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
 * Bounded by construction: a 2 KiB request, a 16 KiB response, one keyed read
 * plus one signature recovery per request, and never an unbounded store scan.
 * Non-wallet-namespaced ids are rejected on both sides before any I/O: a
 * signature must never self-assign ownership of an arbitrary global name.
 *
 * This transport does not persist, accept, or schedule anything; the agent
 * owns persistence (keyed seed store) and acceptance (reconcile fences).
 */

import {
  assertContextGraphIdV1,
  assertNetworkIdV1,
  parseCanonicalSignedContextGraphPolicyEnvelopeV1,
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

/** `/catalog/1` is the declared wire-compat boundary shared with the other RFC-64 protocols. */
export const RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1 =
  '/dkg/catalog/1/unregistered-authority' as const;
export const RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1 =
  'rfc64-unregistered-authority-query-v1' as const;

export const RFC64_UNREGISTERED_AUTHORITY_QUERY_MAX_BYTES_V1 = 2 * 1024;
/**
 * A seed envelope is ~1.3 KB. This cap is deliberately far below
 * MAX_CONTROL_OBJECT_BYTES (8 MiB) so neither side ever buffers or parses a
 * large payload on this policy-less path.
 */
export const RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1 = 16 * 1024;
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

/**
 * Only wallet-namespaced CG ids carry an independently checkable owner before
 * registration. Mirrors the ontology loader's gate in
 * unregistered-replica-authority-v1.ts; both must stay identical.
 */
const EVM_ADDRESS_PREFIXED_CONTEXT_GRAPH_V1 = /^(0x[0-9a-f]{40})(?:\/|$)/iu;

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
 * id. Returns null for every non-wallet-namespaced id.
 */
export function rfc64UnregisteredAuthorityOwnerV1(
  contextGraphId: string,
): EvmAddressV1 | null {
  const owner = contextGraphId.match(EVM_ADDRESS_PREFIXED_CONTEXT_GRAPH_V1)?.[1]?.toLowerCase();
  return owner === undefined ? null : owner as EvmAddressV1;
}

/**
 * Authenticate canonical seed bytes against one exact scope. Shared by the
 * responder (before serving), the requester (before persisting), and the
 * deprecated ontology-carrier fallback, so all three run identical checks:
 * canonical parse under the seed cap, issuer signature, exact issuer proof,
 * owner == wallet prefix, network/graph binding, and the unregistered
 * generation-0 public-policy shape the ontology loader accepts.
 */
export async function authenticateRfc64UnregisteredAuthorityEnvelopeV1(
  canonicalBytes: Uint8Array,
  scopeInput: Rfc64UnregisteredAuthorityScopeV1,
  verifyIssuerSignature: Rfc64UnregisteredAuthorityVerifyIssuerSignatureV1,
  signal?: AbortSignal,
): Promise<Rfc64VerifiedUnregisteredAuthoritySeedV1> {
  throwIfAborted(signal);
  const scope = validateScope(scopeInput);
  const expectedOwner = rfc64UnregisteredAuthorityOwnerV1(scope.contextGraphId);
  if (expectedOwner === null) {
    fail(
      'unregistered-authority-input',
      'only wallet-namespaced Context Graph ids carry an owner-signed unregistered authority',
    );
  }
  if (
    !(canonicalBytes instanceof Uint8Array)
    || canonicalBytes.byteLength === 0
    || canonicalBytes.byteLength > RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1
  ) {
    fail('unregistered-authority-wire', 'unregistered-authority seed bytes are empty or oversized');
  }

  let envelope: SignedContextGraphPolicyEnvelopeV1;
  try {
    envelope = parseCanonicalSignedContextGraphPolicyEnvelopeV1(canonicalBytes, {
      maxBytes: RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1,
    });
  } catch (cause) {
    fail(
      'unregistered-authority-wire',
      'unregistered-authority seed is not a canonical signed Context Graph policy envelope',
      cause,
    );
  }

  let issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
  try {
    issuerSignature = await verifyIssuerSignature(envelope);
  } catch (cause) {
    fail('unregistered-authority-signature', 'unregistered-authority seed issuer signature failed', cause);
  }
  throwIfAborted(signal);
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

  // Exactly the ontology loader's acceptance predicate
  // (unregistered-replica-authority-v1.ts). The signature proves who signed;
  // this proves what they signed is the public generation-0 policy of THIS
  // graph on THIS network, owned by the wallet the id names.
  const owner = envelope.issuer.toLowerCase();
  const policy = envelope.payload;
  if (
    owner !== expectedOwner
    || policy.networkId !== scope.networkId
    || policy.contextGraphId !== scope.contextGraphId
    || policy.source.kind !== 'owner-signed-unregistered'
    || policy.source.ownerAddress !== owner
    || policy.source.ownerAuthorityEra !== '0'
    || policy.governanceChainId !== null
    || policy.governanceContractAddress !== null
    || policy.ownershipTransitionDigest !== null
    || policy.era !== '0'
    || policy.version !== '0'
    || policy.previousPolicyDigest !== null
    || policy.accessPolicy !== 0
  ) {
    fail(
      'unregistered-authority-mismatch',
      'unregistered-authority seed is not the owner-signed public generation-0 policy of the requested graph',
    );
  }
  return Object.freeze({
    networkId: scope.networkId,
    contextGraphId: scope.contextGraphId,
    ownerAddress: expectedOwner,
    policyDigest: envelope.objectDigest as Digest32V1,
    envelope,
    issuerSignature,
    canonicalBytes: Uint8Array.from(canonicalBytes),
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
    const response = await this.router.send(
      remotePeerId,
      RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1,
      encodeQuery(query),
      sendOptions,
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
