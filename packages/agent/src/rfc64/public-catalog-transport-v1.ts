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

import type {
  Rfc64CatalogAccessAuthorizationV1,
  Rfc64CatalogAccessPolicyRegistryV1,
} from './catalog-access-policy-v1.js';
import {
  normalizeRfc64CatalogTransportAuthorizerV1,
  recheckCurrentRfc64CatalogPolicyAfterAwaitV1,
  withAuthorizedCurrentRfc64CatalogPolicyV1,
  withCurrentRfc64CatalogPolicyV1,
} from './catalog-transport-authorization-v1.js';
import type { Rfc64AuthorizedCatalogWorkResultV1 } from './catalog-transport-authorization-v1.js';
import {
  assertRfc64ExactIssuerSignatureProofV1,
  createRfc64CatalogTransportWireAdapterV1,
  encodeRfc64FoundStatusResponseV1,
  parseRfc64StatusResponsePayloadV1,
  rethrowRfc64CatalogTransportWireUtilityErrorV1,
  type Rfc64CatalogTransportWireAdapterV1,
} from './catalog-transport-wire-v1-internal.js';

/**
 * Additive RFC-64 protocol IDs. Their `/catalog/1` component is the wire
 * compatibility boundary; neither protocol is negotiated under a legacy sync ID.
 */
export const RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1 =
  '/dkg/catalog/1/author-head-availability' as const;
export const RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1 =
  '/dkg/catalog/1/control-object/author-head' as const;
export const RFC64_PUBLIC_CATALOG_HEAD_REPLAY_PROTOCOL_V1 =
  '/dkg/catalog/1/author-head-replay' as const;

export const RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1 =
  'rfc64-author-catalog-head-availability-v1' as const;
export const RFC64_PUBLIC_CATALOG_HEAD_FETCH_KIND_V1 =
  'rfc64-author-catalog-head-fetch-v1' as const;
export const RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1 =
  'rfc64-author-catalog-head-replay-v1' as const;

/** Flat JCS request caps; the fetched signed head has a separate response cap. */
export const RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_MAX_BYTES_V1 = 2 * 1024;
export const RFC64_PUBLIC_CATALOG_HEAD_FETCH_REQUEST_MAX_BYTES_V1 = 2 * 1024;
export const RFC64_PUBLIC_CATALOG_HEAD_FETCH_RESPONSE_MAX_BYTES_V1 = 32 * 1024;
export const RFC64_PUBLIC_CATALOG_HEAD_REPLAY_MAX_BYTES_V1 = 2 * 1024;

const ACK = Uint8Array.of(1);
const ANNOUNCEMENT_DENIED = 0;
const FETCH_NOT_FOUND = 0;
const FETCH_DENIED = 2;
const REPLAY_DENIED = 0;

const CATALOG_WIRE: Rfc64CatalogTransportWireAdapterV1 =
  createRfc64CatalogTransportWireAdapterV1({
    fail,
    wireCode: 'catalog-transport-wire',
    inputCode: 'catalog-transport-input',
    messages: {
      encodePlainObject: 'RFC-64 catalog message must be a plain object',
      encodeFieldShape: 'RFC-64 catalog messages accept only string or null fields',
      encodeOversized: (maxBytes) => `RFC-64 catalog message exceeds ${maxBytes} bytes`,
      parseOversized: 'RFC-64 catalog message is empty or oversized',
      parseStrictJson: 'RFC-64 catalog message is not strict UTF-8 JSON',
      parsePlainObject: 'RFC-64 catalog message must be a plain JSON object',
      parseExactKeys: 'RFC-64 catalog message has missing or unknown fields',
      parseNoncanonical: 'RFC-64 catalog message bytes are not canonical JCS',
      snapshot: 'RFC-64 catalog message has missing or unknown fields',
      evmAddress: (label) => `${label} must be a canonical lowercase nonzero EVM address`,
      peerIdType: 'remotePeerId must be a string',
      peerIdCanonical: 'remotePeerId is empty, oversized, or noncanonical',
    },
  });

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
const REPLAY_REQUEST_KEYS = Object.freeze([
  'contextGraphId',
  'kind',
  'networkId',
  'policyDigest',
] as const);

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

/** Scoped request for a provider to replay every current author-head hint. */
export interface Rfc64PublicCatalogHeadReplayRequestV1 {
  readonly kind: typeof RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1;
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly policyDigest: Digest32V1;
}

type Rfc64PublicCatalogPolicyScopeV1 =
  | Rfc64PublicCatalogHeadAnnouncementV1
  | Rfc64PublicCatalogHeadFetchRequestV1
  | Rfc64PublicCatalogHeadReplayRequestV1;

export type Rfc64PublicCatalogOperationV1 =
  | 'announce-outbound'
  | 'announce-inbound'
  | 'head-replay-outbound'
  | 'head-replay-inbound'
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
 * A caller-minted current-policy decision. The transport independently validates
 * the access-policy cell and exact digest match; the registry decides whether
 * the authenticated remote is authorized for an open or invite-only cell.
 */
export type Rfc64PublicCatalogAuthorizationV1 = Rfc64CatalogAccessAuthorizationV1;

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
  /** Preferred V2 contract: the accepted-current access-policy registry. */
  readonly authorizeCatalogOperation?: Rfc64CatalogAccessPolicyRegistryV1['authorize'];
  /** @deprecated Gate-1 compatibility until the service wiring migrates. */
  readonly authorizeOpenCatalogOperation?: (
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
  /** Called only after a scoped replay request passes current policy authorization. */
  readonly onCatalogHeadReplayRequested?: (
    request: Readonly<Rfc64PublicCatalogHeadReplayRequestV1>,
    remotePeerId: string,
  ) => void;
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
 * Small RFC-64 author-catalog transport slice.
 *
 * It deliberately does not select peers, activate catalog state, admit candidate
 * rows. Announcements are only untrusted hints;
 * every served and received head is fetched by both exact digests, structurally
 * bound to the hint, and reverified with the generic signature verifier.
 */
export class Rfc64PublicCatalogTransportV1 {
  #started = false;
  readonly #authorizeCatalogOperation: (
    input: Rfc64PublicCatalogAuthorizationInputV1,
  ) => Promise<Rfc64PublicCatalogAuthorizationV1 | null>;

  constructor(
    private readonly router: ProtocolRouter,
    private readonly options: Rfc64PublicCatalogTransportOptionsV1,
  ) {
    if (typeof options?.controlObjects?.getVerifiedObject !== 'function') {
      fail('catalog-transport-input', 'controlObjects.getVerifiedObject must be a function');
    }
    this.#authorizeCatalogOperation = normalizeRfc64CatalogTransportAuthorizerV1({
      current: options.authorizeCatalogOperation,
      legacyOpen: options.authorizeOpenCatalogOperation,
      invalidConfiguration: (message) => fail('catalog-transport-input', message),
    });
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
      this.router.register(
        RFC64_PUBLIC_CATALOG_HEAD_REPLAY_PROTOCOL_V1,
        async (data, peerId) => this.handleReplayRequest(data, peerId.toString()),
        { maxReadBytes: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_MAX_BYTES_V1 },
      );
    } catch (cause) {
      this.#started = false;
      this.router.unregister(RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1);
      this.router.unregister(RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1);
      this.router.unregister(RFC64_PUBLIC_CATALOG_HEAD_REPLAY_PROTOCOL_V1);
      throw cause;
    }
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.router.unregister(RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1);
    this.router.unregister(RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1);
    this.router.unregister(RFC64_PUBLIC_CATALOG_HEAD_REPLAY_PROTOCOL_V1);
  }

  /** Ask one already-connected, currently authorized peer to replay durable heads. */
  async requestCatalogHeadReplay(
    remotePeerId: string,
    requestInput: Rfc64PublicCatalogHeadReplayRequestV1,
    sendOptions?: SendOptions,
  ): Promise<void> {
    this.requireStarted();
    const peerId = snapshotPeerId(remotePeerId);
    const request = parseReplayRequest(encodeReplayRequest(requestInput));
    const response = await this.withCurrentCatalogPolicy(
      'head-replay-outbound',
      peerId,
      request,
      () => this.router.send(
        peerId,
        RFC64_PUBLIC_CATALOG_HEAD_REPLAY_PROTOCOL_V1,
        encodeReplayRequest(request),
        sendOptions,
      ),
    );
    if (response.byteLength === 1 && response[0] === REPLAY_DENIED) {
      fail('catalog-transport-policy-denied', 'remote peer denied the catalog-head replay request');
    }
    if (response.byteLength !== 1 || response[0] !== ACK[0]) {
      fail('catalog-transport-wire', 'catalog-head replay returned an invalid acknowledgement');
    }
  }

  async announceCatalogHead(
    remotePeerId: string,
    announcementInput: Rfc64PublicCatalogHeadAnnouncementV1,
    sendOptions?: SendOptions,
  ): Promise<void> {
    this.requireStarted();
    const peerId = snapshotPeerId(remotePeerId);
    const announcement = parseAnnouncement(encodeAnnouncement(announcementInput));
    const response = await this.withCurrentCatalogPolicy(
      'announce-outbound',
      peerId,
      announcement,
      () => this.router.send(
        peerId,
        RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1,
        encodeAnnouncement(announcement),
        sendOptions,
      ),
    );
    if (response.byteLength === 1 && response[0] === ANNOUNCEMENT_DENIED) {
      fail('catalog-transport-policy-denied', 'remote peer denied the catalog-head announcement');
    }
    if (response.byteLength !== 1 || response[0] !== ACK[0]) {
      fail('catalog-transport-wire', 'catalog-head announcement returned an invalid acknowledgement');
    }
  }

  async fetchCatalogHead(
    remotePeerId: string,
    announcementInput: Rfc64PublicCatalogHeadAnnouncementV1,
    sendOptions?: SendOptions,
  ): Promise<FetchedRfc64PublicCatalogHeadV1 | null> {
    this.requireStarted();
    const peerId = snapshotPeerId(remotePeerId);
    const announcement = parseAnnouncement(encodeAnnouncement(announcementInput));
    const request = requestFromAnnouncement(announcement);
    const response = await this.withCurrentCatalogPolicy(
      'fetch-outbound',
      peerId,
      announcement,
      () => this.router.send(
        peerId,
        RFC64_PUBLIC_CATALOG_HEAD_FETCH_PROTOCOL_V1,
        encodeFetchRequest(request),
        sendOptions,
      ),
    );
    const envelope = parseFetchResponse(response);
    if (envelope === null) return null;
    assertHeadMatchesAnnouncement(envelope, announcement);
    const issuerSignature = await recheckCurrentRfc64CatalogPolicyAfterAwaitV1(
      () => this.requireCatalogPolicy('fetch-outbound', peerId, announcement),
      () => this.verifyExactIssuerSignature(envelope),
    );
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
    const admitted = await this.withAuthorizedCurrentCatalogPolicy(
      'announce-inbound',
      remotePeerId,
      announcement,
      () => this.options.onCatalogHeadAvailable(announcement, remotePeerId),
    );
    if (!admitted.authorized) {
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
    const served = await this.withAuthorizedCurrentCatalogPolicy(
      'fetch-inbound',
      remotePeerId,
      request,
      async () => {
        const stored = await this.options.controlObjects.getVerifiedObject({
          objectDigest: request.catalogHeadObjectDigest,
          signatureVariantDigest: request.signatureVariantDigest,
          verifyIssuerSignature: this.options.verifyIssuerSignature,
        });
        if (stored === null) return null;
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
        try {
          return encodeRfc64FoundStatusResponseV1(
            envelopeBytes,
            RFC64_PUBLIC_CATALOG_HEAD_FETCH_RESPONSE_MAX_BYTES_V1,
          );
        } catch (cause) {
          fail('catalog-transport-wire', 'author-catalog head exceeds the v1 fetch response cap');
        }
      },
    );
    if (!served.authorized) {
      return Uint8Array.of(FETCH_DENIED);
    }
    return served.value ?? Uint8Array.of(FETCH_NOT_FOUND);
  }

  private async handleReplayRequest(
    data: Uint8Array,
    remotePeerIdInput: string,
  ): Promise<Uint8Array> {
    this.requireStarted();
    const remotePeerId = snapshotPeerId(remotePeerIdInput);
    const request = parseReplayRequest(data);
    const admitted = await this.withAuthorizedCurrentCatalogPolicy(
      'head-replay-inbound',
      remotePeerId,
      request,
      () => this.options.onCatalogHeadReplayRequested?.(request, remotePeerId),
    );
    return admitted.authorized ? ACK : Uint8Array.of(REPLAY_DENIED);
  }

  private async withAuthorizedCurrentCatalogPolicy<Value>(
    operation: Rfc64PublicCatalogOperationV1,
    remotePeerId: string,
    scope: Rfc64PublicCatalogPolicyScopeV1,
    work: () => Value | Promise<Value>,
  ): Promise<Rfc64AuthorizedCatalogWorkResultV1<Value>> {
    return withAuthorizedCurrentRfc64CatalogPolicyV1(
      () => this.isCatalogPolicyAuthorized(operation, remotePeerId, scope),
      work,
    );
  }

  private async isCatalogPolicyAuthorized(
    operation: Rfc64PublicCatalogOperationV1,
    remotePeerId: string,
    scope: Rfc64PublicCatalogPolicyScopeV1,
  ): Promise<boolean> {
    try {
      await this.requireCatalogPolicy(operation, remotePeerId, scope);
      return true;
    } catch (cause) {
      if (
        cause instanceof Rfc64PublicCatalogTransportErrorV1
        && cause.code === 'catalog-transport-policy-denied'
      ) return false;
      throw cause;
    }
  }

  private withCurrentCatalogPolicy<Value>(
    operation: Rfc64PublicCatalogOperationV1,
    remotePeerId: string,
    scope: Rfc64PublicCatalogPolicyScopeV1,
    work: () => Value | Promise<Value>,
  ): Promise<Value> {
    return withCurrentRfc64CatalogPolicyV1(
      () => this.requireCatalogPolicy(operation, remotePeerId, scope),
      work,
    );
  }

  private async requireCatalogPolicy(
    operation: Rfc64PublicCatalogOperationV1,
    remotePeerId: string,
    scope: Rfc64PublicCatalogPolicyScopeV1,
  ): Promise<void> {
    const input = Object.freeze({
      operation,
      remotePeerId,
      networkId: scope.networkId,
      contextGraphId: scope.contextGraphId,
      subGraphName: 'subGraphName' in scope ? scope.subGraphName : null,
      policyDigest: scope.policyDigest,
      objectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    }) satisfies Rfc64PublicCatalogAuthorizationInputV1;
    let authorization: Rfc64PublicCatalogAuthorizationV1 | null;
    try {
      authorization = await this.#authorizeCatalogOperation(input);
    } catch (cause) {
      fail('catalog-transport-policy-denied', 'catalog access-policy authorization failed', cause);
    }
    if (
      authorization === null
      || (authorization.accessPolicy !== 0 && authorization.accessPolicy !== 1)
    ) {
      fail('catalog-transport-policy-denied', 'catalog operation is not access-policy authorized');
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

export function encodeRfc64PublicCatalogHeadReplayRequestV1(
  input: Rfc64PublicCatalogHeadReplayRequestV1,
): Uint8Array {
  return encodeReplayRequest(input);
}

export function parseRfc64PublicCatalogHeadReplayRequestV1(
  input: Uint8Array,
): Rfc64PublicCatalogHeadReplayRequestV1 {
  return parseReplayRequest(input);
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

function encodeReplayRequest(
  input: Rfc64PublicCatalogHeadReplayRequestV1,
): Uint8Array {
  const snapshot = validateReplayRequest(input);
  return encodeFlatCanonicalJson(snapshot, RFC64_PUBLIC_CATALOG_HEAD_REPLAY_MAX_BYTES_V1);
}

function parseReplayRequest(input: Uint8Array): Rfc64PublicCatalogHeadReplayRequestV1 {
  return validateReplayRequest(parseFlatCanonicalJson(
    input,
    REPLAY_REQUEST_KEYS,
    RFC64_PUBLIC_CATALOG_HEAD_REPLAY_MAX_BYTES_V1,
  ));
}

function validateReplayRequest(value: unknown): Rfc64PublicCatalogHeadReplayRequestV1 {
  if (!isPlainRecord(value)) {
    fail('catalog-transport-wire', 'RFC-64 catalog replay request must be a plain object');
  }
  const snapshot = snapshotExactWireRecord(value, REPLAY_REQUEST_KEYS);
  if (snapshot.kind !== RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1) {
    fail(
      'catalog-transport-wire',
      `RFC-64 catalog replay request kind must be ${RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1}`,
    );
  }
  try {
    assertNetworkIdV1(snapshot.networkId);
    assertContextGraphIdV1(snapshot.contextGraphId);
    assertCanonicalDigest(snapshot.policyDigest, 'policyDigest');
    return Object.freeze({
      kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_KIND_V1,
      networkId: snapshot.networkId,
      contextGraphId: snapshot.contextGraphId,
      policyDigest: snapshot.policyDigest,
    });
  } catch (cause) {
    if (cause instanceof Rfc64PublicCatalogTransportErrorV1) throw cause;
    fail('catalog-transport-wire', 'RFC-64 catalog replay request contains an invalid scalar', cause);
  }
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
  const snapshot = snapshotExactWireRecord(
    value,
    expectedKind === RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1
    ? ANNOUNCEMENT_KEYS
    : FETCH_REQUEST_KEYS,
  );
  if (snapshot.kind !== expectedKind) {
    fail('catalog-transport-wire', `RFC-64 catalog message kind must be ${expectedKind}`);
  }
  try {
    assertNetworkIdV1(snapshot.networkId);
    assertContextGraphIdV1(snapshot.contextGraphId);
    if (snapshot.subGraphName !== null) assertSubGraphNameV1(snapshot.subGraphName);
    assertCanonicalEvmAddressV1(snapshot.authorAddress, 'authorAddress');
    assertCanonicalDecimalU64(snapshot.catalogEra, 'catalogEra');
    assertCanonicalDecimalU64(snapshot.catalogVersion, 'catalogVersion');
    assertCanonicalDigest(snapshot.policyDigest, 'policyDigest');
    assertCanonicalDigest(snapshot.catalogHeadObjectDigest, 'catalogHeadObjectDigest');
    assertCanonicalDigest(snapshot.signatureVariantDigest, 'signatureVariantDigest');
    return Object.freeze({
      authorAddress: snapshot.authorAddress,
      catalogEra: snapshot.catalogEra,
      catalogHeadObjectDigest: snapshot.catalogHeadObjectDigest,
      catalogVersion: snapshot.catalogVersion,
      contextGraphId: snapshot.contextGraphId,
      kind: expectedKind,
      networkId: snapshot.networkId,
      policyDigest: snapshot.policyDigest,
      signatureVariantDigest: snapshot.signatureVariantDigest,
      subGraphName: snapshot.subGraphName,
    }) as never;
  } catch (cause) {
    if (cause instanceof Rfc64PublicCatalogTransportErrorV1) throw cause;
    fail('catalog-transport-wire', 'RFC-64 catalog message contains an invalid scalar', cause);
  }
}

function parseFetchResponse(input: Uint8Array): SignedAuthorCatalogHeadEnvelopeV1 | null {
  let framed;
  try {
    framed = parseRfc64StatusResponsePayloadV1(
      input,
      RFC64_PUBLIC_CATALOG_HEAD_FETCH_RESPONSE_MAX_BYTES_V1,
    );
  } catch (cause) {
    rethrowRfc64CatalogTransportWireUtilityErrorV1(cause, fail, {
      'response-trailing': {
        code: 'catalog-transport-wire',
        message: input[0] === FETCH_NOT_FOUND
          ? 'not-found author-catalog response has trailing bytes'
          : 'denied author-catalog response has trailing bytes',
      },
      'response-status': {
        code: 'catalog-transport-wire',
        message: 'author-catalog head response has an invalid status',
      },
    }, {
      code: 'catalog-transport-wire',
      message: 'author-catalog head response is empty or oversized',
    });
  }
  if (framed.status === 'not-found') return null;
  if (framed.status === 'denied') {
    fail('catalog-transport-policy-denied', 'remote peer denied the author-catalog fetch');
  }
  try {
    return parseCanonicalSignedAuthorCatalogHeadEnvelopeV1(framed.payload, {
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
  try {
    assertRfc64ExactIssuerSignatureProofV1(envelope, proof);
  } catch (cause) {
    rethrowRfc64CatalogTransportWireUtilityErrorV1(cause, fail, {
      'issuer-proof-unminted': {
        code: 'catalog-transport-signature',
        message: 'issuer signature proof was not minted by the verifier',
      },
    }, {
      code: 'catalog-transport-signature',
      message: 'issuer signature proof is not bound to the exact envelope',
    });
  }
}

function encodeFlatCanonicalJson(
  value: object,
  maxBytes: number,
): Uint8Array {
  return CATALOG_WIRE.encodeFlatCanonicalJson(value, maxBytes);
}

function parseFlatCanonicalJson(
  input: Uint8Array,
  expectedKeys: readonly string[],
  maxBytes: number,
): Record<string, unknown> {
  return CATALOG_WIRE.parseFlatCanonicalJson(input, expectedKeys, maxBytes);
}

function snapshotExactWireRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  return CATALOG_WIRE.snapshotExactWireRecord(value, expectedKeys);
}

function assertCanonicalEvmAddressV1(value: unknown, label: string): asserts value is EvmAddressV1 {
  CATALOG_WIRE.assertCanonicalEvmAddress(value, label);
}

function snapshotPeerId(value: unknown): string {
  return CATALOG_WIRE.snapshotPeerId(value);
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
