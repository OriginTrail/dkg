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
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';

import {
  Rfc64CatalogTransportWireUtilityErrorV1,
  assertRfc64CanonicalEvmAddressV1,
  assertRfc64ExactIssuerSignatureProofV1,
  encodeRfc64FlatCanonicalJsonV1,
  encodeRfc64FoundStatusResponseV1,
  parseRfc64FlatCanonicalJsonV1,
  parseRfc64StatusResponsePayloadV1,
  snapshotRfc64ExactWireRecordV1,
  snapshotRfc64PeerIdV1,
} from './catalog-transport-wire-v1-internal.js';

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
const CURRENT_HEAD_DENIED = 2;
const CURRENT_HEAD_SNAPSHOT_MAX_ATTEMPTS = 2;

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
        async (data, peerId, handlerOptions) =>
          this.handleQuery(data, peerId.toString(), handlerOptions?.signal),
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
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    throwIfAborted(signal);
    this.requireStarted();
    const remotePeerId = snapshotPeerId(remotePeerIdInput);
    const query = parseQuery(data);
    for (let attempt = 0; attempt < CURRENT_HEAD_SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
      if (!await this.isOpenPolicy('current-head-discovery-inbound', remotePeerId, query)) {
        return Uint8Array.of(CURRENT_HEAD_DENIED);
      }
      throwIfAborted(signal);

      const currentDigest = await this.readCurrentAppliedCatalogHeadDigest(query);
      throwIfAborted(signal);
      const announcement = currentDigest === null
        ? null
        : await this.readCurrentAnnouncement(currentDigest, query);
      throwIfAborted(signal);

      // A semantic ref can advance while its immutable object is read. Confirm
      // the pointer immediately before responding so discovery never knowingly
      // advertises a superseded or transient snapshot. One retry admits the
      // common single-writer CAS race while keeping work per request bounded.
      const confirmedDigest = await this.readCurrentAppliedCatalogHeadDigest(query);
      throwIfAborted(signal);
      if (confirmedDigest !== currentDigest) continue;

      if (!await this.isOpenPolicy('current-head-discovery-inbound', remotePeerId, query)) {
        return Uint8Array.of(CURRENT_HEAD_DENIED);
      }
      throwIfAborted(signal);
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
  // Consume caller-owned JavaScript values exactly once through own data
  // descriptors. Reading fields once for validation and again for assembly
  // would let a switching Proxy emit bytes that were never validated. It also
  // avoids invoking accessors that can re-enter policy or lifecycle code.
  const snapshot = snapshotExactWireRecord(value, QUERY_KEYS);
  if (snapshot.kind !== RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1) {
    fail(
      'catalog-discovery-wire',
      `RFC-64 current-head query kind must be ${RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1}`,
    );
  }
  try {
    assertNetworkIdV1(snapshot.networkId);
    assertContextGraphIdV1(snapshot.contextGraphId);
    if (snapshot.subGraphName !== null) assertSubGraphNameV1(snapshot.subGraphName);
    assertCanonicalEvmAddressV1(snapshot.authorAddress, 'authorAddress');
    assertCanonicalDecimalU64(snapshot.catalogEra, 'catalogEra');
    assertCanonicalDigest(snapshot.policyDigest, 'policyDigest');
    return Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_CURRENT_HEAD_QUERY_KIND_V1,
      networkId: snapshot.networkId,
      contextGraphId: snapshot.contextGraphId,
      subGraphName: snapshot.subGraphName,
      authorAddress: snapshot.authorAddress,
      catalogEra: snapshot.catalogEra,
      policyDigest: snapshot.policyDigest,
    });
  } catch (cause) {
    if (cause instanceof Rfc64PublicCatalogCurrentHeadDiscoveryErrorV1) throw cause;
    fail('catalog-discovery-wire', 'RFC-64 current-head query contains an invalid scalar', cause);
  }
}

function foundResponse(announcement: Rfc64PublicCatalogHeadAnnouncementV1): Uint8Array {
  const bytes = encodeRfc64PublicCatalogHeadAnnouncementV1(announcement);
  try {
    return encodeRfc64FoundStatusResponseV1(
      bytes,
      RFC64_PUBLIC_CATALOG_CURRENT_HEAD_RESPONSE_MAX_BYTES_V1,
    );
  } catch (cause) {
    fail('catalog-discovery-wire', 'current-head discovery response exceeds its v1 cap');
  }
}

function parseResponse(input: Uint8Array): Rfc64PublicCatalogHeadAnnouncementV1 | null {
  let framed;
  try {
    framed = parseRfc64StatusResponsePayloadV1(
      input,
      RFC64_PUBLIC_CATALOG_CURRENT_HEAD_RESPONSE_MAX_BYTES_V1,
    );
  } catch (cause) {
    if (
      cause instanceof Rfc64CatalogTransportWireUtilityErrorV1
      && cause.reason === 'response-trailing'
    ) {
      fail(
        'catalog-discovery-wire',
        input[0] === CURRENT_HEAD_NOT_FOUND
          ? 'not-found current-head response has trailing bytes'
          : 'denied current-head response has trailing bytes',
        cause,
      );
    }
    if (
      cause instanceof Rfc64CatalogTransportWireUtilityErrorV1
      && cause.reason === 'response-status'
    ) {
      fail('catalog-discovery-wire', 'current-head discovery response has an invalid status', cause);
    }
    fail('catalog-discovery-wire', 'current-head discovery response is empty or oversized', cause);
  }
  if (framed.status === 'not-found') return null;
  if (framed.status === 'denied') {
    fail('catalog-discovery-policy-denied', 'remote peer denied current-head discovery');
  }
  try {
    return parseRfc64PublicCatalogHeadAnnouncementV1(framed.payload);
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
  try {
    assertRfc64ExactIssuerSignatureProofV1(envelope, proof);
  } catch (cause) {
    fail(
      'catalog-discovery-signature',
      cause instanceof Rfc64CatalogTransportWireUtilityErrorV1
        && cause.reason === 'issuer-proof-unminted'
        ? 'issuer signature proof was not minted by the verifier'
        : 'issuer signature proof is not bound to the exact head envelope',
      cause,
    );
  }
}

function encodeFlatCanonicalJson(value: object, maxBytes: number): Uint8Array {
  try {
    return encodeRfc64FlatCanonicalJsonV1(value, maxBytes);
  } catch (cause) {
    if (cause instanceof Rfc64CatalogTransportWireUtilityErrorV1) {
      if (cause.reason === 'plain-object') {
        fail('catalog-discovery-wire', 'RFC-64 current-head query must be a plain object', cause);
      }
      if (cause.reason === 'field-shape') {
        fail(
          'catalog-discovery-wire',
          'RFC-64 current-head query accepts only string or null fields',
          cause,
        );
      }
      if (cause.reason === 'oversized') {
        fail('catalog-discovery-wire', `RFC-64 current-head query exceeds ${maxBytes} bytes`, cause);
      }
    }
    throw cause;
  }
}

function parseFlatCanonicalJson(
  input: Uint8Array,
  expectedKeys: readonly string[],
  maxBytes: number,
): Record<string, unknown> {
  try {
    return parseRfc64FlatCanonicalJsonV1(input, expectedKeys, maxBytes);
  } catch (cause) {
    if (cause instanceof Rfc64CatalogTransportWireUtilityErrorV1) {
      if (cause.reason === 'oversized') {
        fail('catalog-discovery-wire', 'RFC-64 current-head query is empty or oversized', cause);
      }
      if (cause.reason === 'strict-json') {
        fail('catalog-discovery-wire', 'RFC-64 current-head query is not strict UTF-8 JSON', cause);
      }
      if (cause.reason === 'plain-object') {
        fail('catalog-discovery-wire', 'RFC-64 current-head query must be a plain JSON object', cause);
      }
      if (cause.reason === 'exact-keys') {
        fail('catalog-discovery-wire', 'RFC-64 current-head query has missing or unknown fields', cause);
      }
      if (cause.reason === 'noncanonical') {
        fail('catalog-discovery-wire', 'RFC-64 current-head query bytes are not canonical JCS', cause);
      }
    }
    throw cause;
  }
}

function snapshotExactWireRecord(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    return snapshotRfc64ExactWireRecordV1(value, expectedKeys);
  } catch (cause) {
    if (cause instanceof Rfc64CatalogTransportWireUtilityErrorV1) {
      fail('catalog-discovery-wire', cause.message.replace('RFC-64 wire', 'RFC-64 current-head query'), cause);
    }
    throw cause;
  }
}

function assertCanonicalEvmAddressV1(value: unknown, label: string): asserts value is EvmAddressV1 {
  try {
    assertRfc64CanonicalEvmAddressV1(value, label);
  } catch (cause) {
    fail(
      'catalog-discovery-wire',
      `${label} must be a canonical lowercase nonzero EVM address`,
      cause,
    );
  }
}

function snapshotPeerId(value: unknown): string {
  try {
    return snapshotRfc64PeerIdV1(value);
  } catch (cause) {
    fail(
      'catalog-discovery-input',
      cause instanceof Rfc64CatalogTransportWireUtilityErrorV1
        && cause.reason === 'peer-id-type'
        ? 'remotePeerId must be a string'
        : 'remotePeerId is empty, oversized, or noncanonical',
      cause,
    );
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('RFC-64 current-head discovery request was aborted', {
    cause: signal.reason,
  });
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
