// SPDX-License-Identifier: Apache-2.0

/**
 * RFC-64 public/open catalog content transport.
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
  computeControlSignatureVariantDigestHex,
  decodeOpaqueKaBundleV1,
  parseCanonicalSignedControlEnvelope,
  type ContextGraphAccessPolicyV1,
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
  readVerifiedControlEnvelopeIssuerSignatureV1,
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';

export const RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1 =
  '/dkg/catalog/1/control-object/by-digest' as const;
export const RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1 =
  '/dkg/catalog/1/ka-bundle/by-digest' as const;

export const RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1 =
  'rfc64-public-catalog-object-fetch-v1' as const;
export const RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1 =
  'rfc64-public-catalog-bundle-fetch-v1' as const;

export const RFC64_PUBLIC_CATALOG_NATIVE_FETCH_REQUEST_MAX_BYTES_V1 = 4 * 1024;
export const RFC64_PUBLIC_CATALOG_OBJECT_FETCH_RESPONSE_MAX_BYTES_V1 =
  MAX_CONTROL_OBJECT_BYTES + 1;
/** First vertical slice resource ceiling; protocol descriptors may advertise more. */
export const RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_RESPONSE_MAX_BYTES_V1 =
  8 * 1024 * 1024;

const FETCH_NOT_FOUND = 0;
const FETCH_FOUND = 1;
const FETCH_DENIED = 2;
const MAX_PEER_ID_BYTES = 256;
const UTF8 = new TextEncoder();
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

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

export interface Rfc64PublicCatalogNativeAuthorizationInputV1 {
  readonly operation: Rfc64PublicCatalogNativeOperationV1;
  readonly remotePeerId: string;
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly subGraphName: SubGraphNameV1 | null;
  readonly policyDigest: Digest32V1;
  readonly catalogHeadObjectDigest: Digest32V1;
}

export interface Rfc64PublicCatalogNativeAuthorizationV1 {
  readonly accessPolicy: ContextGraphAccessPolicyV1;
  readonly policyDigest: Digest32V1;
}

export interface FetchedRfc64PublicCatalogObjectV1 {
  readonly envelope: SignedControlEnvelopeV1;
  readonly issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
}

export interface Rfc64PublicCatalogNativeTransportOptionsV1 {
  /** Provider-side exact immutable catalog-object lookup. */
  readonly readCatalogObjectByDigest: (
    objectDigest: Digest32V1,
  ) => Promise<SignedControlEnvelopeV1 | null>;
  /** Provider-side exact immutable bundle lookup. */
  readonly readKaBundleByDigest: (
    blobDigest: Digest32V1,
  ) => Promise<Uint8Array | null>;
  /** Must consult accepted current policy state, never the untrusted request. */
  readonly authorizeOpenCatalogOperation: (
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

  constructor(
    private readonly router: ProtocolRouter,
    private readonly options: Rfc64PublicCatalogNativeTransportOptionsV1,
  ) {
    if (typeof options?.readCatalogObjectByDigest !== 'function') {
      fail('catalog-native-input', 'readCatalogObjectByDigest must be a function');
    }
    if (typeof options.readKaBundleByDigest !== 'function') {
      fail('catalog-native-input', 'readKaBundleByDigest must be a function');
    }
    if (typeof options.authorizeOpenCatalogOperation !== 'function') {
      fail('catalog-native-input', 'authorizeOpenCatalogOperation must be a function');
    }
    if (typeof options.verifyIssuerSignature !== 'function') {
      fail('catalog-native-input', 'verifyIssuerSignature must be a function');
    }
  }

  get started(): boolean {
    return this.#started;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    try {
      this.router.register(
        RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1,
        async (data, peerId) => this.handleCatalogObjectFetch(data, peerId.toString()),
        { maxReadBytes: RFC64_PUBLIC_CATALOG_NATIVE_FETCH_REQUEST_MAX_BYTES_V1 },
      );
      this.router.register(
        RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1,
        async (data, peerId) => this.handleBundleFetch(data, peerId.toString()),
        { maxReadBytes: RFC64_PUBLIC_CATALOG_NATIVE_FETCH_REQUEST_MAX_BYTES_V1 },
      );
    } catch (cause) {
      this.#started = false;
      this.router.unregister(RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1);
      this.router.unregister(RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1);
      throw cause;
    }
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.router.unregister(RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1);
    this.router.unregister(RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1);
  }

  async fetchCatalogObject(
    remotePeerIdInput: string,
    requestInput: Rfc64PublicCatalogObjectFetchRequestV1,
    sendOptions?: SendOptions,
  ): Promise<FetchedRfc64PublicCatalogObjectV1 | null> {
    this.requireStarted();
    const remotePeerId = snapshotPeerId(remotePeerIdInput);
    const request = parseCatalogObjectRequest(encodeRequest(requestInput));
    await this.requireOpenPolicy('catalog-object-fetch-outbound', remotePeerId, request);
    const response = await this.router.send(
      remotePeerId,
      RFC64_PUBLIC_CATALOG_OBJECT_FETCH_PROTOCOL_V1,
      encodeRequest(request),
      sendOptions,
    );
    const envelope = parseCatalogObjectResponse(response);
    await this.requireOpenPolicy('catalog-object-fetch-outbound', remotePeerId, request);
    if (envelope === null) return null;
    assertCatalogObjectMatchesRequest(envelope, request);
    const issuerSignature = await this.verifyExactIssuerSignature(envelope);
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
    await this.requireOpenPolicy('ka-bundle-fetch-outbound', remotePeerId, request);
    const response = await this.router.send(
      remotePeerId,
      RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_PROTOCOL_V1,
      encodeRequest(request),
      sendOptions,
    );
    const bundle = parseBundleResponse(response, request);
    await this.requireOpenPolicy('ka-bundle-fetch-outbound', remotePeerId, request);
    return bundle;
  }

  private async handleCatalogObjectFetch(
    data: Uint8Array,
    remotePeerIdInput: string,
  ): Promise<Uint8Array> {
    this.requireStarted();
    const remotePeerId = snapshotPeerId(remotePeerIdInput);
    const request = parseCatalogObjectRequest(data);
    if (!await this.isOpenPolicy('catalog-object-fetch-inbound', remotePeerId, request)) {
      return Uint8Array.of(FETCH_DENIED);
    }
    const envelope = await this.options.readCatalogObjectByDigest(request.targetObjectDigest);
    if (envelope === null) return Uint8Array.of(FETCH_NOT_FOUND);
    assertCatalogObjectMatchesRequest(envelope, request);
    await this.verifyExactIssuerSignature(envelope);
    if (!await this.isOpenPolicy('catalog-object-fetch-inbound', remotePeerId, request)) {
      return Uint8Array.of(FETCH_DENIED);
    }
    const bytes = canonicalizeSignedControlEnvelopeBytes(envelope);
    if (bytes.byteLength + 1 > RFC64_PUBLIC_CATALOG_OBJECT_FETCH_RESPONSE_MAX_BYTES_V1) {
      fail('catalog-native-resource-refused', 'catalog object exceeds the response ceiling');
    }
    return foundResponse(bytes);
  }

  private async handleBundleFetch(
    data: Uint8Array,
    remotePeerIdInput: string,
  ): Promise<Uint8Array> {
    this.requireStarted();
    const remotePeerId = snapshotPeerId(remotePeerIdInput);
    const request = parseBundleRequest(data);
    if (BigInt(request.byteLength) + 1n
      > BigInt(RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_RESPONSE_MAX_BYTES_V1)) {
      fail('catalog-native-resource-refused', 'requested KA bundle exceeds the response ceiling');
    }
    if (!await this.isOpenPolicy('ka-bundle-fetch-inbound', remotePeerId, request)) {
      return Uint8Array.of(FETCH_DENIED);
    }
    const bundle = await this.options.readKaBundleByDigest(request.blobDigest);
    if (bundle === null) return Uint8Array.of(FETCH_NOT_FOUND);
    assertExactBundle(bundle, request);
    if (!await this.isOpenPolicy('ka-bundle-fetch-inbound', remotePeerId, request)) {
      return Uint8Array.of(FETCH_DENIED);
    }
    return foundResponse(bundle);
  }

  private async isOpenPolicy(
    operation: Rfc64PublicCatalogNativeOperationV1,
    remotePeerId: string,
    request: Rfc64PublicCatalogObjectFetchRequestV1
      | Rfc64PublicCatalogBundleFetchRequestV1,
  ): Promise<boolean> {
    try {
      await this.requireOpenPolicy(operation, remotePeerId, request);
      return true;
    } catch (cause) {
      if (
        cause instanceof Rfc64PublicCatalogNativeTransportErrorV1
        && cause.code === 'catalog-native-policy-denied'
      ) return false;
      throw cause;
    }
  }

  private async requireOpenPolicy(
    operation: Rfc64PublicCatalogNativeOperationV1,
    remotePeerId: string,
    request: Rfc64PublicCatalogObjectFetchRequestV1
      | Rfc64PublicCatalogBundleFetchRequestV1,
  ): Promise<void> {
    let authorization: Rfc64PublicCatalogNativeAuthorizationV1 | null;
    try {
      authorization = await this.options.authorizeOpenCatalogOperation(Object.freeze({
        operation,
        remotePeerId,
        networkId: request.networkId,
        contextGraphId: request.contextGraphId,
        subGraphName: request.subGraphName,
        policyDigest: request.policyDigest,
        catalogHeadObjectDigest: request.catalogHeadObjectDigest,
      }));
    } catch (cause) {
      fail('catalog-native-policy-denied', 'open catalog policy authorization failed', cause);
    }
    if (authorization === null || authorization.accessPolicy !== 0) {
      fail('catalog-native-policy-denied', 'catalog content fetch is not open-policy authorized');
    }
    try {
      assertCanonicalDigest(authorization.policyDigest, 'authorized policyDigest');
    } catch (cause) {
      fail('catalog-native-policy-denied', 'authorization returned an invalid digest', cause);
    }
    if (authorization.policyDigest !== request.policyDigest) {
      fail('catalog-native-policy-denied', 'catalog policy generation is stale or mismatched');
    }
  }

  private async verifyExactIssuerSignature(
    envelope: SignedControlEnvelopeV1,
  ): Promise<VerifiedControlEnvelopeIssuerSignatureV1> {
    try {
      const proof = await this.options.verifyIssuerSignature(envelope);
      const snapshot = readVerifiedControlEnvelopeIssuerSignatureV1(proof);
      if (
        snapshot.objectDigest !== envelope.objectDigest
        || snapshot.signatureVariantDigest !== computeControlSignatureVariantDigestHex(
          envelope.objectDigest,
          envelope.signature,
        )
        || snapshot.issuer !== envelope.issuer
        || snapshot.signatureSuite !== envelope.signatureSuite
      ) {
        throw new Error('issuer-signature proof identifies another envelope');
      }
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

function parseBundleRequest(input: Uint8Array): Rfc64PublicCatalogBundleFetchRequestV1 {
  const parsed = parseRequest(input, BUNDLE_REQUEST_KEYS);
  return validateBundleRequest(parsed);
}

function validateObjectRequest(value: unknown): Rfc64PublicCatalogObjectFetchRequestV1 {
  const scope = validateScope(value, RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1);
  if (!isPlainRecord(value)) throw new Error('unreachable');
  if (typeof value.targetObjectType !== 'string' || value.targetObjectType.length < 1
    || UTF8.encode(value.targetObjectType).byteLength > 256) {
    fail('catalog-native-wire', 'targetObjectType is empty or oversized');
  }
  try {
    assertCanonicalDigest(value.targetObjectDigest, 'targetObjectDigest');
  } catch (cause) {
    fail('catalog-native-wire', 'targetObjectDigest is invalid', cause);
  }
  return Object.freeze({
    ...scope,
    kind: RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1,
    targetObjectType: value.targetObjectType,
    targetObjectDigest: value.targetObjectDigest,
  }) as Rfc64PublicCatalogObjectFetchRequestV1;
}

function validateBundleRequest(value: unknown): Rfc64PublicCatalogBundleFetchRequestV1 {
  const scope = validateScope(value, RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1);
  if (!isPlainRecord(value)) throw new Error('unreachable');
  try {
    assertCanonicalDigest(value.blobDigest, 'blobDigest');
    assertCanonicalDecimalU64(value.byteLength, 'byteLength');
  } catch (cause) {
    fail('catalog-native-wire', 'bundle request contains an invalid digest or length', cause);
  }
  return Object.freeze({
    ...scope,
    kind: RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
    blobDigest: value.blobDigest,
    byteLength: value.byteLength,
  }) as Rfc64PublicCatalogBundleFetchRequestV1;
}

function validateScope(
  value: unknown,
  kind: typeof RFC64_PUBLIC_CATALOG_OBJECT_FETCH_KIND_V1
    | typeof RFC64_PUBLIC_CATALOG_BUNDLE_FETCH_KIND_V1,
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
  if (!isPlainRecord(value)) {
    fail('catalog-native-wire', 'catalog native request must be a plain object');
  }
  const fields: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const field = value[key];
    if (field !== null && typeof field !== 'string') {
      fail('catalog-native-wire', 'catalog native requests accept only string or null fields');
    }
    fields.push(`${JSON.stringify(key)}:${JSON.stringify(field)}`);
  }
  const bytes = UTF8.encode(`{${fields.join(',')}}`);
  if (bytes.byteLength > RFC64_PUBLIC_CATALOG_NATIVE_FETCH_REQUEST_MAX_BYTES_V1) {
    fail('catalog-native-wire', 'catalog native request exceeds its byte ceiling');
  }
  return bytes;
}

function parseRequest(input: Uint8Array, expectedKeys: readonly string[]): Record<string, unknown> {
  if (
    !(input instanceof Uint8Array)
    || input.byteLength < 2
    || input.byteLength > RFC64_PUBLIC_CATALOG_NATIVE_FETCH_REQUEST_MAX_BYTES_V1
  ) {
    fail('catalog-native-wire', 'catalog native request is empty or oversized');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_FATAL.decode(input));
  } catch (cause) {
    fail('catalog-native-wire', 'catalog native request is not strict UTF-8 JSON', cause);
  }
  if (!isPlainRecord(parsed)) fail('catalog-native-wire', 'catalog native request must be an object');
  const actual = Object.keys(parsed).sort();
  if (
    actual.length !== expectedKeys.length
    || actual.some((key, index) => key !== expectedKeys[index])
  ) {
    fail('catalog-native-wire', 'catalog native request has missing or unknown fields');
  }
  const canonical = encodeRequest(parsed);
  if (!bytesEqual(canonical, input)) {
    fail('catalog-native-wire', 'catalog native request bytes are not canonical JCS');
  }
  return parsed;
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
  if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > maxBytes) {
    fail('catalog-native-wire', 'catalog native response is empty or oversized');
  }
  if (input[0] === FETCH_NOT_FOUND) {
    if (input.byteLength !== 1) fail('catalog-native-wire', 'not-found response has trailing bytes');
    return null;
  }
  if (input[0] === FETCH_DENIED) {
    if (input.byteLength !== 1) fail('catalog-native-wire', 'denied response has trailing bytes');
    fail('catalog-native-policy-denied', 'remote peer denied the catalog native fetch');
  }
  if (input[0] !== FETCH_FOUND || input.byteLength === 1) {
    fail('catalog-native-wire', 'catalog native response has an invalid status');
  }
  return input.subarray(1);
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

function foundResponse(payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(payload.byteLength + 1);
  result[0] = FETCH_FOUND;
  result.set(payload, 1);
  return result;
}

function assertCanonicalEvmAddress(value: unknown, label: string): asserts value is EvmAddressV1 {
  if (
    typeof value !== 'string'
    || !/^0x[0-9a-f]{40}$/.test(value)
    || value === '0x0000000000000000000000000000000000000000'
  ) {
    fail('catalog-native-wire', `${label} must be a lowercase nonzero EVM address`);
  }
}

function snapshotPeerId(value: unknown): string {
  if (typeof value !== 'string') fail('catalog-native-input', 'remotePeerId must be a string');
  const byteLength = UTF8.encode(value).byteLength;
  if (byteLength < 1 || byteLength > MAX_PEER_ID_BYTES || value.trim() !== value) {
    fail('catalog-native-input', 'remotePeerId is empty, oversized, or noncanonical');
  }
  return value;
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
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
