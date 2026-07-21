import { decodeCanonicalCbor, encodeCanonicalCbor } from '../protocol/canonical-cbor.js';
import { decodeProtocolTuple, validateProtocolTuple } from '../protocol/codec.js';
import { protocolTupleId } from '../protocol/hashes.js';
import type { ProtocolTuple } from '../protocol/schema.js';
import { verifyThresholdSignedProtocolTuple } from '../protocol/signatures.js';
import { providerError, WalProviderDiscoveryError } from './errors.js';
import type {
  VerifiedProviderManifest,
  WalPrivateBootstrapSource,
  WalProviderBootstrapResponse,
  WalProviderBootstrapResult,
  WalProviderCandidate,
  WalProviderDiscoveryOptions,
  WalProviderPath,
  WalProviderPathKind,
  WalProviderRequestOptions,
  WalPublicBootstrapSource,
} from './types.js';

const NETWORK_AUTHORITY_SCOPE = 1n;
const DEFAULT_CLOCK_SKEW_MS = 5_000;
const DEFAULT_MAXIMUM_BOOTSTRAP_SOURCES = 8;
const DEFAULT_MAXIMUM_RESOLUTION_FANOUT = 3;
const DEFAULT_MAXIMUM_CANDIDATES = 64;
const DEFAULT_MAXIMUM_SELECTED_PROVIDERS = 16;
const DEFAULT_MAXIMUM_PATHS_PER_PROVIDER = 32;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAXIMUM_BACKOFF_MS = 5 * 60_000;
const MAXIMUM_ENDPOINTS_PER_PROVIDER = 32;
const MAXIMUM_ENDPOINT_UTF8_BYTES = 2_048;
const MAXIMUM_PEER_ID_BYTES = 128;

function copy(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const comparedLength = Math.min(left.length, right.length);
  for (let index = 0; index < comparedLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function hexadecimal(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
}

function fixed(value: Uint8Array, length: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    providerError('WAL_PROVIDER_INVALID_CONFIGURATION', `${name} must be exactly ${length} bytes`);
  }
  return copy(value);
}

function positiveSafeInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    providerError('WAL_PROVIDER_INVALID_CONFIGURATION', `${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function safeTime(value: bigint, name: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    providerError('WAL_PROVIDER_INVALID_MANIFEST', `${name} is outside the safe millisecond range`);
  }
  return Number(value);
}

function includesBytes(values: readonly Uint8Array[], expected: Uint8Array): boolean {
  return values.some(value => equalBytes(value, expected));
}

function validWindow(
  notBefore: bigint,
  expiresAt: bigint,
  nowMs: number,
  clockSkewMs: number,
  label: string,
): void {
  const start = safeTime(notBefore, `${label} notBeforeMs`);
  const end = safeTime(expiresAt, `${label} expiresAtMs`);
  if (end <= start) providerError('WAL_PROVIDER_INVALID_MANIFEST', `${label} validity interval is empty`);
  if (nowMs + clockSkewMs < start || nowMs > end + clockSkewMs) {
    providerError('WAL_PROVIDER_INVALID_MANIFEST', `${label} is not currently valid`);
  }
}

export function verifyProviderBootstrapManifest(
  canonicalBytes: Uint8Array,
  input: {
    networkId: string;
    collectionId: Uint8Array;
    networkAuthority: ProtocolTuple<'AuthoritySetV1'>;
    nowMs: number;
    clockSkewMs?: number;
    maximumProviders?: number;
  },
): VerifiedProviderManifest {
  if (!(canonicalBytes instanceof Uint8Array) || canonicalBytes.length === 0) {
    providerError('WAL_PROVIDER_INVALID_MANIFEST', 'provider manifest bytes cannot be empty');
  }
  const collectionId = fixed(input.collectionId, 32, 'collectionId');
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    providerError('WAL_PROVIDER_INVALID_CONFIGURATION', 'current time must be a non-negative safe integer');
  }
  const clockSkewMs = input.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  if (!Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0) {
    providerError('WAL_PROVIDER_INVALID_CONFIGURATION', 'clockSkewMs must be a non-negative safe integer');
  }
  const maximumProviders = positiveSafeInteger(
    input.maximumProviders ?? DEFAULT_MAXIMUM_CANDIDATES,
    'maximumProviders',
    DEFAULT_MAXIMUM_CANDIDATES,
  );
  let tuple: ProtocolTuple<'ProviderBootstrapManifestV1'>;
  try {
    validateProtocolTuple('AuthoritySetV1', input.networkAuthority);
    tuple = decodeProtocolTuple('ProviderBootstrapManifestV1', canonicalBytes);
  } catch (error) {
    providerError('WAL_PROVIDER_INVALID_MANIFEST', 'provider manifest or authority is not canonical', undefined, error);
  }
  const authority = input.networkAuthority;
  if (authority[1] !== NETWORK_AUTHORITY_SCOPE || authority[2] !== input.networkId) {
    providerError('WAL_PROVIDER_INVALID_MANIFEST', 'provider manifest authority is not the expected network authority');
  }
  validWindow(authority[6], authority[7], input.nowMs, clockSkewMs, 'network authority');
  if (tuple[1] !== input.networkId || !equalBytes(tuple[2], collectionId)) {
    providerError('WAL_PROVIDER_INVALID_MANIFEST', 'provider manifest belongs to another network or collection');
  }
  if (tuple[3] !== authority[3]) {
    providerError('WAL_PROVIDER_INVALID_MANIFEST', 'provider manifest authority epoch is stale or from the future');
  }
  const authorityId = protocolTupleId('AuthoritySetV1', authority);
  if (!equalBytes(tuple[8], authorityId)) {
    providerError('WAL_PROVIDER_INVALID_MANIFEST', 'provider manifest references another authority set');
  }
  validWindow(tuple[5], tuple[6], input.nowMs, clockSkewMs, 'provider manifest');
  if (tuple[4].length === 0 || tuple[4].length > maximumProviders) {
    providerError('WAL_PROVIDER_INVALID_MANIFEST', 'provider manifest provider count is outside the configured bound');
  }
  const peers = new Set<string>();
  for (const provider of tuple[4]) {
    if (provider[0].length === 0 || provider[0].length > MAXIMUM_PEER_ID_BYTES) {
      providerError('WAL_PROVIDER_INVALID_MANIFEST', 'provider peer ID length is outside the protocol bound');
    }
    const peer = hexadecimal(provider[0]);
    if (peers.has(peer)) providerError('WAL_PROVIDER_INVALID_MANIFEST', 'provider manifest contains an ambiguous duplicate peer ID');
    peers.add(peer);
    if (provider[2].length > MAXIMUM_ENDPOINTS_PER_PROVIDER) {
      providerError('WAL_PROVIDER_INVALID_MANIFEST', 'provider endpoint count exceeds the protocol bound');
    }
    for (const endpoint of provider[2]) {
      if (new TextEncoder().encode(endpoint).length > MAXIMUM_ENDPOINT_UTF8_BYTES) {
        providerError('WAL_PROVIDER_INVALID_MANIFEST', 'provider endpoint exceeds the protocol byte bound');
      }
    }
  }
  try {
    verifyThresholdSignedProtocolTuple('ProviderBootstrapManifestV1', tuple, {
      signerAddresses: authority[5],
      threshold: authority[4],
    });
  } catch (error) {
    providerError('WAL_PROVIDER_UNAUTHORIZED', 'provider manifest does not satisfy the current network authority', undefined, error);
  }
  return { id: protocolTupleId('ProviderBootstrapManifestV1', tuple), tuple };
}

interface MutableProviderEntry {
  peerId: Uint8Array;
  agentAddress: Uint8Array;
  namespaceIds: Uint8Array[];
  endpoints: Set<string>;
}

function pathWeight(kind: WalProviderPathKind): number {
  switch (kind) {
    case 'live': return 50;
    case 'direct': return 40;
    case 'dht': return 30;
    case 'directory': return 20;
    case 'relay': return 10;
    case 'signed': return 5;
    case 'persisted': return 2;
  }
}

function deduplicatePaths(paths: readonly WalProviderPath[], maximum: number): WalProviderPath[] {
  const byAddress = new Map<string, WalProviderPath>();
  for (const path of paths) {
    if (typeof path.address !== 'string' || path.address.length === 0 || path.address.normalize('NFC') !== path.address) continue;
    const current = byAddress.get(path.address);
    if (current === undefined || pathWeight(path.kind) > pathWeight(current.kind)) byAddress.set(path.address, path);
  }
  return [...byAddress.values()]
    .sort((left, right) => pathWeight(right.kind) - pathWeight(left.kind) || left.address.localeCompare(right.address))
    .slice(0, maximum);
}

function encodeAvailabilityHint(paths: readonly WalProviderPath[], nowMs: number): Uint8Array {
  return encodeCanonicalCbor([1n, paths.map(path => path.address).sort(), BigInt(nowMs)]);
}

function decodeAvailabilityHint(value: Uint8Array | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  try {
    const decoded = decodeCanonicalCbor(value, {
      maxArrayLength: DEFAULT_MAXIMUM_PATHS_PER_PROVIDER,
      maxTextStringBytes: MAXIMUM_ENDPOINT_UTF8_BYTES,
      maxByteStringLength: 0,
      maxDepth: 3,
    });
    if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== 1n || !Array.isArray(decoded[1]) || typeof decoded[2] !== 'bigint') return [];
    const endpoints = decoded[1];
    if (!endpoints.every(endpoint => typeof endpoint === 'string')) return [];
    return [...new Set(endpoints as string[])].slice(0, DEFAULT_MAXIMUM_PATHS_PER_PROVIDER);
  } catch {
    return [];
  }
}

async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  operation: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next += 1;
      output[index] = await operation(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

export class WalProviderDiscovery {
  readonly networkId: string;
  readonly collectionId: Uint8Array;
  readonly namespaceIds: readonly Uint8Array[];
  readonly clockSkewMs: number;
  readonly maximumBootstrapSources: number;
  readonly maximumResolutionFanout: number;
  readonly maximumCandidates: number;
  readonly maximumSelectedProviders: number;
  readonly maximumPathsPerProvider: number;
  readonly baseBackoffMs: number;
  readonly maximumBackoffMs: number;
  private readonly now: () => number;

  constructor(private readonly options: WalProviderDiscoveryOptions) {
    if (!options || typeof options.networkId !== 'string' || options.networkId.length === 0 || options.networkId.normalize('NFC') !== options.networkId) {
      providerError('WAL_PROVIDER_INVALID_CONFIGURATION', 'networkId must be non-empty NFC text');
    }
    this.networkId = options.networkId;
    this.collectionId = fixed(options.collectionId, 32, 'collectionId');
    if (!Array.isArray(options.namespaceIds) || options.namespaceIds.length === 0) {
      providerError('WAL_PROVIDER_INVALID_CONFIGURATION', 'at least one namespaceId is required');
    }
    this.namespaceIds = options.namespaceIds.map((value, index) => fixed(value, 32, `namespaceIds[${index}]`));
    if (new Set(this.namespaceIds.map(hexadecimal)).size !== this.namespaceIds.length) {
      providerError('WAL_PROVIDER_INVALID_CONFIGURATION', 'namespaceIds must be unique');
    }
    if (!options.authority || !options.resolver || !options.state) {
      providerError('WAL_PROVIDER_INVALID_CONFIGURATION', 'authority, resolver, and durable provider state are required');
    }
    this.clockSkewMs = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
    if (!Number.isSafeInteger(this.clockSkewMs) || this.clockSkewMs < 0) {
      providerError('WAL_PROVIDER_INVALID_CONFIGURATION', 'clockSkewMs must be a non-negative safe integer');
    }
    this.maximumBootstrapSources = positiveSafeInteger(options.maximumBootstrapSources ?? DEFAULT_MAXIMUM_BOOTSTRAP_SOURCES, 'maximumBootstrapSources', DEFAULT_MAXIMUM_BOOTSTRAP_SOURCES);
    this.maximumResolutionFanout = positiveSafeInteger(options.maximumResolutionFanout ?? DEFAULT_MAXIMUM_RESOLUTION_FANOUT, 'maximumResolutionFanout', DEFAULT_MAXIMUM_RESOLUTION_FANOUT);
    this.maximumCandidates = positiveSafeInteger(options.maximumCandidates ?? DEFAULT_MAXIMUM_CANDIDATES, 'maximumCandidates', DEFAULT_MAXIMUM_CANDIDATES);
    this.maximumSelectedProviders = positiveSafeInteger(options.maximumSelectedProviders ?? DEFAULT_MAXIMUM_SELECTED_PROVIDERS, 'maximumSelectedProviders', DEFAULT_MAXIMUM_SELECTED_PROVIDERS);
    this.maximumPathsPerProvider = positiveSafeInteger(options.maximumPathsPerProvider ?? DEFAULT_MAXIMUM_PATHS_PER_PROVIDER, 'maximumPathsPerProvider', DEFAULT_MAXIMUM_PATHS_PER_PROVIDER);
    this.baseBackoffMs = positiveSafeInteger(options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS, 'baseBackoffMs', DEFAULT_MAXIMUM_BACKOFF_MS);
    this.maximumBackoffMs = positiveSafeInteger(options.maximumBackoffMs ?? DEFAULT_MAXIMUM_BACKOFF_MS, 'maximumBackoffMs', DEFAULT_MAXIMUM_BACKOFF_MS);
    if (this.maximumSelectedProviders > this.maximumCandidates || this.maximumBackoffMs < this.baseBackoffMs) {
      providerError('WAL_PROVIDER_INVALID_CONFIGURATION', 'selected-provider and backoff bounds are inconsistent');
    }
    this.now = options.now ?? Date.now;
  }

  async coldStartPublic(
    sources: readonly WalPublicBootstrapSource[],
    options: { signal?: AbortSignal } = {},
  ): Promise<WalProviderBootstrapResult> {
    this.assertBootstrapSources(sources);
    const responses = await mapConcurrent(
      sources.slice(0, this.maximumBootstrapSources),
      this.maximumResolutionFanout,
      async source => this.fetchPublic(source, options.signal),
    );
    const usable = await this.installAuthorityEvidence(responses);
    const authority = await this.options.authority.currentNetworkAuthority();
    if (authority === null) return this.result('unknown-freshness', [], 'no current network authority evidence');
    const manifests = this.verifyResponses(usable, authority);
    if (manifests.length === 0) return this.result('unknown-freshness', [], 'no current threshold-signed provider manifest');
    return this.resolveResult(manifests, authority, options.signal);
  }

  async coldStartPrivate(
    sources: readonly WalPrivateBootstrapSource[],
    input: {
      memberAgentAddress: Uint8Array;
      membershipCheckpointId: Uint8Array;
      signal?: AbortSignal;
    },
  ): Promise<WalProviderBootstrapResult> {
    this.assertBootstrapSources(sources);
    const memberAgentAddress = fixed(input.memberAgentAddress, 20, 'memberAgentAddress');
    const membershipCheckpointId = fixed(input.membershipCheckpointId, 32, 'membershipCheckpointId');
    if (!this.options.privateOpener) providerError('WAL_PROVIDER_INVALID_CONFIGURATION', 'private bootstrap opener is required');
    const privateOpener = this.options.privateOpener;
    const responses = await mapConcurrent(
      sources.slice(0, this.maximumBootstrapSources),
      this.maximumResolutionFanout,
      async source => this.fetchPrivate(source, memberAgentAddress, input.signal),
    );
    const usable = await this.installAuthorityEvidence(responses);
    const authority = await this.options.authority.currentNetworkAuthority();
    if (authority === null) return this.result('unknown-freshness', [], 'no current network authority evidence');
    const manifests: VerifiedProviderManifest[] = [];
    let sawTicket = false;
    for (const response of usable) {
      if (!response.privateTicketBytes) continue;
      sawTicket = true;
      try {
        const ticket = decodeProtocolTuple('PrivateBootstrapTicketV1', response.privateTicketBytes);
        if (
          !equalBytes(ticket[1], this.collectionId)
          || !equalBytes(ticket[2], memberAgentAddress)
          || !equalBytes(ticket[3], membershipCheckpointId)
        ) continue;
        validWindow(ticket[5], ticket[6], this.currentTime(), this.clockSkewMs, 'private bootstrap ticket');
        if (ticket[8].length === 0) continue;
        const opened = await privateOpener.open(ticket, {
          collectionId: copy(this.collectionId),
          memberAgentAddress: copy(memberAgentAddress),
          membershipCheckpointId: copy(membershipCheckpointId),
          nowMs: this.currentTime(),
        });
        if (opened === null) continue;
        const manifest = verifyProviderBootstrapManifest(opened, this.verifierInput(authority));
        if (!equalBytes(manifest.id, ticket[4])) continue;
        manifests.push(manifest);
      } catch {
        // Private failures deliberately collapse to one denial with no metadata.
      }
    }
    if (manifests.length === 0) {
      return this.result(sawTicket ? 'denied' : 'unknown-freshness', [], sawTicket ? 'private bootstrap denied' : 'no private bootstrap ticket');
    }
    return this.resolveResult(manifests, authority, input.signal);
  }

  async executeAtRequestBoundary<T>(
    providers: readonly WalProviderCandidate[],
    options: WalProviderRequestOptions<T>,
  ): Promise<{ value: T; provider: WalProviderCandidate }> {
    if (providers.length === 0) {
      providerError(
        'WAL_PROVIDER_UNAVAILABLE',
        'no authorized provider is available at this request boundary',
        options.targetFresh ? 'known-incomplete' : 'unknown-freshness',
      );
    }
    const maximumAttempts = positiveSafeInteger(
      options.maximumAttempts ?? Math.min(providers.length, this.maximumSelectedProviders),
      'maximumAttempts',
      this.maximumSelectedProviders,
    );
    let attempts = 0;
    for (const provider of [...providers].sort((left, right) => right.score - left.score || hexadecimal(left.peerId).localeCompare(hexadecimal(right.peerId)))) {
      if (attempts >= maximumAttempts) break;
      const state = this.options.state.getPeerState(provider.peerId);
      if (state !== null && state.backoffUntilMs > this.currentTime()) continue;
      attempts += 1;
      try {
        const value = await options.operation(provider);
        await options.verify(value, provider);
        this.recordSuccess(provider);
        return { value, provider };
      } catch (error) {
        this.recordFailure(provider.peerId, error);
      }
    }
    providerError(
      'WAL_PROVIDER_UNAVAILABLE',
      'all authorized providers are unavailable at this request boundary',
      options.targetFresh ? 'known-incomplete' : 'unknown-freshness',
    );
  }

  recordSuccess(provider: WalProviderCandidate): void {
    const current = this.options.state.getPeerState(provider.peerId);
    const nowMs = this.currentTime();
    this.options.state.putPeerState({
      peerId: copy(provider.peerId),
      successCount: Math.min(Number.MAX_SAFE_INTEGER, (current?.successCount ?? 0) + 1),
      failureCount: current?.failureCount ?? 0,
      backoffUntilMs: 0,
      availabilityHint: encodeAvailabilityHint(provider.paths, nowMs),
      updatedAtMs: nowMs,
    });
  }

  recordFailure(peerId: Uint8Array, error: unknown): number {
    const peer = peerId instanceof Uint8Array && peerId.length > 0
      ? copy(peerId)
      : providerError('WAL_PROVIDER_INVALID_CONFIGURATION', 'peerId cannot be empty');
    const current = this.options.state.getPeerState(peer);
    const failures = Math.min(Number.MAX_SAFE_INTEGER, (current?.failureCount ?? 0) + 1);
    const exponent = Math.min(16, failures - 1);
    const raw = Math.min(this.maximumBackoffMs, this.baseBackoffMs * (2 ** exponent));
    const jitterRange = Math.max(1, Math.floor(raw / 4));
    const jitter = peer.reduce((sum, byte) => (sum * 257 + byte) % jitterRange, 0);
    const nowMs = this.currentTime();
    const backoffUntilMs = Math.min(Number.MAX_SAFE_INTEGER, nowMs + raw + jitter);
    this.options.state.putPeerState({
      peerId: peer,
      successCount: current?.successCount ?? 0,
      failureCount: failures,
      backoffUntilMs,
      availabilityHint: current?.availabilityHint ?? null,
      updatedAtMs: nowMs,
    });
    this.options.state.enqueueRetry({
      key: `wal-provider:${hexadecimal(peer)}`,
      kind: 'WAL_PROVIDER_RETRY',
      payload: encodeCanonicalCbor([1n, peer]),
      priority: 0,
      maximumAttempts: 32,
      availableAtMs: backoffUntilMs,
    });
    void error;
    return backoffUntilMs;
  }

  private assertBootstrapSources(sources: readonly { id: string }[]): void {
    if (!Array.isArray(sources) || sources.length < 2) {
      providerError('WAL_PROVIDER_INVALID_CONFIGURATION', 'at least two bootstrap sources are required');
    }
    if (sources.some(source => !source || typeof source.id !== 'string' || source.id.length === 0)) {
      providerError('WAL_PROVIDER_INVALID_CONFIGURATION', 'bootstrap source IDs must be non-empty');
    }
    if (new Set(sources.map(source => source.id)).size !== sources.length) {
      providerError('WAL_PROVIDER_INVALID_CONFIGURATION', 'bootstrap source IDs must be unique');
    }
  }

  private async fetchPublic(source: WalPublicBootstrapSource, signal?: AbortSignal): Promise<WalProviderBootstrapResponse | null> {
    if (signal?.aborted) return null;
    try {
      return await source.fetchPublic(this.networkId, copy(this.collectionId), { signal });
    } catch {
      return null;
    }
  }

  private async fetchPrivate(source: WalPrivateBootstrapSource, member: Uint8Array, signal?: AbortSignal): Promise<WalProviderBootstrapResponse | null> {
    if (signal?.aborted) return null;
    try {
      return await source.fetchPrivate(copy(member), { signal });
    } catch {
      return null;
    }
  }

  private async installAuthorityEvidence(
    responses: readonly (WalProviderBootstrapResponse | null)[],
  ): Promise<WalProviderBootstrapResponse[]> {
    const usable: WalProviderBootstrapResponse[] = [];
    for (const response of responses) {
      if (response === null || !Array.isArray(response.authorityEvidence)) continue;
      let valid = true;
      for (const evidence of response.authorityEvidence) {
        try {
          await this.options.authority.acceptAuthorityEvidence(evidence);
        } catch {
          valid = false;
          break;
        }
      }
      if (valid) usable.push(response);
    }
    return usable;
  }

  private verifyResponses(
    responses: readonly WalProviderBootstrapResponse[],
    authority: ProtocolTuple<'AuthoritySetV1'>,
  ): VerifiedProviderManifest[] {
    const manifests: VerifiedProviderManifest[] = [];
    for (const response of responses) {
      if (!response.manifestBytes) continue;
      try {
        manifests.push(verifyProviderBootstrapManifest(response.manifestBytes, this.verifierInput(authority)));
      } catch {
        // One malformed or malicious bootstrap source cannot define the target.
      }
    }
    return manifests;
  }

  private verifierInput(authority: ProtocolTuple<'AuthoritySetV1'>) {
    return {
      networkId: this.networkId,
      collectionId: this.collectionId,
      networkAuthority: authority,
      nowMs: this.currentTime(),
      clockSkewMs: this.clockSkewMs,
      maximumProviders: this.maximumCandidates,
    };
  }

  private async resolveResult(
    manifests: readonly VerifiedProviderManifest[],
    authority: ProtocolTuple<'AuthoritySetV1'>,
    signal?: AbortSignal,
  ): Promise<WalProviderBootstrapResult> {
    const providers = await this.resolveProviders(manifests, signal);
    const ids = [...new Map(manifests.map(manifest => [hexadecimal(manifest.id), copy(manifest.id)])).values()];
    const authoritySetId = protocolTupleId('AuthoritySetV1', authority);
    return providers.length === 0
      ? this.result('known-incomplete', [], 'signed target is known but every authorized provider is unavailable', authoritySetId, ids)
      : this.result('provider-ready', providers, 'authorized providers resolved; completeness remains unproven', authoritySetId, ids);
  }

  private async resolveProviders(
    manifests: readonly VerifiedProviderManifest[],
    signal?: AbortSignal,
  ): Promise<WalProviderCandidate[]> {
    const entries = new Map<string, MutableProviderEntry>();
    const conflicted = new Set<string>();
    for (const manifest of manifests) {
      for (const provider of manifest.tuple[4]) {
        if (!provider[3].some(namespace => includesBytes(this.namespaceIds, namespace))) continue;
        const key = hexadecimal(provider[0]);
        if (conflicted.has(key)) continue;
        const existing = entries.get(key);
        if (existing && !equalBytes(existing.agentAddress, provider[1])) {
          entries.delete(key);
          conflicted.add(key);
          continue;
        }
        if (!existing) {
          entries.set(key, {
            peerId: copy(provider[0]),
            agentAddress: copy(provider[1]),
            namespaceIds: provider[3].map(copy),
            endpoints: new Set(provider[2]),
          });
        } else {
          for (const namespace of provider[3]) {
            if (!includesBytes(existing.namespaceIds, namespace)) existing.namespaceIds.push(copy(namespace));
          }
          for (const endpoint of provider[2]) existing.endpoints.add(endpoint);
        }
      }
    }
    const bounded = [...entries.values()]
      .sort((left, right) => hexadecimal(left.peerId).localeCompare(hexadecimal(right.peerId)))
      .slice(0, this.maximumCandidates);
    const candidates = await mapConcurrent<MutableProviderEntry, WalProviderCandidate | null>(bounded, this.maximumResolutionFanout, async entry => {
      const prior = this.options.state.getPeerState(entry.peerId);
      if (prior !== null && prior.backoffUntilMs > this.currentTime()) return null;
      const signedEndpoints = [...entry.endpoints].sort();
      const persistedEndpoints = decodeAvailabilityHint(prior?.availabilityHint);
      let dynamic: readonly WalProviderPath[] = [];
      try {
        dynamic = await this.options.resolver.resolve(entry.peerId, signedEndpoints, persistedEndpoints, { signal });
      } catch (error) {
        this.recordFailure(entry.peerId, error);
        return null;
      }
      // Signed and persisted endpoints are only untrusted resolution inputs.
      // The adapter must parse/validate them and return paths it can actually
      // use; discovery must never promote an unchecked string to dialability.
      const paths = deduplicatePaths(dynamic, this.maximumPathsPerProvider);
      if (paths.length === 0) {
        this.recordFailure(entry.peerId, new Error('provider has no dialable path'));
        return null;
      }
      const nowMs = this.currentTime();
      this.options.state.putPeerState({
        peerId: copy(entry.peerId),
        successCount: prior?.successCount ?? 0,
        failureCount: prior?.failureCount ?? 0,
        backoffUntilMs: prior?.backoffUntilMs ?? 0,
        availabilityHint: encodeAvailabilityHint(paths, nowMs),
        updatedAtMs: nowMs,
      });
      const rawScore = (prior?.successCount ?? 0) * 100
        - (prior?.failureCount ?? 0) * 25
        + Math.max(...paths.map(path => pathWeight(path.kind)));
      const score = Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, rawScore));
      return {
        peerId: copy(entry.peerId),
        agentAddress: copy(entry.agentAddress),
        namespaceIds: entry.namespaceIds.map(copy),
        paths,
        score,
      } satisfies WalProviderCandidate;
    });
    return candidates
      .filter((candidate): candidate is WalProviderCandidate => candidate !== null)
      .sort((left, right) => right.score - left.score || hexadecimal(left.peerId).localeCompare(hexadecimal(right.peerId)))
      .slice(0, this.maximumSelectedProviders);
  }

  private result(
    status: WalProviderBootstrapResult['status'],
    providers: readonly WalProviderCandidate[],
    reason: string,
    authoritySetId?: Uint8Array,
    manifestIds?: readonly Uint8Array[],
  ): WalProviderBootstrapResult {
    return Object.freeze({
      status,
      providers,
      reason,
      ...(authoritySetId ? { authoritySetId: copy(authoritySetId) } : {}),
      ...(manifestIds ? { manifestIds: manifestIds.map(copy) } : {}),
    });
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      providerError('WAL_PROVIDER_INVALID_CONFIGURATION', 'current time must be a non-negative safe integer');
    }
    return value;
  }
}

export function isWalProvidersUnavailable(error: unknown): error is WalProviderDiscoveryError {
  return error instanceof WalProviderDiscoveryError && error.code === 'WAL_PROVIDER_UNAVAILABLE';
}
