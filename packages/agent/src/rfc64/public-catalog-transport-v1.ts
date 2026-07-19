import {
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  ProtocolRouter,
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertContextGraphIdV1,
  assertNetworkIdV1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  assertSubGraphNameV1,
  canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1,
  computeControlSignatureVariantDigestHex,
  parseCanonicalSignedAuthorCatalogHeadEnvelopeV1,
  type ContextGraphAccessPolicyV1,
  type ContextGraphIdV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type SendOptions,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedControlEnvelopeV1,
  type SubGraphNameV1,
} from '@origintrail-official/dkg-core';
import {
  readVerifiedControlEnvelopeIssuerSignatureV1,
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';

import {
  assertCanonicalWireEvmAddressV1,
  bytesEqualV1 as bytesEqual,
  encodeFlatCanonicalJsonV1,
  isPlainRecordV1 as isPlainRecord,
  parseFlatCanonicalJsonV1,
  snapshotWirePeerIdV1,
  type Rfc64FlatWireDiagnosticsV1,
  type Rfc64WireFailV1,
} from './public-catalog-wire-internal-v1.js';

/**
 * Additive RFC-64 protocol IDs. Their `/catalog/1` component is the wire
 * compatibility boundary; neither protocol is negotiated under a legacy sync ID.
 */
export const RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1 =
  '/dkg/catalog/1/author-head-availability' as const;
export const RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1 =
  '/dkg/catalog/1/control-object/author-head' as const;

export const RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1 =
  'rfc64-author-catalog-head-availability-v1' as const;
export const RFC64_PUBLIC_CATALOG_HEAD_FETCH_KIND_V1 =
  'rfc64-author-catalog-head-fetch-v1' as const;

/** Flat JCS request caps; the fetched signed head has a separate response cap. */
export const RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_MAX_BYTES_V1 = 2 * 1024;
export const RFC64_PUBLIC_CATALOG_HEAD_FETCH_REQUEST_MAX_BYTES_V1 = 2 * 1024;
export const RFC64_PUBLIC_CATALOG_HEAD_FETCH_RESPONSE_MAX_BYTES_V1 = 32 * 1024;

const ACK = Uint8Array.of(1);
const ANNOUNCEMENT_DENIED = 0;
const FETCH_NOT_FOUND = 0;
const FETCH_FOUND = 1;
const FETCH_DENIED = 2;

const ANNOUNCEMENT_KEYS = Object.freeze([
  'authorAddress',
  'catalogEra',
  'catalogHeadObjectDigest',
  'catalogVersion',
  'contextGraphId',
  'kind',
  'networkId',
  'policyDigest',
  'signatureVariantDigest',
  'subGraphName',
] as const);

const FETCH_REQUEST_KEYS = ANNOUNCEMENT_KEYS;

export interface Rfc64PublicCatalogHeadAnnouncementV1 {
  readonly kind: typeof RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1;
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly subGraphName: SubGraphNameV1 | null;
  readonly authorAddress: EvmAddressV1;
  readonly catalogEra: DecimalU64V1;
  readonly catalogVersion: DecimalU64V1;
  readonly policyDigest: Digest32V1;
  readonly catalogHeadObjectDigest: Digest32V1;
  readonly signatureVariantDigest: Digest32V1;
}

export interface Rfc64PublicCatalogHeadFetchRequestV1 {
  readonly kind: typeof RFC64_PUBLIC_CATALOG_HEAD_FETCH_KIND_V1;
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly subGraphName: SubGraphNameV1 | null;
  readonly authorAddress: EvmAddressV1;
  readonly catalogEra: DecimalU64V1;
  readonly catalogVersion: DecimalU64V1;
  readonly policyDigest: Digest32V1;
  readonly catalogHeadObjectDigest: Digest32V1;
  readonly signatureVariantDigest: Digest32V1;
}

export type Rfc64PublicCatalogOperationV1 =
  | 'announce-outbound'
  | 'announce-inbound'
  | 'fetch-outbound'
  | 'fetch-inbound';

export interface Rfc64PublicCatalogAuthorizationInputV1 {
  readonly operation: Rfc64PublicCatalogOperationV1;
  readonly remotePeerId: string;
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly subGraphName: SubGraphNameV1 | null;
  readonly policyDigest: Digest32V1;
  readonly objectType: typeof AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1;
}

/**
 * A caller-minted current-policy decision. The transport independently requires
 * `accessPolicy === 0` and an exact digest match, so returning a private policy or
 * a different policy generation always fails closed.
 */
export interface Rfc64PublicCatalogAuthorizationV1 {
  readonly accessPolicy: ContextGraphAccessPolicyV1;
  readonly policyDigest: Digest32V1;
}

export interface Rfc64PublicCatalogControlObjectReaderV1 {
  getVerifiedObject(input: {
    readonly objectDigest: Digest32V1;
    readonly signatureVariantDigest: Digest32V1;
    readonly verifyIssuerSignature: (
      envelope: SignedControlEnvelopeV1,
    ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;
  }): Promise<{
    readonly envelope: SignedControlEnvelopeV1;
    readonly issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
  } | null>;
}

export interface FetchedRfc64PublicCatalogHeadV1 {
  readonly envelope: SignedAuthorCatalogHeadEnvelopeV1;
  readonly issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
}

export interface Rfc64PublicCatalogTransportOptionsV1 {
  readonly controlObjects: Rfc64PublicCatalogControlObjectReaderV1;
  /** Must consult accepted current policy state, not the untrusted wire hint. */
  readonly authorizeOpenCatalogOperation: (
    input: Rfc64PublicCatalogAuthorizationInputV1,
  ) => Promise<Rfc64PublicCatalogAuthorizationV1 | null>;
  /** Generic envelope cryptography only; object-specific head/scope binding is local. */
  readonly verifyIssuerSignature: (
    envelope: SignedControlEnvelopeV1,
  ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;
  /** Receives an untrusted, policy-admitted hint. It grants no catalog authority. */
  readonly onCatalogHeadAvailable: (
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    remotePeerId: string,
  ) => void | Promise<void>;
}

export const RFC64_PUBLIC_CATALOG_TRANSPORT_ERROR_CODES_V1 = Object.freeze([
  'catalog-transport-input',
  'catalog-transport-wire',
  'catalog-transport-policy-denied',
  'catalog-transport-object-mismatch',
  'catalog-transport-signature',
  'catalog-transport-state',
] as const);

export type Rfc64PublicCatalogTransportErrorCodeV1 =
  (typeof RFC64_PUBLIC_CATALOG_TRANSPORT_ERROR_CODES_V1)[number];

export class Rfc64PublicCatalogTransportErrorV1 extends Error {
  constructor(
    readonly code: Rfc64PublicCatalogTransportErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64PublicCatalogTransportErrorV1';
  }
}

/**
 * Small public/open RFC-64 transport slice.
 *
 * It deliberately does not select peers, activate catalog state, admit candidate
 * rows, or support invite-only policy. Announcements are only untrusted hints;
 * every served and received head is fetched by both exact digests, structurally
 * bound to the hint, and reverified with the generic signature verifier.
 */
export class Rfc64PublicCatalogTransportV1 {
  #started = false;

  constructor(
    private readonly router: ProtocolRouter,
    private readonly options: Rfc64PublicCatalogTransportOptionsV1,
  ) {
    if (typeof options?.controlObjects?.getVerifiedObject !== 'function') {
      fail('catalog-transport-input', 'controlObjects.getVerifiedObject must be a function');
    }
    if (typeof options.authorizeOpenCatalogOperation !== 'function') {
      fail('catalog-transport-input', 'authorizeOpenCatalogOperation must be a function');
    }
    if (typeof options.verifyIssuerSignature !== 'function') {
      fail('catalog-transport-input', 'verifyIssuerSignature must be a function');
    }
    if (typeof options.onCatalogHeadAvailable !== 'function') {
      fail('catalog-transport-input', 'onCatalogHeadAvailable must be a function');
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
        RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1,
        async (data, peerId) => this.handleAnnouncement(data, peerId.toString()),
        { maxReadBytes: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_MAX_BYTES_V1 },
      );
      this.router.register(
        RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1,
        async (data, peerId) => this.handleFetch(data, peerId.toString()),
        { maxReadBytes: RFC64_PUBLIC_CATALOG_HEAD_FETCH_REQUEST_MAX_BYTES_V1 },
      );
    } catch (cause) {
      this.#started = false;
      this.router.unregister(RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1);
      this.router.unregister(RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1);
      throw cause;
    }
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.router.unregister(RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1);
    this.router.unregister(RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1);
  }

  async announceCatalogHead(
    remotePeerId: string,
    announcementInput: Rfc64PublicCatalogHeadAnnouncementV1,
    sendOptions?: SendOptions,
  ): Promise<void> {
    this.requireStarted();
    const peerId = snapshotPeerId(remotePeerId);
    const announcement = parseAnnouncement(encodeAnnouncement(announcementInput));
    await this.requireOpenPolicy('announce-outbound', peerId, announcement);
    const response = await this.router.send(
      peerId,
      RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1,
      encodeAnnouncement(announcement),
      sendOptions,
    );
    if (response.byteLength === 1 && response[0] === ANNOUNCEMENT_DENIED) {
      fail('catalog-transport-policy-denied', 'remote peer denied the catalog-head announcement');
    }
    if (response.byteLength !== 1 || response[0] !== ACK[0]) {
      fail('catalog-transport-wire', 'catalog-head announcement returned an invalid acknowledgement');
    }
    await this.requireOpenPolicy('announce-outbound', peerId, announcement);
  }

  async fetchCatalogHead(
    remotePeerId: string,
    announcementInput: Rfc64PublicCatalogHeadAnnouncementV1,
    sendOptions?: SendOptions,
  ): Promise<FetchedRfc64PublicCatalogHeadV1 | null> {
    this.requireStarted();
    const peerId = snapshotPeerId(remotePeerId);
    const announcement = parseAnnouncement(encodeAnnouncement(announcementInput));
    await this.requireOpenPolicy('fetch-outbound', peerId, announcement);
    const request = requestFromAnnouncement(announcement);
    const response = await this.router.send(
      peerId,
      RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1,
      encodeFetchRequest(request),
      sendOptions,
    );
    const envelope = parseFetchResponse(response);
    await this.requireOpenPolicy('fetch-outbound', peerId, announcement);
    if (envelope === null) return null;
    assertHeadMatchesAnnouncement(envelope, announcement);
    const issuerSignature = await this.verifyExactIssuerSignature(envelope);
    return Object.freeze({
      envelope: deepFreeze(envelope),
      issuerSignature,
    });
  }

  private async handleAnnouncement(
    data: Uint8Array,
    remotePeerIdInput: string,
  ): Promise<Uint8Array> {
    this.requireStarted();
    const remotePeerId = snapshotPeerId(remotePeerIdInput);
    const announcement = parseAnnouncement(data);
    if (!await this.isOpenPolicy('announce-inbound', remotePeerId, announcement)) {
      return Uint8Array.of(ANNOUNCEMENT_DENIED);
    }
    await this.options.onCatalogHeadAvailable(announcement, remotePeerId);
    if (!await this.isOpenPolicy('announce-inbound', remotePeerId, announcement)) {
      return Uint8Array.of(ANNOUNCEMENT_DENIED);
    }
    return ACK;
  }

  private async handleFetch(
    data: Uint8Array,
    remotePeerIdInput: string,
  ): Promise<Uint8Array> {
    this.requireStarted();
    const remotePeerId = snapshotPeerId(remotePeerIdInput);
    const request = parseFetchRequest(data);
    if (!await this.isOpenPolicy('fetch-inbound', remotePeerId, request)) {
      return Uint8Array.of(FETCH_DENIED);
    }
    const stored = await this.options.controlObjects.getVerifiedObject({
      objectDigest: request.catalogHeadObjectDigest,
      signatureVariantDigest: request.signatureVariantDigest,
      verifyIssuerSignature: this.options.verifyIssuerSignature,
    });
    if (stored === null) {
      if (!await this.isOpenPolicy('fetch-inbound', remotePeerId, request)) {
        return Uint8Array.of(FETCH_DENIED);
      }
      return Uint8Array.of(FETCH_NOT_FOUND);
    }
    let envelope: SignedAuthorCatalogHeadEnvelopeV1;
    try {
      assertSignedAuthorCatalogHeadEnvelopeV1(stored.envelope);
      envelope = stored.envelope;
      assertHeadMatchesRequest(envelope, request);
      assertExactIssuerSignatureProof(envelope, stored.issuerSignature);
    } catch (cause) {
      fail(
        'catalog-transport-object-mismatch',
        'stored object is not the exact requested author-catalog head',
        cause,
      );
    }
    const envelopeBytes = canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1(envelope);
    const response = new Uint8Array(1 + envelopeBytes.byteLength);
    response[0] = FETCH_FOUND;
    response.set(envelopeBytes, 1);
    if (response.byteLength > RFC64_PUBLIC_CATALOG_HEAD_FETCH_RESPONSE_MAX_BYTES_V1) {
      fail('catalog-transport-wire', 'author-catalog head exceeds the v1 fetch response cap');
    }
    if (!await this.isOpenPolicy('fetch-inbound', remotePeerId, request)) {
      return Uint8Array.of(FETCH_DENIED);
    }
    return response;
  }

  private async isOpenPolicy(
    operation: Rfc64PublicCatalogOperationV1,
    remotePeerId: string,
    scope: Rfc64PublicCatalogHeadAnnouncementV1 | Rfc64PublicCatalogHeadFetchRequestV1,
  ): Promise<boolean> {
    try {
      await this.requireOpenPolicy(operation, remotePeerId, scope);
      return true;
    } catch (cause) {
      if (
        cause instanceof Rfc64PublicCatalogTransportErrorV1
        && cause.code === 'catalog-transport-policy-denied'
      ) return false;
      throw cause;
    }
  }

  private async requireOpenPolicy(
    operation: Rfc64PublicCatalogOperationV1,
    remotePeerId: string,
    scope: Rfc64PublicCatalogHeadAnnouncementV1 | Rfc64PublicCatalogHeadFetchRequestV1,
  ): Promise<void> {
    const input = Object.freeze({
      operation,
      remotePeerId,
      networkId: scope.networkId,
      contextGraphId: scope.contextGraphId,
      subGraphName: scope.subGraphName,
      policyDigest: scope.policyDigest,
      objectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    }) satisfies Rfc64PublicCatalogAuthorizationInputV1;
    let authorization: Rfc64PublicCatalogAuthorizationV1 | null;
    try {
      authorization = await this.options.authorizeOpenCatalogOperation(input);
    } catch (cause) {
      fail('catalog-transport-policy-denied', 'open catalog policy authorization failed', cause);
    }
    if (authorization === null || authorization.accessPolicy !== 0) {
      fail('catalog-transport-policy-denied', 'catalog operation is not authorized by open access policy');
    }
    try {
      assertCanonicalDigest(authorization.policyDigest, 'authorized policyDigest');
    } catch (cause) {
      fail('catalog-transport-policy-denied', 'policy authorization returned an invalid digest', cause);
    }
    if (authorization.policyDigest !== scope.policyDigest) {
      fail('catalog-transport-policy-denied', 'catalog operation policy generation is stale or mismatched');
    }
  }

  private async verifyExactIssuerSignature(
    envelope: SignedAuthorCatalogHeadEnvelopeV1,
  ): Promise<VerifiedControlEnvelopeIssuerSignatureV1> {
    let proof: VerifiedControlEnvelopeIssuerSignatureV1;
    try {
      proof = await this.options.verifyIssuerSignature(envelope);
      assertExactIssuerSignatureProof(envelope, proof);
      return proof;
    } catch (cause) {
      fail('catalog-transport-signature', 'received author-catalog head signature is invalid', cause);
    }
  }

  private requireStarted(): void {
    if (!this.#started) {
      fail('catalog-transport-state', 'RFC-64 public catalog transport is not started');
    }
  }
}

export function encodeRfc64PublicCatalogHeadAnnouncementV1(
  input: Rfc64PublicCatalogHeadAnnouncementV1,
): Uint8Array {
  return encodeAnnouncement(input);
}

export function parseRfc64PublicCatalogHeadAnnouncementV1(
  input: Uint8Array,
): Rfc64PublicCatalogHeadAnnouncementV1 {
  return parseAnnouncement(input);
}

export function encodeRfc64PublicCatalogHeadFetchRequestV1(
  input: Rfc64PublicCatalogHeadFetchRequestV1,
): Uint8Array {
  return encodeFetchRequest(input);
}

export function parseRfc64PublicCatalogHeadFetchRequestV1(
  input: Uint8Array,
): Rfc64PublicCatalogHeadFetchRequestV1 {
  return parseFetchRequest(input);
}

function requestFromAnnouncement(
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
): Rfc64PublicCatalogHeadFetchRequestV1 {
  return Object.freeze({
    ...announcement,
    kind: RFC64_PUBLIC_CATALOG_HEAD_FETCH_KIND_V1,
  });
}

function encodeAnnouncement(input: Rfc64PublicCatalogHeadAnnouncementV1): Uint8Array {
  const snapshot = validateWireScope(input, RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1);
  return encodeFlatCanonicalJson(snapshot, RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_MAX_BYTES_V1);
}

function parseAnnouncement(input: Uint8Array): Rfc64PublicCatalogHeadAnnouncementV1 {
  const parsed = parseFlatCanonicalJson(
    input,
    ANNOUNCEMENT_KEYS,
    RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_MAX_BYTES_V1,
  );
  return validateWireScope(
    parsed,
    RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
  );
}

function encodeFetchRequest(input: Rfc64PublicCatalogHeadFetchRequestV1): Uint8Array {
  const snapshot = validateWireScope(input, RFC64_PUBLIC_CATALOG_HEAD_FETCH_KIND_V1);
  return encodeFlatCanonicalJson(snapshot, RFC64_PUBLIC_CATALOG_HEAD_FETCH_REQUEST_MAX_BYTES_V1);
}

function parseFetchRequest(input: Uint8Array): Rfc64PublicCatalogHeadFetchRequestV1 {
  const parsed = parseFlatCanonicalJson(
    input,
    FETCH_REQUEST_KEYS,
    RFC64_PUBLIC_CATALOG_HEAD_FETCH_REQUEST_MAX_BYTES_V1,
  );
  return validateWireScope(parsed, RFC64_PUBLIC_CATALOG_HEAD_FETCH_KIND_V1);
}

function validateWireScope<Kind extends
  | typeof RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1
  | typeof RFC64_PUBLIC_CATALOG_HEAD_FETCH_KIND_V1>(
  value: unknown,
  expectedKind: Kind,
): Kind extends typeof RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1
  ? Rfc64PublicCatalogHeadAnnouncementV1
  : Rfc64PublicCatalogHeadFetchRequestV1 {
  if (!isPlainRecord(value)) {
    fail('catalog-transport-wire', 'RFC-64 catalog message must be a plain object');
  }
  assertExactWireKeys(value, expectedKind === RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1
    ? ANNOUNCEMENT_KEYS
    : FETCH_REQUEST_KEYS);
  if (value.kind !== expectedKind) {
    fail('catalog-transport-wire', `RFC-64 catalog message kind must be ${expectedKind}`);
  }
  try {
    assertNetworkIdV1(value.networkId);
    assertContextGraphIdV1(value.contextGraphId);
    if (value.subGraphName !== null) assertSubGraphNameV1(value.subGraphName);
    assertCanonicalEvmAddressV1(value.authorAddress, 'authorAddress');
    assertCanonicalDecimalU64(value.catalogEra, 'catalogEra');
    assertCanonicalDecimalU64(value.catalogVersion, 'catalogVersion');
    assertCanonicalDigest(value.policyDigest, 'policyDigest');
    assertCanonicalDigest(value.catalogHeadObjectDigest, 'catalogHeadObjectDigest');
    assertCanonicalDigest(value.signatureVariantDigest, 'signatureVariantDigest');
    return Object.freeze({
      authorAddress: value.authorAddress,
      catalogEra: value.catalogEra,
      catalogHeadObjectDigest: value.catalogHeadObjectDigest,
      catalogVersion: value.catalogVersion,
      contextGraphId: value.contextGraphId,
      kind: expectedKind,
      networkId: value.networkId,
      policyDigest: value.policyDigest,
      signatureVariantDigest: value.signatureVariantDigest,
      subGraphName: value.subGraphName,
    }) as never;
  } catch (cause) {
    if (cause instanceof Rfc64PublicCatalogTransportErrorV1) throw cause;
    fail('catalog-transport-wire', 'RFC-64 catalog message contains an invalid scalar', cause);
  }
}

function parseFetchResponse(input: Uint8Array): SignedAuthorCatalogHeadEnvelopeV1 | null {
  if (
    input.byteLength < 1
    || input.byteLength > RFC64_PUBLIC_CATALOG_HEAD_FETCH_RESPONSE_MAX_BYTES_V1
  ) {
    fail('catalog-transport-wire', 'author-catalog head response is empty or oversized');
  }
  if (input[0] === FETCH_NOT_FOUND) {
    if (input.byteLength !== 1) {
      fail('catalog-transport-wire', 'not-found author-catalog response has trailing bytes');
    }
    return null;
  }
  if (input[0] === FETCH_DENIED) {
    if (input.byteLength !== 1) {
      fail('catalog-transport-wire', 'denied author-catalog response has trailing bytes');
    }
    fail('catalog-transport-policy-denied', 'remote peer denied the author-catalog fetch');
  }
  if (input[0] !== FETCH_FOUND || input.byteLength === 1) {
    fail('catalog-transport-wire', 'author-catalog head response has an invalid status');
  }
  try {
    return parseCanonicalSignedAuthorCatalogHeadEnvelopeV1(input.subarray(1), {
      maxBytes: RFC64_PUBLIC_CATALOG_HEAD_FETCH_RESPONSE_MAX_BYTES_V1 - 1,
    });
  } catch (cause) {
    fail('catalog-transport-wire', 'author-catalog head response is not canonical', cause);
  }
}

function assertHeadMatchesAnnouncement(
  envelope: SignedAuthorCatalogHeadEnvelopeV1,
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
): void {
  assertHeadMatchesScope(envelope, announcement, 'announcement');
}

function assertHeadMatchesRequest(
  envelope: SignedAuthorCatalogHeadEnvelopeV1,
  request: Rfc64PublicCatalogHeadFetchRequestV1,
): void {
  assertHeadMatchesScope(envelope, request, 'request');
}

function assertHeadMatchesScope(
  envelope: SignedAuthorCatalogHeadEnvelopeV1,
  scope: Rfc64PublicCatalogHeadAnnouncementV1 | Rfc64PublicCatalogHeadFetchRequestV1,
  label: string,
): void {
  try {
    assertSignedAuthorCatalogHeadEnvelopeV1(envelope);
  } catch (cause) {
    fail('catalog-transport-object-mismatch', `fetched object is not an author-catalog head`, cause);
  }
  const payload = envelope.payload;
  if (
    envelope.objectDigest !== scope.catalogHeadObjectDigest
    || computeControlSignatureVariantDigestHex(envelope.objectDigest, envelope.signature)
      !== scope.signatureVariantDigest
    || payload.networkId !== scope.networkId
    || payload.contextGraphId !== scope.contextGraphId
    || payload.subGraphName !== scope.subGraphName
    || payload.authorAddress !== scope.authorAddress
    || payload.era !== scope.catalogEra
    || payload.version !== scope.catalogVersion
  ) {
    fail(
      'catalog-transport-object-mismatch',
      `author-catalog head does not match its exact ${label} scope and keys`,
    );
  }
  const bytes = canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1(envelope);
  if (bytes.byteLength > RFC64_PUBLIC_CATALOG_HEAD_FETCH_RESPONSE_MAX_BYTES_V1 - 1) {
    fail('catalog-transport-object-mismatch', 'author-catalog head exceeds the transport cap');
  }
}

function assertExactIssuerSignatureProof(
  envelope: SignedControlEnvelopeV1,
  proof: VerifiedControlEnvelopeIssuerSignatureV1,
): void {
  let snapshot;
  try {
    snapshot = readVerifiedControlEnvelopeIssuerSignatureV1(proof);
  } catch (cause) {
    fail('catalog-transport-signature', 'issuer signature proof was not minted by the verifier', cause);
  }
  const expectedVariant = computeControlSignatureVariantDigestHex(
    envelope.objectDigest,
    envelope.signature,
  );
  if (
    snapshot.objectDigest !== envelope.objectDigest
    || snapshot.signatureVariantDigest !== expectedVariant
    || snapshot.issuer !== envelope.issuer
    || snapshot.signatureSuite !== envelope.signatureSuite
  ) {
    fail('catalog-transport-signature', 'issuer signature proof is not bound to the exact envelope');
  }
}

const FLAT_WIRE_DIAGNOSTICS: Rfc64FlatWireDiagnosticsV1 = Object.freeze({
  notPlainObject: 'RFC-64 catalog message must be a plain object',
  nonStringField: 'RFC-64 catalog messages accept only string or null fields',
  exceedsMaxBytes: (maxBytes: number) => `RFC-64 catalog message exceeds ${maxBytes} bytes`,
  emptyOrOversized: 'RFC-64 catalog message is empty or oversized',
  notStrictUtf8Json: 'RFC-64 catalog message is not strict UTF-8 JSON',
  notPlainJsonObject: 'RFC-64 catalog message must be a plain JSON object',
  notCanonical: 'RFC-64 catalog message bytes are not canonical JCS',
});

const failWire: Rfc64WireFailV1 = (message, cause) =>
  fail('catalog-transport-wire', message, cause);

function encodeFlatCanonicalJson(
  value: object,
  maxBytes: number,
): Uint8Array {
  return encodeFlatCanonicalJsonV1(value, maxBytes, FLAT_WIRE_DIAGNOSTICS, failWire);
}

function parseFlatCanonicalJson(
  input: Uint8Array,
  expectedKeys: readonly string[],
  maxBytes: number,
): Record<string, unknown> {
  return parseFlatCanonicalJsonV1(
    input,
    maxBytes,
    FLAT_WIRE_DIAGNOSTICS,
    failWire,
    (parsed) => assertExactWireKeys(parsed, expectedKeys),
  );
}

function assertExactWireKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expectedKeys.length
    || actual.some((key, index) => key !== expectedKeys[index])
  ) {
    fail('catalog-transport-wire', 'RFC-64 catalog message has missing or unknown fields');
  }
}

function assertCanonicalEvmAddressV1(value: unknown, label: string): asserts value is EvmAddressV1 {
  assertCanonicalWireEvmAddressV1(value, label, failWire);
}

function snapshotPeerId(value: unknown): string {
  return snapshotWirePeerIdV1(
    value,
    (message, cause) => fail('catalog-transport-input', message, cause),
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function fail(
  code: Rfc64PublicCatalogTransportErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64PublicCatalogTransportErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
