import type { PeerStateRecord } from '../control/types.js';
import type { ProtocolTuple } from '../protocol/schema.js';

export type WalProviderReadiness =
  | 'provider-ready'
  | 'known-incomplete'
  | 'unknown-freshness'
  | 'denied';

export type WalProviderPathKind =
  | 'live'
  | 'direct'
  | 'relay'
  | 'dht'
  | 'directory'
  | 'signed'
  | 'persisted';

export interface WalProviderPath {
  readonly address: string;
  readonly kind: WalProviderPathKind;
}

export interface WalProviderCandidate {
  readonly peerId: Uint8Array;
  readonly agentAddress: Uint8Array;
  readonly namespaceIds: readonly Uint8Array[];
  readonly paths: readonly WalProviderPath[];
  readonly score: number;
}

export interface WalProviderBootstrapResult {
  readonly status: WalProviderReadiness;
  readonly providers: readonly WalProviderCandidate[];
  readonly authoritySetId?: Uint8Array;
  readonly manifestIds?: readonly Uint8Array[];
  readonly reason: string;
}

export interface WalProviderBootstrapResponse {
  /** Oldest-to-newest authority rotation evidence, possibly empty. */
  readonly authorityEvidence: readonly Uint8Array[];
  /** Public manifest bytes. Private sources leave this absent. */
  readonly manifestBytes?: Uint8Array;
  /** Member-targeted private ticket bytes. Public sources leave this absent. */
  readonly privateTicketBytes?: Uint8Array;
}

export interface WalPublicBootstrapSource {
  readonly id: string;
  fetchPublic(
    networkId: string,
    collectionId: Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<WalProviderBootstrapResponse>;
}

export interface WalPrivateBootstrapSource {
  readonly id: string;
  /** The collection/view is deliberately not sent to discovery infrastructure. */
  fetchPrivate(
    memberAgentAddress: Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<WalProviderBootstrapResponse>;
}

export interface WalProviderAuthorityAdapter {
  acceptAuthorityEvidence(canonicalBytes: Uint8Array): void | Promise<void>;
  currentNetworkAuthority():
    | ProtocolTuple<'AuthoritySetV1'>
    | null
    | Promise<ProtocolTuple<'AuthoritySetV1'> | null>;
}

export interface WalPrivateBootstrapOpener {
  /**
   * Reuses current DKG membership and private crypto. It must authenticate the
   * exact outer ticket fields as associated data and returns canonical signed
   * ProviderBootstrapManifestV1 bytes only for a current authorized member.
   */
  open(
    ticket: ProtocolTuple<'PrivateBootstrapTicketV1'>,
    input: {
      collectionId: Uint8Array;
      memberAgentAddress: Uint8Array;
      membershipCheckpointId: Uint8Array;
      nowMs: number;
    },
  ): Uint8Array | null | Promise<Uint8Array | null>;
}

export interface WalProviderResolutionAdapter {
  resolve(
    peerId: Uint8Array,
    signedEndpoints: readonly string[],
    persistedEndpoints: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<readonly WalProviderPath[]>;
}

export interface WalProviderStateStore {
  getPeerState(peerId: Uint8Array): PeerStateRecord | null;
  putPeerState(input: PeerStateRecord): void;
  enqueueRetry(input: {
    key: string;
    kind: string;
    payload: Uint8Array;
    priority?: number;
    maximumAttempts?: number;
    availableAtMs?: number;
  }): void;
}

export interface WalProviderDiscoveryOptions {
  readonly networkId: string;
  readonly collectionId: Uint8Array;
  readonly namespaceIds: readonly Uint8Array[];
  readonly authority: WalProviderAuthorityAdapter;
  readonly resolver: WalProviderResolutionAdapter;
  readonly state: WalProviderStateStore;
  readonly privateOpener?: WalPrivateBootstrapOpener;
  readonly now?: () => number;
  readonly clockSkewMs?: number;
  readonly maximumBootstrapSources?: number;
  readonly maximumResolutionFanout?: number;
  readonly maximumCandidates?: number;
  readonly maximumSelectedProviders?: number;
  readonly maximumPathsPerProvider?: number;
  readonly baseBackoffMs?: number;
  readonly maximumBackoffMs?: number;
}

export interface VerifiedProviderManifest {
  readonly id: Uint8Array;
  readonly tuple: ProtocolTuple<'ProviderBootstrapManifestV1'>;
}

export interface WalProviderRequestOptions<T> {
  readonly operation: (provider: WalProviderCandidate) => Promise<T>;
  readonly verify: (value: T, provider: WalProviderCandidate) => void | Promise<void>;
  readonly maximumAttempts?: number;
  /** Whether a signed current target is known despite provider unavailability. */
  readonly targetFresh: boolean;
}
