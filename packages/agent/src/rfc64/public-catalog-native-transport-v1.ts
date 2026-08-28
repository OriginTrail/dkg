// SPDX-License-Identifier: Apache-2.0

/**
 * RFC-64 catalog content transport.
 *
 * This is the digest-following half of the Gate-1 transport. A catalog-head
 * announcement still travels through `Rfc64PublicCatalogTransportV1`; after the
 * receiver verifies that exact head it uses this transport to fetch the signed
 * directory/bucket objects committed by the head and the opaque KA bundle
 * committed by a selected catalog row.
 *
 * The two protocols are deliberately additive and policy gated. Responses are
 * re-bound to exact digests locally, so an announcement or provider response
 * never grants catalog or activation authority by itself.
 */

import {
  MAX_CONTROL_OBJECT_BYTES,
  ProtocolRouter,
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertContextGraphIdV1,
  assertNetworkIdV1,
  assertSignedControlEnvelope,
  assertSubGraphNameV1,
  canonicalizeSignedControlEnvelopeBytes,
  decodeOpaqueKaBundleV1,
  parseCanonicalDecimalU64,
  parseCanonicalSignedControlEnvelope,
  type ContextGraphIdV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type SendOptions,
  type SignedControlEnvelopeV1,
  type SubGraphNameV1,
} from '@origintrail-official/dkg-core';
import {
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';

import type {
  Rfc64CatalogAccessAuthorizationV1,
  Rfc64CatalogAccessPolicyRegistryV1,
} from './catalog-access-policy-v1.js';
import {
  normalizeRfc64CatalogTransportAuthorizerV1,
  recheckCurrentRfc64CatalogPolicyAfterAwaitV1,
} from './catalog-transport-authorization-v1.js';
import type { Rfc64AuthorizedCatalogWorkResultV1 } from './catalog-transport-authorization-v1.js';
import {
  isMintedRfc64CatalogNativeScopedReadCapabilityV1,
  type Rfc64CatalogNativeScopedReadCapabilityV1,
} from './catalog-native-scoped-read-capability-v1-internal.js';
import {
  assertRfc64ExactIssuerSignatureProofV1,
  createRfc64CatalogTransportWireAdapterV1,
  encodeRfc64FoundStatusResponseV1,
  parseRfc64StatusResponsePayloadV1,
  rethrowRfc64CatalogTransportWireUtilityErrorV1,
  type Rfc64CatalogTransportWireAdapterV1,
} from './catalog-transport-wire-v1-internal.js';

export const RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1 =
  '/dkg/catalog/1/control-object/by-digest' as const;
export const RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1 =
  '/dkg/catalog/1/ka-bundle/by-digest' as const;
export const RFC64_CATALOG_OBJECT_FETCH_PROTOCOL_V2 =
  '/dkg/catalog/2/control-object/by-scope' as const;
export const RFC64_CATALOG_BUNDLE_FETCH_PROTOCOL_V2 =
  '/dkg/catalog/2/ka-bundle/by-scope' as const;

export const RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1 =
  'rfc64-public-catalog-object-fetch-v1' as const;
export const RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1 =
  'rfc64-public-catalog-bundle-fetch-v1' as const;
export const RFC64_CATALOG_OBJECT_FETCH_KIND_V2 =
  'rfc64-catalog-object-fetch-v2' as const;
export const RFC64_CATALOG_BUNDLE_FETCH_KIND_V2 =
  'rfc64-catalog-bundle-fetch-v2' as const;

export const RFC64_PUBLIC_CATALOG_NATIVE_FETCH_REQUEST_MAX_BYTES_V1 = 4 * 1024;
export const RFC64_PUBLIC_CATALOG_OBJECT_FETCH_RESPONSE_MAX_BYTES_V1 =
  MAX_CONTROL_OBJECT_BYTES + 1;
/** First vertical slice resource ceiling; protocol descriptors may advertise more. */
export const RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_RESPONSE_MAX_BYTES_V1 =
  8 * 1024 * 1024;
/**
 * Maximum logical bytes in every complete bundle committed by one exact-set
 * successor. This keeps the 1..1,024-row slice useful for small assets while
 * bounding a producer/receiver batch to 64 MiB (eight maximum-size bundles,
 * or 1,024 bundles averaging 64 KiB).
 */
export const RFC64_PUBLIC_CATALOG_EXACT_SET_BUNDLE_BYTES_MAX_V1 =
  64 * 1024 * 1024;

/** Add one canonical signed-row byte length to the shared V1 exact-set budget. */
export function addRfc64PublicCatalogExactSetBundleBytesV1(
  currentTotal: bigint,
  byteLength: DecimalU64V1,
): bigint {
  const ceiling = BigInt(RFC64_PUBLIC_CATALOG_EXACT_SET_BUNDLE_BYTES_MAX_V1);
  if (typeof currentTotal !== 'bigint' || currentTotal < 0n || currentTotal > ceiling) {
    throw new RangeError('current exact-set bundle-byte total is outside the V1 ceiling');
  }
  const nextTotal = currentTotal + parseCanonicalDecimalU64(
    byteLength,
    'exact-set bundle byteLength',
  );
  if (nextTotal > ceiling) {
    throw new RangeError(
      `exact-set bundle bytes exceed the V1 ${RFC64_PUBLIC_CATALOG_EXACT_SET_BUNDLE_BYTES_MAX_V1}-byte ceiling`,
    );
  }
  return nextTotal;
}

/** Validate canonical row byte lengths before a receiver fetches any bundle. */
export function assertRfc64PublicCatalogExactSetBundleBytesV1(
  byteLengths: readonly DecimalU64V1[],
): bigint {
  let total = 0n;
  for (const byteLength of byteLengths) {
    total = addRfc64PublicCatalogExactSetBundleBytesV1(total, byteLength);
  }
  return total;
}

const FETCH_NOT_FOUND = 0;
const FETCH_DENIED = 2;

const NATIVE_WIRE: Rfc64CatalogTransportWireAdapterV1 =
  createRfc64CatalogTransportWireAdapterV1({
    fail,
    wireCode: 'catalog-native-wire',
    inputCode: 'catalog-native-input',
    messages: {
      encodePlainObject: 'catalog native request must be a plain object',
      encodeFieldShape: 'catalog native requests accept only string or null fields',
      encodeOversized: () => 'catalog native request exceeds its byte ceiling',
      parseOversized: 'catalog native request is empty or oversized',
      parseStrictJson: 'catalog native request is not strict UTF-8 JSON',
      parsePlainObject: 'catalog native request must be an object',
      parseExactKeys: 'catalog native request has missing or unknown fields',
      parseNoncanonical: 'catalog native request bytes are not canonical JCS',
      snapshot: 'catalog native request has missing or unknown fields',
      evmAddress: (label) => `${label} must be a lowercase nonzero EVM address`,
      peerIdType: 'remotePeerId must be a string',
      peerIdCanonical: 'remotePeerId is empty, oversized, or noncanonical',
    },
  });
const UTF8 = new TextEncoder();

const SCOPE_KEYS = Object.freeze([
  'authorAddress',
  'catalogEra',
  'catalogHeadObjectDigest',
  'catalogVersion',
  'contextGraphId',
  'kind',
  'networkId',
  'policyDigest',
  'subGraphName',
] as const);
const OBJECT_REQUEST_KEYS = Object.freeze([
  ...SCOPE_KEYS,
  'targetObjectDigest',
  'targetObjectType',
].sort());
const BUNDLE_REQUEST_KEYS = Object.freeze([
  ...SCOPE_KEYS,
  'blobDigest',
  'byteLength',
].sort());

export interface Rfc64PublicCatalogNativeFetchScopeV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly subGraphName: SubGraphNameV1 | null;
  readonly authorAddress: EvmAddressV1;
  readonly catalogEra: DecimalU64V1;
  readonly catalogVersion: DecimalU64V1;
  readonly policyDigest: Digest32V1;
  readonly catalogHeadObjectDigest: Digest32V1;
}

export interface Rfc64PublicCatalogObjectFetchRequestV1
  extends Rfc64PublicCatalogNativeFetchScopeV1 {
  readonly kind: typeof RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1;
  readonly targetObjectType: string;
  readonly targetObjectDigest: Digest32V1;
}

export interface Rfc64PublicCatalogBundleFetchRequestV1
  extends Rfc64PublicCatalogNativeFetchScopeV1 {
  readonly kind: typeof RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1;
  readonly blobDigest: Digest32V1;
  readonly byteLength: DecimalU64V1;
}

export type Rfc64PublicCatalogNativeOperationV1 =
  | 'catalog-object-fetch-outbound'
  | 'catalog-object-fetch-inbound'
  | 'ka-bundle-fetch-outbound'
  | 'ka-bundle-fetch-inbound';

type Rfc64CatalogNativeContentProtocolV1 =
  | 'select-outbound'
  | 'public-v1'
  | 'scoped-v2';

export interface Rfc64PublicCatalogNativeAuthorizationInputV1 {
  readonly operation: Rfc64PublicCatalogNativeOperationV1;
  readonly remotePeerId: string;
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly subGraphName: SubGraphNameV1 | null;
  readonly policyDigest: Digest32V1;
  readonly catalogHeadObjectDigest: Digest32V1;
}

export type Rfc64PublicCatalogNativeAuthorizationV1 =
  Rfc64CatalogAccessAuthorizationV1;

export interface FetchedRfc64PublicCatalogObjectV1 {
  readonly envelope: SignedControlEnvelopeV1;
  readonly issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
}

/**
 * One provider capability bound to one exact accepted catalog head.
 *
 * Private content MUST be exposed through this contract. The resolver mints a
 * capability only after it has proved that the exact head belongs to the
 * requested network/CG/catalog scope. The transport independently compares the
 * returned scope with the canonical wire request before either digest lookup is
 * called. This keeps a digest from becoming a cross-CG read capability.
 */
export type { Rfc64CatalogNativeScopedReadCapabilityV1 } from './catalog-native-scoped-read-capability-v1-internal.js';

export type ResolveRfc64CatalogNativeScopedReadCapabilityV1 = (
  scope: Readonly<Rfc64PublicCatalogNativeFetchScopeV1>,
) => Promise<Rfc64CatalogNativeScopedReadCapabilityV1 | null>;

export interface Rfc64PublicCatalogNativeTransportOptionsV1 {
  /**
   * Legacy digest reader retained for client-only construction compatibility.
   * Inbound V1 and V2 serving requires `resolveScopedReadCapability` and never
   * performs a global digest lookup through this callback.
   */
  readonly readCatalogObjectByDigest?: (
    objectDigest: Digest32V1,
  ) => Promise<SignedControlEnvelopeV1 | null>;
  /** Legacy client-only reader; inbound serving never calls it directly. */
  readonly readKaBundleByDigest?: (
    blobDigest: Digest32V1,
  ) => Promise<Uint8Array | null>;
  /**
   * Provider-side public/private lookup. A capability is valid for exactly
   * the supplied accepted-current head scope and no other graph or head.
   */
  readonly resolveScopedReadCapability?: ResolveRfc64CatalogNativeScopedReadCapabilityV1;
  /** Preferred V2 contract: the accepted-current access-policy registry. */
  readonly authorizeCatalogOperation?: Rfc64CatalogAccessPolicyRegistryV1['authorize'];
  /** @deprecated Gate-1 compatibility until the service wiring migrates. */
  readonly authorizeOpenCatalogOperation?: (
    input: Rfc64PublicCatalogNativeAuthorizationInputV1,
  ) => Promise<Rfc64PublicCatalogNativeAuthorizationV1 | null>;
  readonly verifyIssuerSignature: (
    envelope: SignedControlEnvelopeV1,
  ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;
}

export type Rfc64PublicCatalogNativeTransportErrorCodeV1 =
  | 'catalog-native-input'
  | 'catalog-native-wire'
  | 'catalog-native-policy-denied'
  | 'catalog-native-object-mismatch'
  | 'catalog-native-signature'
  | 'catalog-native-resource-refused'
  | 'catalog-native-state';

export class Rfc64PublicCatalogNativeTransportErrorV1 extends Error {
  constructor(
    readonly code: Rfc64PublicCatalogNativeTransportErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64PublicCatalogNativeTransportErrorV1';
  }
}

export class Rfc64PublicCatalogNativeTransportV1 {
  #started = false;
  readonly #authorizeCatalogOperation: (
    input: Rfc64PublicCatalogNativeAuthorizationInputV1,
  ) => Promise<Rfc64PublicCatalogNativeAuthorizationV1 | null>;

  constructor(
    private readonly router: ProtocolRouter,
    private readonly options: Rfc64PublicCatalogNativeTransportOptionsV1,
  ) {
    if (
      typeof options?.readCatalogObjectByDigest !== 'function'
      && typeof options?.resolveScopedReadCapability !== 'function'
    ) {
      fail(
        'catalog-native-input',
        'readCatalogObjectByDigest or resolveScopedReadCapability must be a function',
      );
    }
    if (
      typeof options.readKaBundleByDigest !== 'function'
      && typeof options.resolveScopedReadCapability !== 'function'
    ) {
      fail(
        'catalog-native-input',
        'readKaBundleByDigest or resolveScopedReadCapability must be a function',
      );
    }
    this.#authorizeCatalogOperation = normalizeRfc64CatalogTransportAuthorizerV1({
      current: options.authorizeCatalogOperation,
      legacyOpen: options.authorizeOpenCatalogOperation,
      invalidConfiguration: (message) => fail('catalog-native-input', message),
    });
    if (typeof options.verifyIssuerSignature !== 'function') {
      fail('catalog-native-input', 'verifyIssuerSignature must be a function');
    }
  }

  get started(): boolean {
    return this.#started;
  }

  /** True only when this provider can serve exact-scope private reads. */
  get privateScopeBoundReadsConfigured(): boolean {
    return typeof this.options.resolveScopedReadCapability === 'function';
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    try {
      this.router.register(
        RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1,
        async (data, peerId) => this.handleCatalogObjectFetch(
          data,
          peerId.toString(),
          'public-v1',
        ),
        { maxReadBytes: RFC64_PUBLIC_CATALOG_NATIVE_FETCH_REQUEST_MAX_BYTES_V1 },
      );
      this.router.register(
        RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1,
        async (data, peerId) => this.handleBundleFetch(data, peerId.toString(), 'public-v1'),
        { maxReadBytes: RFC64_PUBLIC_CATALOG_NATIVE_FETCH_REQUEST_MAX_BYTES_V1 },
      );
      this.router.register(
        RFC64_CATALOG_OBJECT_FETCH_PROTOCOL_V2,
        async (data, peerId) => this.handleCatalogObjectFetch(
          data,
          peerId.toString(),
          'scoped-v2',
        ),
        { maxReadBytes: RFC64_PUBLIC_CATALOG_NATIVE_FETCH_REQUEST_MAX_BYTES_V1 },
      );
      this.router.register(
        RFC64_CATALOG_BUNDLE_FETCH_PROTOCOL_V2,
        async (data, peerId) => this.handleBundleFetch(data, peerId.toString(), 'scoped-v2'),
        { maxReadBytes: RFC64_PUBLIC_CATALOG_NATIVE_FETCH_REQUEST_MAX_BYTES_V1 },
      );
    } catch (cause) {
      this.#started = false;
      this.router.unregister(RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1);
      this.router.unregister(RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1);
      this.router.unregister(RFC64_CATALOG_OBJECT_FETCH_PROTOCOL_V2);
      this.router.unregister(RFC64_CATALOG_BUNDLE_FETCH_PROTOCOL_V2);
      throw cause;
    }
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.router.unregister(RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1);
    this.router.unregister(RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1);
    this.router.unregister(RFC64_CATALOG_OBJECT_FETCH_PROTOCOL_V2);
    this.router.unregister(RFC64_CATALOG_BUNDLE_FETCH_PROTOCOL_V2);
  }

  async fetchCatalogObject(
    remotePeerIdInput: string,
    requestInput: Rfc64PublicCatalogObjectFetchRequestV1,
    sendOptions?: SendOptions,
  ): Promise<FetchedRfc64PublicCatalogObjectV1 | null> {
    this.requireStarted();
    const remotePeerId = snapshotPeerId(remotePeerIdInput);
    const request = parseCatalogObjectRequest(encodeRequest(requestInput));
    const response = await this.withCurrentCatalogPolicy(
      'catalog-object-fetch-outbound',
      remotePeerId,
      request,
      'select-outbound',
      (authorization) => {
        const privateContent = authorization.accessPolicy === 1;
        return this.router.send(
          remotePeerId,
          privateContent
            ? RFC64_CATALOG_OBJECT_FETCH_PROTOCOL_V2
            : RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1,
          privateContent
            ? encodePrivateObjectRequest(request)
            : encodeRequest(request),
          sendOptions,
        );
      },
    );
    const envelope = parseCatalogObjectResponse(response);
    if (envelope === null) return null;
    assertCatalogObjectMatchesRequest(envelope, request);
    const issuerSignature = await recheckCurrentRfc64CatalogPolicyAfterAwaitV1(
      () => this.assertCatalogPolicyCurrent(
        'catalog-object-fetch-outbound',
        remotePeerId,
        request,
        'select-outbound',
      ),
      () => this.verifyExactIssuerSignature(envelope),
    );
    return Object.freeze({ envelope: deepFreeze(envelope), issuerSignature });
  }

  async fetchKaBundle(
    remotePeerIdInput: string,
    requestInput: Rfc64PublicCatalogBundleFetchRequestV1,
    sendOptions?: SendOptions,
  ): Promise<Uint8Array | null> {
    this.requireStarted();
    const remotePeerId = snapshotPeerId(remotePeerIdInput);
    const request = parseBundleRequest(encodeRequest(requestInput));
    if (BigInt(request.byteLength) + 1n
      > BigInt(RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_RESPONSE_MAX_BYTES_V1)) {
      fail(
        'catalog-native-resource-refused',
        'advertised KA bundle exceeds this receiver transport resource ceiling',
      );
    }
    const response = await this.withCurrentCatalogPolicy(
      'ka-bundle-fetch-outbound',
      remotePeerId,
      request,
      'select-outbound',
      (authorization) => {
        const privateContent = authorization.accessPolicy === 1;
        return this.router.send(
          remotePeerId,
          privateContent
            ? RFC64_CATALOG_BUNDLE_FETCH_PROTOCOL_V2
            : RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1,
          privateContent
            ? encodePrivateBundleRequest(request)
            : encodeRequest(request),
          sendOptions,
        );
      },
    );
    const bundle = parseBundleResponse(response, request);
    return bundle;
  }

  private async handleCatalogObjectFetch(
    data: Uint8Array,
    remotePeerIdInput: string,
    protocol: Exclude<Rfc64CatalogNativeContentProtocolV1, 'select-outbound'>,
  ): Promise<Uint8Array> {
    this.requireStarted();
    const remotePeerId = snapshotPeerId(remotePeerIdInput);
    const request = protocol === 'public-v1'
      ? parseCatalogObjectRequest(data)
      : parsePrivateCatalogObjectRequest(data);
    const served = await this.withAuthorizedCurrentCatalogPolicy(
      'catalog-object-fetch-inbound',
      remotePeerId,
      request,
      protocol,
      async (authorization) => {
        const envelope = await this.readCatalogObject(
          authorization,
          remotePeerId,
          request,
          protocol,
        );
        if (envelope === null) return null;
        assertCatalogObjectMatchesRequest(envelope, request);
        await recheckCurrentRfc64CatalogPolicyAfterAwaitV1(
          () => this.assertCatalogPolicyCurrent(
            'catalog-object-fetch-inbound',
            remotePeerId,
            request,
            protocol,
          ),
          () => this.verifyExactIssuerSignature(envelope),
        );
        const bytes = canonicalizeSignedControlEnvelopeBytes(envelope);
        if (bytes.byteLength + 1 > RFC64_PUBLIC_CATALOG_OBJECT_FETCH_RESPONSE_MAX_BYTES_V1) {
          fail('catalog-native-resource-refused', 'catalog object exceeds the response ceiling');
        }
        return foundResponse(bytes);
      },
    );
    if (!served.authorized) {
      return Uint8Array.of(FETCH_DENIED);
    }
    return served.value ?? Uint8Array.of(FETCH_NOT_FOUND);
  }

  private async handleBundleFetch(
    data: Uint8Array,
    remotePeerIdInput: string,
    protocol: Exclude<Rfc64CatalogNativeContentProtocolV1, 'select-outbound'>,
  ): Promise<Uint8Array> {
    this.requireStarted();
    const remotePeerId = snapshotPeerId(remotePeerIdInput);
    const request = protocol === 'public-v1'
      ? parseBundleRequest(data)
      : parsePrivateBundleRequest(data);
    if (BigInt(request.byteLength) + 1n
      > BigInt(RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_RESPONSE_MAX_BYTES_V1)) {
      fail('catalog-native-resource-refused', 'requested KA bundle exceeds the response ceiling');
    }
    const served = await this.withAuthorizedCurrentCatalogPolicy(
      'ka-bundle-fetch-inbound',
      remotePeerId,
      request,
      protocol,
      async (authorization) => {
        const bundle = await this.readKaBundle(
          authorization,
          remotePeerId,
          request,
          protocol,
        );
        if (bundle === null) return null;
        assertExactBundle(bundle, request);
        return foundResponse(bundle);
      },
    );
    if (!served.authorized) {
      return Uint8Array.of(FETCH_DENIED);
    }
    return served.value ?? Uint8Array.of(FETCH_NOT_FOUND);
  }

  private async withAuthorizedCurrentCatalogPolicy<Value>(
    operation: Rfc64PublicCatalogNativeOperationV1,
    remotePeerId: string,
    request: Rfc64PublicCatalogObjectFetchRequestV1
      | Rfc64PublicCatalogBundleFetchRequestV1,
    protocol: Rfc64CatalogNativeContentProtocolV1,
    work: (
      authorization: Rfc64PublicCatalogNativeAuthorizationV1,
    ) => Value | Promise<Value>,
  ): Promise<Rfc64AuthorizedCatalogWorkResultV1<Value>> {
    let authorization: Rfc64PublicCatalogNativeAuthorizationV1;
    try {
      authorization = await this.requireCatalogPolicy(
        operation,
        remotePeerId,
        request,
        protocol,
      );
    } catch (cause) {
      if (isPolicyDenied(cause)) return Object.freeze({ authorized: false });
      throw cause;
    }
    const value = await work(authorization);
    if (!await this.isCatalogPolicyAuthorized(operation, remotePeerId, request, protocol)) {
      return Object.freeze({ authorized: false });
    }
    return Object.freeze({ authorized: true, value });
  }

  private async isCatalogPolicyAuthorized(
    operation: Rfc64PublicCatalogNativeOperationV1,
    remotePeerId: string,
    request: Rfc64PublicCatalogObjectFetchRequestV1
      | Rfc64PublicCatalogBundleFetchRequestV1,
    protocol: Rfc64CatalogNativeContentProtocolV1,
  ): Promise<boolean> {
    try {
      await this.requireCatalogPolicy(operation, remotePeerId, request, protocol);
      return true;
    } catch (cause) {
      if (
        cause instanceof Rfc64PublicCatalogNativeTransportErrorV1
        && cause.code === 'catalog-native-policy-denied'
      ) return false;
      throw cause;
    }
  }

  private withCurrentCatalogPolicy<Value>(
    operation: Rfc64PublicCatalogNativeOperationV1,
    remotePeerId: string,
    request: Rfc64PublicCatalogObjectFetchRequestV1
      | Rfc64PublicCatalogBundleFetchRequestV1,
    protocol: Rfc64CatalogNativeContentProtocolV1,
    work: (
      authorization: Rfc64PublicCatalogNativeAuthorizationV1,
    ) => Value | Promise<Value>,
  ): Promise<Value> {
    return (async () => {
      const authorization = await this.requireCatalogPolicy(
        operation,
        remotePeerId,
        request,
        protocol,
      );
      const value = await work(authorization);
      await this.assertCatalogPolicyCurrent(operation, remotePeerId, request, protocol);
      return value;
    })();
  }

  private async assertCatalogPolicyCurrent(
    operation: Rfc64PublicCatalogNativeOperationV1,
    remotePeerId: string,
    request: Rfc64PublicCatalogObjectFetchRequestV1
      | Rfc64PublicCatalogBundleFetchRequestV1,
    protocol: Rfc64CatalogNativeContentProtocolV1,
  ): Promise<void> {
    await this.requireCatalogPolicy(operation, remotePeerId, request, protocol);
  }

  private async requireCatalogPolicy(
    operation: Rfc64PublicCatalogNativeOperationV1,
    remotePeerId: string,
    request: Rfc64PublicCatalogObjectFetchRequestV1
      | Rfc64PublicCatalogBundleFetchRequestV1,
    protocol: Rfc64CatalogNativeContentProtocolV1,
  ): Promise<Rfc64PublicCatalogNativeAuthorizationV1> {
    let authorization: Rfc64PublicCatalogNativeAuthorizationV1 | null;
    try {
      authorization = await this.#authorizeCatalogOperation(Object.freeze({
        operation,
        remotePeerId,
        networkId: request.networkId,
        contextGraphId: request.contextGraphId,
        subGraphName: request.subGraphName,
        policyDigest: request.policyDigest,
        catalogHeadObjectDigest: request.catalogHeadObjectDigest,
      }));
    } catch (cause) {
      fail('catalog-native-policy-denied', 'catalog access-policy authorization failed', cause);
    }
    if (authorization === null) {
      fail('catalog-native-policy-denied', 'catalog content fetch is not access-policy authorized');
    }
    try {
      assertCanonicalDigest(authorization.policyDigest, 'authorized policyDigest');
    } catch (cause) {
      fail('catalog-native-policy-denied', 'authorization returned an invalid digest', cause);
    }
    if (authorization.policyDigest !== request.policyDigest) {
      fail('catalog-native-policy-denied', 'catalog policy generation is stale or mismatched');
    }
    if (protocol === 'public-v1' && authorization.accessPolicy !== 0) {
      fail('catalog-native-policy-denied', 'private catalog content is forbidden on V1 protocols');
    }
    if (
      protocol === 'scoped-v2'
      && typeof this.options.resolveScopedReadCapability !== 'function'
    ) {
      fail(
        'catalog-native-policy-denied',
        'V2 catalog content requires an exact-scope read capability',
      );
    }
    return authorization;
  }

  private async readCatalogObject(
    authorization: Rfc64PublicCatalogNativeAuthorizationV1,
    remotePeerId: string,
    request: Rfc64PublicCatalogObjectFetchRequestV1,
    protocol: Exclude<Rfc64CatalogNativeContentProtocolV1, 'select-outbound'>,
  ): Promise<SignedControlEnvelopeV1 | null> {
    if (protocol === 'public-v1' && authorization.accessPolicy !== 0) {
      fail('catalog-native-policy-denied', 'V1 catalog object read is not public-capable');
    }
    const capability = await this.resolveExactScopedReadCapability(
      'catalog-object-fetch-inbound',
      remotePeerId,
      request,
      protocol,
    );
    if (capability === null) return null;
    return recheckCurrentRfc64CatalogPolicyAfterAwaitV1(
      () => this.assertCatalogPolicyCurrent(
        'catalog-object-fetch-inbound',
        remotePeerId,
        request,
        protocol,
      ),
      () => capability.readCatalogObjectByDigest(request.targetObjectDigest),
    );
  }

  private async readKaBundle(
    authorization: Rfc64PublicCatalogNativeAuthorizationV1,
    remotePeerId: string,
    request: Rfc64PublicCatalogBundleFetchRequestV1,
    protocol: Exclude<Rfc64CatalogNativeContentProtocolV1, 'select-outbound'>,
  ): Promise<Uint8Array | null> {
    if (protocol === 'public-v1' && authorization.accessPolicy !== 0) {
      fail('catalog-native-policy-denied', 'V1 KA bundle read is not public-capable');
    }
    const capability = await this.resolveExactScopedReadCapability(
      'ka-bundle-fetch-inbound',
      remotePeerId,
      request,
      protocol,
    );
    if (capability === null) return null;
    return recheckCurrentRfc64CatalogPolicyAfterAwaitV1(
      () => this.assertCatalogPolicyCurrent(
        'ka-bundle-fetch-inbound',
        remotePeerId,
        request,
        protocol,
      ),
      () => capability.readKaBundleByDigest(request.blobDigest),
    );
  }

  private async resolveExactScopedReadCapability(
    operation: 'catalog-object-fetch-inbound' | 'ka-bundle-fetch-inbound',
    remotePeerId: string,
    request: Rfc64PublicCatalogObjectFetchRequestV1
      | Rfc64PublicCatalogBundleFetchRequestV1,
    protocol: Exclude<Rfc64CatalogNativeContentProtocolV1, 'select-outbound'>,
  ): Promise<Rfc64CatalogNativeScopedReadCapabilityV1 | null> {
    const resolve = this.options.resolveScopedReadCapability;
    if (resolve === undefined) {
      fail('catalog-native-policy-denied', 'exact-scope read capability is not configured');
    }
    const expectedScope = fetchScope(request);
    const capability = await recheckCurrentRfc64CatalogPolicyAfterAwaitV1(
      () => this.assertCatalogPolicyCurrent(operation, remotePeerId, request, protocol),
      () => resolve(expectedScope),
    );
    if (capability === null) return null;
    assertExactScopedReadCapability(capability, expectedScope);
    return capability;
  }

  private async verifyExactIssuerSignature(
    envelope: SignedControlEnvelopeV1,
  ): Promise<VerifiedControlEnvelopeIssuerSignatureV1> {
    try {
      const proof = await this.options.verifyIssuerSignature(envelope);
      assertRfc64ExactIssuerSignatureProofV1(envelope, proof);
      return proof;
    } catch (cause) {
      fail('catalog-native-signature', 'catalog object issuer signature is invalid', cause);
    }
  }

  private requireStarted(): void {
    if (!this.#started) fail('catalog-native-state', 'catalog native transport is not started');
  }
}

export function encodeRfc64PublicCatalogObjectFetchRequestV1(
  input: Rfc64PublicCatalogObjectFetchRequestV1,
): Uint8Array {
  return encodeRequest(validateObjectRequest(input));
}

export function parseRfc64PublicCatalogObjectFetchRequestV1(
  input: Uint8Array,
): Rfc64PublicCatalogObjectFetchRequestV1 {
  return parseCatalogObjectRequest(input);
}

export function encodeRfc64PublicCatalogBundleFetchRequestV1(
  input: Rfc64PublicCatalogBundleFetchRequestV1,
): Uint8Array {
  return encodeRequest(validateBundleRequest(input));
}

export function parseRfc64PublicCatalogBundleFetchRequestV1(
  input: Uint8Array,
): Rfc64PublicCatalogBundleFetchRequestV1 {
  return parseBundleRequest(input);
}

function parseCatalogObjectRequest(input: Uint8Array): Rfc64PublicCatalogObjectFetchRequestV1 {
  const parsed = parseRequest(input, OBJECT_REQUEST_KEYS);
  return validateObjectRequest(parsed);
}

function encodePrivateObjectRequest(
  request: Rfc64PublicCatalogObjectFetchRequestV1,
): Uint8Array {
  return encodeRequest({ ...request, kind: RFC64_CATALOG_OBJECT_FETCH_KIND_V2 });
}

function parsePrivateCatalogObjectRequest(
  input: Uint8Array,
): Rfc64PublicCatalogObjectFetchRequestV1 {
  const snapshot = snapshotExactWireRecord(
    parseRequest(input, OBJECT_REQUEST_KEYS),
    OBJECT_REQUEST_KEYS,
  );
  const scope = validateScope(snapshot, RFC64_CATALOG_OBJECT_FETCH_KIND_V2);
  if (
    typeof snapshot.targetObjectType !== 'string'
    || snapshot.targetObjectType.length < 1
    || UTF8.encode(snapshot.targetObjectType).byteLength > 256
  ) {
    fail('catalog-native-wire', 'targetObjectType is empty or oversized');
  }
  try {
    assertCanonicalDigest(snapshot.targetObjectDigest, 'targetObjectDigest');
  } catch (cause) {
    fail('catalog-native-wire', 'targetObjectDigest is invalid', cause);
  }
  return Object.freeze({
    ...scope,
    kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
    targetObjectType: snapshot.targetObjectType,
    targetObjectDigest: snapshot.targetObjectDigest,
  }) as Rfc64PublicCatalogObjectFetchRequestV1;
}

function parseBundleRequest(input: Uint8Array): Rfc64PublicCatalogBundleFetchRequestV1 {
  const parsed = parseRequest(input, BUNDLE_REQUEST_KEYS);
  return validateBundleRequest(parsed);
}

function encodePrivateBundleRequest(
  request: Rfc64PublicCatalogBundleFetchRequestV1,
): Uint8Array {
  return encodeRequest({ ...request, kind: RFC64_CATALOG_BUNDLE_FETCH_KIND_V2 });
}

function parsePrivateBundleRequest(
  input: Uint8Array,
): Rfc64PublicCatalogBundleFetchRequestV1 {
  const snapshot = snapshotExactWireRecord(
    parseRequest(input, BUNDLE_REQUEST_KEYS),
    BUNDLE_REQUEST_KEYS,
  );
  const scope = validateScope(snapshot, RFC64_CATALOG_BUNDLE_FETCH_KIND_V2);
  try {
    assertCanonicalDigest(snapshot.blobDigest, 'blobDigest');
    assertCanonicalDecimalU64(snapshot.byteLength, 'byteLength');
  } catch (cause) {
    fail('catalog-native-wire', 'bundle request contains an invalid digest or length', cause);
  }
  return Object.freeze({
    ...scope,
    kind: RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
    blobDigest: snapshot.blobDigest,
    byteLength: snapshot.byteLength,
  }) as Rfc64PublicCatalogBundleFetchRequestV1;
}

function validateObjectRequest(value: unknown): Rfc64PublicCatalogObjectFetchRequestV1 {
  const snapshot = snapshotExactWireRecord(value, OBJECT_REQUEST_KEYS);
  const scope = validateScope(snapshot, RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1);
  if (typeof snapshot.targetObjectType !== 'string' || snapshot.targetObjectType.length < 1
    || UTF8.encode(snapshot.targetObjectType).byteLength > 256) {
    fail('catalog-native-wire', 'targetObjectType is empty or oversized');
  }
  try {
    assertCanonicalDigest(snapshot.targetObjectDigest, 'targetObjectDigest');
  } catch (cause) {
    fail('catalog-native-wire', 'targetObjectDigest is invalid', cause);
  }
  return Object.freeze({
    ...scope,
    kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
    targetObjectType: snapshot.targetObjectType,
    targetObjectDigest: snapshot.targetObjectDigest,
  }) as Rfc64PublicCatalogObjectFetchRequestV1;
}

function validateBundleRequest(value: unknown): Rfc64PublicCatalogBundleFetchRequestV1 {
  const snapshot = snapshotExactWireRecord(value, BUNDLE_REQUEST_KEYS);
  const scope = validateScope(snapshot, RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1);
  try {
    assertCanonicalDigest(snapshot.blobDigest, 'blobDigest');
    assertCanonicalDecimalU64(snapshot.byteLength, 'byteLength');
  } catch (cause) {
    fail('catalog-native-wire', 'bundle request contains an invalid digest or length', cause);
  }
  return Object.freeze({
    ...scope,
    kind: RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
    blobDigest: snapshot.blobDigest,
    byteLength: snapshot.byteLength,
  }) as Rfc64PublicCatalogBundleFetchRequestV1;
}

function validateScope(
  value: unknown,
  kind: typeof RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1
    | typeof RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1
    | typeof RFC64_CATALOG_OBJECT_FETCH_KIND_V2
    | typeof RFC64_CATALOG_BUNDLE_FETCH_KIND_V2,
): Rfc64PublicCatalogNativeFetchScopeV1 {
  if (!isPlainRecord(value) || value.kind !== kind) {
    fail('catalog-native-wire', `catalog native request kind must be ${kind}`);
  }
  try {
    assertNetworkIdV1(value.networkId);
    assertContextGraphIdV1(value.contextGraphId);
    if (value.subGraphName !== null) assertSubGraphNameV1(value.subGraphName);
    assertCanonicalEvmAddress(value.authorAddress, 'authorAddress');
    assertCanonicalDecimalU64(value.catalogEra, 'catalogEra');
    assertCanonicalDecimalU64(value.catalogVersion, 'catalogVersion');
    assertCanonicalDigest(value.policyDigest, 'policyDigest');
    assertCanonicalDigest(value.catalogHeadObjectDigest, 'catalogHeadObjectDigest');
  } catch (cause) {
    fail('catalog-native-wire', 'catalog native request contains an invalid scope', cause);
  }
  return Object.freeze({
    networkId: value.networkId,
    contextGraphId: value.contextGraphId,
    subGraphName: value.subGraphName,
    authorAddress: value.authorAddress,
    catalogEra: value.catalogEra,
    catalogVersion: value.catalogVersion,
    policyDigest: value.policyDigest,
    catalogHeadObjectDigest: value.catalogHeadObjectDigest,
  }) as Rfc64PublicCatalogNativeFetchScopeV1;
}

function encodeRequest(value: object): Uint8Array {
  return NATIVE_WIRE.encodeFlatCanonicalJson(
    value,
    RFC64_PUBLIC_CATALOG_NATIVE_FETCH_REQUEST_MAX_BYTES_V1,
  );
}

function parseRequest(input: Uint8Array, expectedKeys: readonly string[]): Record<string, unknown> {
  return NATIVE_WIRE.parseFlatCanonicalJson(
    input,
    expectedKeys,
    RFC64_PUBLIC_CATALOG_NATIVE_FETCH_REQUEST_MAX_BYTES_V1,
  );
}

function parseCatalogObjectResponse(input: Uint8Array): SignedControlEnvelopeV1 | null {
  const payload = responsePayload(input, RFC64_PUBLIC_CATALOG_OBJECT_FETCH_RESPONSE_MAX_BYTES_V1);
  if (payload === null) return null;
  try {
    const envelope = parseCanonicalSignedControlEnvelope(payload, {
      maxBytes: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_RESPONSE_MAX_BYTES_V1 - 1,
    });
    assertSignedControlEnvelope(envelope);
    return envelope;
  } catch (cause) {
    fail('catalog-native-wire', 'catalog object response is not canonical', cause);
  }
}

function parseBundleResponse(
  input: Uint8Array,
  request: Rfc64PublicCatalogBundleFetchRequestV1,
): Uint8Array | null {
  const payload = responsePayload(input, RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_RESPONSE_MAX_BYTES_V1);
  if (payload === null) return null;
  const snapshot = new Uint8Array(payload);
  assertExactBundle(snapshot, request);
  return snapshot;
}

function responsePayload(input: Uint8Array, maxBytes: number): Uint8Array | null {
  let framed;
  try {
    framed = parseRfc64StatusResponsePayloadV1(input, maxBytes);
  } catch (cause) {
    rethrowRfc64CatalogTransportWireUtilityErrorV1(cause, fail, {
      'response-trailing': {
        code: 'catalog-native-wire',
        message: input[0] === FETCH_NOT_FOUND
          ? 'not-found response has trailing bytes'
          : 'denied response has trailing bytes',
      },
      'response-status': {
        code: 'catalog-native-wire',
        message: 'catalog native response has an invalid status',
      },
    }, {
      code: 'catalog-native-wire',
      message: 'catalog native response is empty or oversized',
    });
  }
  if (framed.status === 'not-found') return null;
  if (framed.status === 'denied') {
    fail('catalog-native-policy-denied', 'remote peer denied the catalog native fetch');
  }
  return framed.payload;
}

function assertCatalogObjectMatchesRequest(
  envelope: SignedControlEnvelopeV1,
  request: Rfc64PublicCatalogObjectFetchRequestV1,
): void {
  try {
    assertSignedControlEnvelope(envelope);
  } catch (cause) {
    fail('catalog-native-object-mismatch', 'fetched value is not a signed control object', cause);
  }
  if (
    envelope.objectType !== request.targetObjectType
    || envelope.objectDigest !== request.targetObjectDigest
    || envelope.issuer !== request.authorAddress
  ) {
    fail('catalog-native-object-mismatch', 'catalog object differs from requested type, digest, or author');
  }
}

function assertExactBundle(
  bundle: Uint8Array,
  request: Rfc64PublicCatalogBundleFetchRequestV1,
): void {
  if (!(bundle instanceof Uint8Array) || bundle.byteLength.toString() !== request.byteLength) {
    fail('catalog-native-object-mismatch', 'KA bundle length differs from its catalog row');
  }
  try {
    const decoded = decodeOpaqueKaBundleV1(bundle);
    if (decoded.blobDigest !== request.blobDigest) {
      fail('catalog-native-object-mismatch', 'KA bundle digest differs from its catalog row');
    }
  } catch (cause) {
    if (cause instanceof Rfc64PublicCatalogNativeTransportErrorV1) throw cause;
    fail('catalog-native-object-mismatch', 'KA bundle is not one exact opaque bundle', cause);
  }
}

function fetchScope(
  request: Rfc64PublicCatalogObjectFetchRequestV1
    | Rfc64PublicCatalogBundleFetchRequestV1,
): Readonly<Rfc64PublicCatalogNativeFetchScopeV1> {
  return Object.freeze({
    networkId: request.networkId,
    contextGraphId: request.contextGraphId,
    subGraphName: request.subGraphName,
    authorAddress: request.authorAddress,
    catalogEra: request.catalogEra,
    catalogVersion: request.catalogVersion,
    policyDigest: request.policyDigest,
    catalogHeadObjectDigest: request.catalogHeadObjectDigest,
  });
}

function assertExactScopedReadCapability(
  capability: Rfc64CatalogNativeScopedReadCapabilityV1,
  expectedScope: Readonly<Rfc64PublicCatalogNativeFetchScopeV1>,
): void {
  if (
    !isMintedRfc64CatalogNativeScopedReadCapabilityV1(capability)
    || typeof capability.readCatalogObjectByDigest !== 'function'
    || typeof capability.readKaBundleByDigest !== 'function'
    || !isPlainRecord(capability.scope)
  ) {
    fail('catalog-native-policy-denied', 'scoped read resolver returned an invalid capability');
  }
  let actualScope: Readonly<Rfc64PublicCatalogNativeFetchScopeV1>;
  try {
    actualScope = validateScope(
      {
        ...capability.scope,
        kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
      },
      RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
    );
  } catch (cause) {
    fail('catalog-native-policy-denied', 'scoped read capability has an invalid scope', cause);
  }
  if (
    actualScope.networkId !== expectedScope.networkId
    || actualScope.contextGraphId !== expectedScope.contextGraphId
    || actualScope.subGraphName !== expectedScope.subGraphName
    || actualScope.authorAddress !== expectedScope.authorAddress
    || actualScope.catalogEra !== expectedScope.catalogEra
    || actualScope.catalogVersion !== expectedScope.catalogVersion
    || actualScope.policyDigest !== expectedScope.policyDigest
    || actualScope.catalogHeadObjectDigest !== expectedScope.catalogHeadObjectDigest
  ) {
    fail(
      'catalog-native-policy-denied',
      'scoped read capability does not match the exact requested catalog head scope',
    );
  }
}

function isPolicyDenied(cause: unknown): boolean {
  return cause instanceof Rfc64PublicCatalogNativeTransportErrorV1
    && cause.code === 'catalog-native-policy-denied';
}

function foundResponse(payload: Uint8Array): Uint8Array {
  return encodeRfc64FoundStatusResponseV1(payload);
}

function assertCanonicalEvmAddress(value: unknown, label: string): asserts value is EvmAddressV1 {
  NATIVE_WIRE.assertCanonicalEvmAddress(value, label);
}

function snapshotPeerId(value: unknown): string {
  return NATIVE_WIRE.snapshotPeerId(value);
}

function snapshotExactWireRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  return NATIVE_WIRE.snapshotExactWireRecord(value, expectedKeys);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function fail(
  code: Rfc64PublicCatalogNativeTransportErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64PublicCatalogNativeTransportErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
