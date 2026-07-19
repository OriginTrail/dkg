// SPDX-License-Identifier: Apache-2.0

/**
 * RFC-64 public/open current-head discovery transport.
 *
 * Discovery is deliberately a narrow hint protocol. A requester names one
 * independently accepted public/open catalog scope and a provider resolves it
 * through a trusted semantic-current-head reader. Before advertising the
 * result, the provider re-reads and verifies the exact signed head object. The
 * requester must still exact-fetch and verify that object before treating the
 * metadata as authenticated; {@link Rfc64PublicCatalogServiceV1} owns that
 * composition.
 *
 * This transport does not stage control objects, schedule reconciliation,
 * choose peers, walk predecessor history, or activate semantic state.
 */

import {
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  ProtocolRouter,
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertContextGraphIdV1,
  assertNetworkIdV1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  assertSubGraphNameV1,
  computeControlSignatureVariantDigestHex,
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

import type { Rfc64PublicCatalogHeadAnnouncementV1 } from './public-catalog-transport-v1.js';
import {
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
  encodeRfc64PublicCatalogHeadAnnouncementV1,
  parseRfc64PublicCatalogHeadAnnouncementV1,
} from './public-catalog-transport-v1.js';

export const RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1 =
  '/dkg/catalog/1/author-head/current' as const;
export const RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1 =
  'rfc64-author-catalog-current-head-query-v1' as const;

export const RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_MAX_BYTES_V1 = 2 * 1024;
export const RFC64_PUBLIC_CATALOG_CURRENT_HEAD_RESPONSE_MAX_BYTES_V1 = 2 * 1024 + 1;

const CURRENT_HEAD_NOT_FOUND = 0;
const CURRENT_HEAD_FOUND = 1;
const CURRENT_HEAD_DENIED = 2;
const CURRENT_HEAD_SNAPSHOT_MAX_ATTEMPTS = 2;
const MAX_PEER_ID_BYTES = 256;
const UTF8 = new TextEncoder();
// Keep a leading BOM visible so canonical re-encoding rejects it.
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const QUERY_KEYS = Object.freeze([
  'authorAddress',
  'catalogEra',
  'contextGraphId',
  'kind',
  'networkId',
  'policyDigest',
  'subGraphName',
] as const);

export interface Rfc64PublicCatalogCurrentHeadScopeV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly subGraphName: SubGraphNameV1 | null;
  readonly authorAddress: EvmAddressV1;
  readonly catalogEra: DecimalU64V1;
}

export interface Rfc64PublicCatalogCurrentHeadQueryV1
  extends Rfc64PublicCatalogCurrentHeadScopeV1 {
  readonly kind: typeof RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1;
  readonly policyDigest: Digest32V1;
}

export type Rfc64PublicCatalogCurrentHeadDiscoveryOperationV1 =
  | 'current-head-discovery-outbound'
  | 'current-head-discovery-inbound';

export interface Rfc64PublicCatalogCurrentHeadAuthorizationInputV1
  extends Rfc64PublicCatalogCurrentHeadScopeV1 {
  readonly operation: Rfc64PublicCatalogCurrentHeadDiscoveryOperationV1;
  readonly remotePeerId: string;
  readonly policyDigest: Digest32V1;
  readonly objectType: typeof AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1;
}

export interface Rfc64PublicCatalogCurrentHeadAuthorizationV1 {
  readonly accessPolicy: ContextGraphAccessPolicyV1;
  readonly policyDigest: Digest32V1;
}

export interface Rfc64PublicCatalogCurrentHeadControlObjectReaderV1 {
  getVerifiedObjectByDigest(input: {
    readonly objectDigest: Digest32V1;
    readonly verifyIssuerSignature: (
      envelope: SignedControlEnvelopeV1,
    ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;
  }): Promise<{
    readonly envelope: SignedControlEnvelopeV1;
    readonly issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
  } | null>;
}

export interface Rfc64PublicCatalogCurrentHeadDiscoveryTransportOptionsV1 {
  readonly controlObjects: Rfc64PublicCatalogCurrentHeadControlObjectReaderV1;
  /**
   * Resolve only a durable, semantically applied current-head pointer for the
   * trusted query scope. A staged-only or candidate pointer violates this
   * capability contract.
   */
  readonly readCurrentAppliedCatalogHeadDigest: (
    query: Rfc64PublicCatalogCurrentHeadQueryV1,
  ) => Promise<Digest32V1 | null>;
  /** Must consult accepted current policy state, never echo the wire digest. */
  readonly authorizeOpenCatalogOperation: (
    input: Rfc64PublicCatalogCurrentHeadAuthorizationInputV1,
  ) => Promise<Rfc64PublicCatalogCurrentHeadAuthorizationV1 | null>;
  readonly verifyIssuerSignature: (
    envelope: SignedControlEnvelopeV1,
  ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;
}

export const RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_ERROR_CODES_V1 = Object.freeze([
  'catalog-discovery-input',
  'catalog-discovery-wire',
  'catalog-discovery-policy-denied',
  'catalog-discovery-object-mismatch',
  'catalog-discovery-signature',
  'catalog-discovery-state',
] as const);

export type Rfc64PublicCatalogCurrentHeadDiscoveryErrorCodeV1 =
  (typeof RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_ERROR_CODES_V1)[number];

export class Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1 extends Error {
  constructor(
    readonly code: Rfc64PublicCatalogCurrentHeadDiscoveryErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1';
  }
}

/**
 * Policy-gated current-head query/response on a production ProtocolRouter.
 * Returned announcements remain hints until the caller exact-fetches and
 * verifies the signed head named by both digests.
 */
export class Rfc64PublicCatalogCurrentHeadDiscoveryTransportV1 {
  #started = false;

  constructor(
    private readonly router: ProtocolRouter,
    private readonly options: Rfc64PublicCatalogCurrentHeadDiscoveryTransportOptionsV1,
  ) {
    if (typeof options?.controlObjects?.getVerifiedObjectByDigest !== 'function') {
      fail('catalog-discovery-input', 'controlObjects.getVerifiedObjectByDigest must be a function');
    }
    if (typeof options.readCurrentAppliedCatalogHeadDigest !== 'function') {
      fail('catalog-discovery-input', 'readCurrentAppliedCatalogHeadDigest must be a function');
    }
    if (typeof options.authorizeOpenCatalogOperation !== 'function') {
      fail('catalog-discovery-input', 'authorizeOpenCatalogOperation must be a function');
    }
    if (typeof options.verifyIssuerSignature !== 'function') {
      fail('catalog-discovery-input', 'verifyIssuerSignature must be a function');
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
        RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1,
        async (data, peerId) => this.handleQuery(data, peerId.toString()),
        { maxReadBytes: RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_MAX_BYTES_V1 },
      );
    } catch (cause) {
      this.#started = false;
      this.router.unregister(RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1);
      throw cause;
    }
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.router.unregister(RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1);
  }

  async discoverCurrentCatalogHead(
    remotePeerIdInput: string,
    queryInput: Rfc64PublicCatalogCurrentHeadQueryV1,
    sendOptions?: SendOptions,
  ): Promise<Rfc64PublicCatalogHeadAnnouncementV1 | null> {
    this.requireStarted();
    const remotePeerId = snapshotPeerId(remotePeerIdInput);
    const query = parseQuery(encodeQuery(queryInput));
    await this.requireOpenPolicy('current-head-discovery-outbound', remotePeerId, query);
    const response = await this.router.send(
      remotePeerId,
      RFC64_PUBLIC_CATALOG_CURRENT_HEAD_DISCOVERY_PROTOCOL_V1,
      encodeQuery(query),
      sendOptions,
    );
    const announcement = parseResponse(response);
    await this.requireOpenPolicy('current-head-discovery-outbound', remotePeerId, query);
    if (announcement === null) return null;
    assertAnnouncementMatchesQuery(announcement, query);
    return announcement;
  }

  private async handleQuery(
    data: Uint8Array,
    remotePeerIdInput: string,
  ): Promise<Uint8Array> {
    this.requireStarted();
    const remotePeerId = snapshotPeerId(remotePeerIdInput);
    const query = parseQuery(data);
    for (let attempt = 0; attempt < CURRENT_HEAD_SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
      if (!await this.isOpenPolicy('current-head-discovery-inbound', remotePeerId, query)) {
        return Uint8Array.of(CURRENT_HEAD_DENIED);
      }

      const currentDigest = await this.readCurrentAppliedCatalogHeadDigest(query);
      const announcement = currentDigest === null
        ? null
        : await this.readCurrentAnnouncement(currentDigest, query);

      // A semantic ref can advance while its immutable object is read. Confirm
      // the pointer immediately before responding so discovery never knowingly
      // advertises a superseded or transient snapshot. One retry admits the
      // common single-writer CAS race while keeping work per request bounded.
      const confirmedDigest = await this.readCurrentAppliedCatalogHeadDigest(query);
      if (confirmedDigest !== currentDigest) continue;

      if (!await this.isOpenPolicy('current-head-discovery-inbound', remotePeerId, query)) {
        return Uint8Array.of(CURRENT_HEAD_DENIED);
      }
      return announcement === null
        ? Uint8Array.of(CURRENT_HEAD_NOT_FOUND)
        : foundResponse(announcement);
    }

    fail(
      'catalog-discovery-state',
      'current applied catalog-head pointer changed during bounded discovery',
    );
  }

  private async readCurrentAppliedCatalogHeadDigest(
    query: Rfc64PublicCatalogCurrentHeadQueryV1,
  ): Promise<Digest32V1 | null> {
    try {
      const currentDigest = await this.options.readCurrentAppliedCatalogHeadDigest(query);
      if (currentDigest !== null) {
        assertCanonicalDigest(currentDigest, 'current catalog head digest');
      }
      return currentDigest;
    } catch (cause) {
      fail('catalog-discovery-state', 'current applied catalog-head lookup failed', cause);
    }
  }

  private async readCurrentAnnouncement(
    currentDigest: Digest32V1,
    query: Rfc64PublicCatalogCurrentHeadQueryV1,
  ): Promise<Rfc64PublicCatalogHeadAnnouncementV1> {
    let stored: Awaited<ReturnType<
      Rfc64PublicCatalogCurrentHeadControlObjectReaderV1['getVerifiedObjectByDigest']
    >>;
    try {
      stored = await this.options.controlObjects.getVerifiedObjectByDigest({
        objectDigest: currentDigest,
        verifyIssuerSignature: this.options.verifyIssuerSignature,
      });
    } catch (cause) {
      fail('catalog-discovery-state', 'current catalog-head object lookup failed', cause);
    }
    if (stored === null) {
      fail(
        'catalog-discovery-state',
        'durable current catalog-head pointer has no exact verified control object',
      );
    }

    let envelope: SignedAuthorCatalogHeadEnvelopeV1;
    try {
      assertSignedAuthorCatalogHeadEnvelopeV1(stored.envelope);
      envelope = stored.envelope;
      assertHeadMatchesQuery(envelope, currentDigest, query);
      assertExactIssuerSignatureProof(envelope, stored.issuerSignature);
    } catch (cause) {
      if (cause instanceof Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1) throw cause;
      fail(
        'catalog-discovery-object-mismatch',
        'current catalog-head pointer does not resolve to the exact queried signed head',
        cause,
      );
    }
    return announcementFromHead(envelope, query.policyDigest);
  }

  private async isOpenPolicy(
    operation: Rfc64PublicCatalogCurrentHeadDiscoveryOperationV1,
    remotePeerId: string,
    query: Rfc64PublicCatalogCurrentHeadQueryV1,
  ): Promise<boolean> {
    try {
      await this.requireOpenPolicy(operation, remotePeerId, query);
      return true;
    } catch (cause) {
      if (
        cause instanceof Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1
        && cause.code === 'catalog-discovery-policy-denied'
      ) return false;
      throw cause;
    }
  }

  private async requireOpenPolicy(
    operation: Rfc64PublicCatalogCurrentHeadDiscoveryOperationV1,
    remotePeerId: string,
    query: Rfc64PublicCatalogCurrentHeadQueryV1,
  ): Promise<void> {
    const input = Object.freeze({
      operation,
      remotePeerId,
      networkId: query.networkId,
      contextGraphId: query.contextGraphId,
      subGraphName: query.subGraphName,
      authorAddress: query.authorAddress,
      catalogEra: query.catalogEra,
      policyDigest: query.policyDigest,
      objectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    }) satisfies Rfc64PublicCatalogCurrentHeadAuthorizationInputV1;
    let authorization: Rfc64PublicCatalogCurrentHeadAuthorizationV1 | null;
    try {
      authorization = await this.options.authorizeOpenCatalogOperation(input);
    } catch (cause) {
      fail('catalog-discovery-policy-denied', 'open catalog discovery authorization failed', cause);
    }
    if (authorization === null || authorization.accessPolicy !== 0) {
      fail('catalog-discovery-policy-denied', 'current-head discovery is not authorized by open policy');
    }
    try {
      assertCanonicalDigest(authorization.policyDigest, 'authorized policyDigest');
    } catch (cause) {
      fail('catalog-discovery-policy-denied', 'discovery authorization returned an invalid digest', cause);
    }
    if (authorization.policyDigest !== query.policyDigest) {
      fail('catalog-discovery-policy-denied', 'current-head discovery policy generation is stale or mismatched');
    }
  }

  private requireStarted(): void {
    if (!this.#started) {
      fail('catalog-discovery-state', 'RFC-64 current-head discovery transport is not started');
    }
  }
}

export function encodeRfc64PublicCatalogCurrentHeadQueryV1(
  input: Rfc64PublicCatalogCurrentHeadQueryV1,
): Uint8Array {
  return encodeQuery(input);
}

export function parseRfc64PublicCatalogCurrentHeadQueryV1(
  input: Uint8Array,
): Rfc64PublicCatalogCurrentHeadQueryV1 {
  return parseQuery(input);
}

function encodeQuery(input: Rfc64PublicCatalogCurrentHeadQueryV1): Uint8Array {
  const snapshot = validateQuery(input);
  return encodeFlatCanonicalJson(snapshot, RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_MAX_BYTES_V1);
}

function parseQuery(input: Uint8Array): Rfc64PublicCatalogCurrentHeadQueryV1 {
  const parsed = parseFlatCanonicalJson(
    input,
    QUERY_KEYS,
    RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_MAX_BYTES_V1,
  );
  return validateQuery(parsed);
}

function validateQuery(value: unknown): Rfc64PublicCatalogCurrentHeadQueryV1 {
  if (!isPlainRecord(value)) {
    fail('catalog-discovery-wire', 'RFC-64 current-head query must be a plain object');
  }
  assertExactWireKeys(value, QUERY_KEYS);
  if (value.kind !== RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1) {
    fail(
      'catalog-discovery-wire',
      `RFC-64 current-head query kind must be ${RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1}`,
    );
  }
  try {
    assertNetworkIdV1(value.networkId);
    assertContextGraphIdV1(value.contextGraphId);
    if (value.subGraphName !== null) assertSubGraphNameV1(value.subGraphName);
    assertCanonicalEvmAddressV1(value.authorAddress, 'authorAddress');
    assertCanonicalDecimalU64(value.catalogEra, 'catalogEra');
    assertCanonicalDigest(value.policyDigest, 'policyDigest');
    return Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1,
      networkId: value.networkId,
      contextGraphId: value.contextGraphId,
      subGraphName: value.subGraphName,
      authorAddress: value.authorAddress,
      catalogEra: value.catalogEra,
      policyDigest: value.policyDigest,
    });
  } catch (cause) {
    if (cause instanceof Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1) throw cause;
    fail('catalog-discovery-wire', 'RFC-64 current-head query contains an invalid scalar', cause);
  }
}

function foundResponse(announcement: Rfc64PublicCatalogHeadAnnouncementV1): Uint8Array {
  const bytes = encodeRfc64PublicCatalogHeadAnnouncementV1(announcement);
  const response = new Uint8Array(bytes.byteLength + 1);
  response[0] = CURRENT_HEAD_FOUND;
  response.set(bytes, 1);
  if (response.byteLength > RFC64_PUBLIC_CATALOG_CURRENT_HEAD_RESPONSE_MAX_BYTES_V1) {
    fail('catalog-discovery-wire', 'current-head discovery response exceeds its v1 cap');
  }
  return response;
}

function parseResponse(input: Uint8Array): Rfc64PublicCatalogHeadAnnouncementV1 | null {
  if (
    !(input instanceof Uint8Array)
    || input.byteLength < 1
    || input.byteLength > RFC64_PUBLIC_CATALOG_CURRENT_HEAD_RESPONSE_MAX_BYTES_V1
  ) {
    fail('catalog-discovery-wire', 'current-head discovery response is empty or oversized');
  }
  if (input[0] === CURRENT_HEAD_NOT_FOUND) {
    if (input.byteLength !== 1) {
      fail('catalog-discovery-wire', 'not-found current-head response has trailing bytes');
    }
    return null;
  }
  if (input[0] === CURRENT_HEAD_DENIED) {
    if (input.byteLength !== 1) {
      fail('catalog-discovery-wire', 'denied current-head response has trailing bytes');
    }
    fail('catalog-discovery-policy-denied', 'remote peer denied current-head discovery');
  }
  if (input[0] !== CURRENT_HEAD_FOUND || input.byteLength === 1) {
    fail('catalog-discovery-wire', 'current-head discovery response has an invalid status');
  }
  try {
    return parseRfc64PublicCatalogHeadAnnouncementV1(input.subarray(1));
  } catch (cause) {
    fail('catalog-discovery-wire', 'current-head discovery response is not canonical', cause);
  }
}

function assertAnnouncementMatchesQuery(
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  query: Rfc64PublicCatalogCurrentHeadQueryV1,
): void {
  if (
    announcement.networkId !== query.networkId
    || announcement.contextGraphId !== query.contextGraphId
    || announcement.subGraphName !== query.subGraphName
    || announcement.authorAddress !== query.authorAddress
    || announcement.catalogEra !== query.catalogEra
    || announcement.policyDigest !== query.policyDigest
  ) {
    fail(
      'catalog-discovery-object-mismatch',
      'discovered catalog-head metadata does not match the exact requested scope',
    );
  }
}

function assertHeadMatchesQuery(
  envelope: SignedAuthorCatalogHeadEnvelopeV1,
  currentDigest: Digest32V1,
  query: Rfc64PublicCatalogCurrentHeadQueryV1,
): void {
  const payload = envelope.payload;
  if (
    envelope.objectDigest !== currentDigest
    || payload.networkId !== query.networkId
    || payload.contextGraphId !== query.contextGraphId
    || payload.subGraphName !== query.subGraphName
    || payload.authorAddress !== query.authorAddress
    || payload.era !== query.catalogEra
  ) {
    fail(
      'catalog-discovery-object-mismatch',
      'current catalog-head object does not match the exact requested scope and digest',
    );
  }
}

function announcementFromHead(
  envelope: SignedAuthorCatalogHeadEnvelopeV1,
  policyDigest: Digest32V1,
): Rfc64PublicCatalogHeadAnnouncementV1 {
  return Object.freeze({
    kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
    networkId: envelope.payload.networkId,
    contextGraphId: envelope.payload.contextGraphId,
    subGraphName: envelope.payload.subGraphName,
    authorAddress: envelope.payload.authorAddress,
    catalogEra: envelope.payload.era,
    catalogVersion: envelope.payload.version,
    policyDigest,
    catalogHeadObjectDigest: envelope.objectDigest as Digest32V1,
    signatureVariantDigest: computeControlSignatureVariantDigestHex(
      envelope.objectDigest,
      envelope.signature,
    ) as Digest32V1,
  });
}

function assertExactIssuerSignatureProof(
  envelope: SignedAuthorCatalogHeadEnvelopeV1,
  proof: VerifiedControlEnvelopeIssuerSignatureV1,
): void {
  let snapshot;
  try {
    snapshot = readVerifiedControlEnvelopeIssuerSignatureV1(proof);
  } catch (cause) {
    fail('catalog-discovery-signature', 'issuer signature proof was not minted by the verifier', cause);
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
    fail('catalog-discovery-signature', 'issuer signature proof is not bound to the exact head envelope');
  }
}

function encodeFlatCanonicalJson(value: object, maxBytes: number): Uint8Array {
  if (!isPlainRecord(value)) {
    fail('catalog-discovery-wire', 'RFC-64 current-head query must be a plain object');
  }
  const fields: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const field = value[key];
    if (field !== null && typeof field !== 'string') {
      fail('catalog-discovery-wire', 'RFC-64 current-head query accepts only string or null fields');
    }
    fields.push(`${JSON.stringify(key)}:${JSON.stringify(field)}`);
  }
  const bytes = UTF8.encode(`{${fields.join(',')}}`);
  if (bytes.byteLength > maxBytes) {
    fail('catalog-discovery-wire', `RFC-64 current-head query exceeds ${maxBytes} bytes`);
  }
  return bytes;
}

function parseFlatCanonicalJson(
  input: Uint8Array,
  expectedKeys: readonly string[],
  maxBytes: number,
): Record<string, unknown> {
  if (!(input instanceof Uint8Array) || input.byteLength < 2 || input.byteLength > maxBytes) {
    fail('catalog-discovery-wire', 'RFC-64 current-head query is empty or oversized');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_FATAL.decode(input));
  } catch (cause) {
    fail('catalog-discovery-wire', 'RFC-64 current-head query is not strict UTF-8 JSON', cause);
  }
  if (!isPlainRecord(parsed)) {
    fail('catalog-discovery-wire', 'RFC-64 current-head query must be a plain JSON object');
  }
  assertExactWireKeys(parsed, expectedKeys);
  if (!bytesEqual(encodeFlatCanonicalJson(parsed, maxBytes), input)) {
    fail('catalog-discovery-wire', 'RFC-64 current-head query bytes are not canonical JCS');
  }
  return parsed;
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
    fail('catalog-discovery-wire', 'RFC-64 current-head query has missing or unknown fields');
  }
}

function assertCanonicalEvmAddressV1(value: unknown, label: string): asserts value is EvmAddressV1 {
  if (
    typeof value !== 'string'
    || !/^0x[0-9a-f]{40}$/.test(value)
    || value === '0x0000000000000000000000000000000000000000'
  ) {
    fail('catalog-discovery-wire', `${label} must be a canonical lowercase nonzero EVM address`);
  }
}

function snapshotPeerId(value: unknown): string {
  if (typeof value !== 'string') {
    fail('catalog-discovery-input', 'remotePeerId must be a string');
  }
  const byteLength = UTF8.encode(value).byteLength;
  if (byteLength < 1 || byteLength > MAX_PEER_ID_BYTES || value.trim() !== value) {
    fail('catalog-discovery-input', 'remotePeerId is empty, oversized, or noncanonical');
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function fail(
  code: Rfc64PublicCatalogCurrentHeadDiscoveryErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
