import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WalAuthorityLifecycle } from '../../src/authority/index.js';
import { WalControlStore } from '../../src/control/index.js';
import {
  isWalProvidersUnavailable,
  verifyProviderBootstrapManifest,
  WalProviderDiscovery,
  WalProviderDiscoveryError,
  type WalPrivateBootstrapSource,
  type WalProviderBootstrapResponse,
  type WalProviderCandidate,
  type WalProviderPath,
  type WalProviderDiscoveryOptions,
  type WalProviderStateStore,
  type WalPublicBootstrapSource,
} from '../../src/discovery/index.js';
import { encodeCanonicalCbor } from '../../src/protocol/canonical-cbor.js';
import { decodeProtocolTuple, encodeProtocolTuple } from '../../src/protocol/codec.js';
import { protocolTupleId } from '../../src/protocol/hashes.js';
import type { CborProtocolValue, ProtocolTuple } from '../../src/protocol/schema.js';
import { createWalObjectV1 } from '../../src/protocol/wal-object.js';
import {
  recoverEip191Address,
  signEip191DigestWithPrivateKey,
  signThresholdProtocolTuple,
  type WalEip191Signer,
} from '../../src/protocol/signatures.js';
import {
  createFallbackPages,
  hashBytes,
  PAPER_BASELINE_V0,
  RatelessIbltDecoder,
  RatelessIbltEncoder,
  reconciliationHeadId,
  verifyDecodedDifference,
  verifyFallbackPages,
  walObjectId,
  type ReconciliationSymbolV1,
} from '../../src/reconciliation/index.js';
import { PackedWalObjectStore } from '../../src/store/packed-store.js';
import { FileWalObjectRangeReceiver } from '../../src/store/range-receiver.js';
import { deterministicHead, deterministicSeed } from '../support/fixtures.js';

const NOW = 5_000;
const roots: string[] = [];
const controls: WalControlStore[] = [];
const stores: PackedWalObjectStore[] = [];
const lifecycles: WalAuthorityLifecycle[] = [];

afterEach(async () => {
  for (const lifecycle of lifecycles.splice(0)) lifecycle.close();
  for (const control of controls.splice(0)) control.close();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function bytes(label: string): Uint8Array {
  return hashBytes(new TextEncoder().encode(`wal-provider-test-v1\0${label}`));
}

function key(value: number): Uint8Array {
  const output = new Uint8Array(32);
  output[31] = value;
  return output;
}

function signer(privateKey: Uint8Array): WalEip191Signer & { address: Uint8Array } {
  const digest = new Uint8Array(32);
  const address = recoverEip191Address(digest, signEip191DigestWithPrivateKey(digest, privateKey));
  return { address, signMessage: value => signEip191DigestWithPrivateKey(value, privateKey) };
}

const networkSigner = signer(key(41));
const otherSigner = signer(key(42));
const providerAgent = signer(key(43));
const member = signer(key(44));
const collectionId = bytes('collection');
const namespaceId = bytes('namespace');
const peerA = Uint8Array.of(0, 1, 2, 3);
const peerB = Uint8Array.of(0, 1, 2, 4);

async function authority(options: {
  signer?: typeof networkSigner;
  scope?: 0n | 1n;
  networkId?: string;
  epoch?: bigint;
  notBefore?: bigint;
  expiresAt?: bigint;
} = {}): Promise<{ tuple: ProtocolTuple<'AuthoritySetV1'>; bytes: Uint8Array; id: Uint8Array }> {
  const signing = options.signer ?? networkSigner;
  const unsigned = [
    1n,
    options.scope ?? 1n,
    options.networkId ?? 'testnet',
    options.epoch ?? 1n,
    1n,
    [signing.address],
    options.notBefore ?? 0n,
    options.expiresAt ?? 10_000n,
    null,
    [],
  ] satisfies readonly CborProtocolValue[];
  const tuple = await signThresholdProtocolTuple('AuthoritySetV1', unsigned, [signing]);
  return { tuple, bytes: encodeProtocolTuple('AuthoritySetV1', tuple), id: protocolTupleId('AuthoritySetV1', tuple) };
}

interface ProviderInput {
  peerId?: Uint8Array;
  agentAddress?: Uint8Array;
  endpoints?: readonly string[];
  namespaces?: readonly Uint8Array[];
}

async function manifest(
  authorityValue: Awaited<ReturnType<typeof authority>>,
  providers: readonly ProviderInput[] = [{}],
  options: {
    signer?: typeof networkSigner;
    networkId?: string;
    collection?: Uint8Array;
    epoch?: bigint;
    notBefore?: bigint;
    expiresAt?: bigint;
    authorityId?: Uint8Array;
  } = {},
): Promise<{ tuple: ProtocolTuple<'ProviderBootstrapManifestV1'>; bytes: Uint8Array; id: Uint8Array }> {
  const entries = providers.map((provider, index) => [
    provider.peerId ?? (index === 0 ? peerA : Uint8Array.of(0, 1, 2, 3 + index)),
    provider.agentAddress ?? providerAgent.address,
    [...(provider.endpoints ?? [`/ip4/127.0.0.1/tcp/${4_001 + index}`])].sort(),
    [...(provider.namespaces ?? [namespaceId])].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
  ] as const).sort((left, right) => Buffer.compare(Buffer.from(encodeProtocolTuple('ProviderEntryV1', left)), Buffer.from(encodeProtocolTuple('ProviderEntryV1', right))));
  const unsigned = [
    1n,
    options.networkId ?? 'testnet',
    options.collection ?? collectionId,
    options.epoch ?? authorityValue.tuple[3],
    entries,
    options.notBefore ?? 1_000n,
    options.expiresAt ?? 9_000n,
    null,
    options.authorityId ?? authorityValue.id,
  ] satisfies readonly CborProtocolValue[];
  const tuple = await signThresholdProtocolTuple('ProviderBootstrapManifestV1', unsigned, [options.signer ?? networkSigner]);
  return { tuple, bytes: encodeProtocolTuple('ProviderBootstrapManifestV1', tuple), id: protocolTupleId('ProviderBootstrapManifestV1', tuple) };
}

function ticket(manifestId: Uint8Array, options: {
  collection?: Uint8Array;
  agent?: Uint8Array;
  membership?: Uint8Array;
  notBefore?: bigint;
  expiresAt?: bigint;
  ciphertext?: Uint8Array;
} = {}): { tuple: ProtocolTuple<'PrivateBootstrapTicketV1'>; bytes: Uint8Array; membership: Uint8Array } {
  const membership = options.membership ?? bytes('membership');
  const tuple = [
    1n,
    options.collection ?? collectionId,
    options.agent ?? member.address,
    membership,
    manifestId,
    options.notBefore ?? 1_000n,
    options.expiresAt ?? 9_000n,
    Uint8Array.from({ length: 12 }, (_, index) => index),
    options.ciphertext ?? Uint8Array.of(7),
  ] as ProtocolTuple<'PrivateBootstrapTicketV1'>;
  return { tuple, bytes: encodeProtocolTuple('PrivateBootstrapTicketV1', tuple), membership };
}

class MemoryState implements WalProviderStateStore {
  readonly peers = new Map<string, ReturnType<WalProviderStateStore['getPeerState']>>();
  readonly retries: Array<Parameters<WalProviderStateStore['enqueueRetry']>[0]> = [];

  getPeerState(peerId: Uint8Array) {
    return this.peers.get(Buffer.from(peerId).toString('hex')) ?? null;
  }

  putPeerState(input: NonNullable<ReturnType<WalProviderStateStore['getPeerState']>>): void {
    this.peers.set(Buffer.from(input.peerId).toString('hex'), {
      ...input,
      peerId: new Uint8Array(input.peerId),
      availabilityHint: input.availabilityHint == null ? null : new Uint8Array(input.availabilityHint),
    });
  }

  enqueueRetry(input: Parameters<WalProviderStateStore['enqueueRetry']>[0]): void {
    if (!this.retries.some(value => value.key === input.key)) this.retries.push(input);
  }
}

function publicSource(id: string, response: WalProviderBootstrapResponse | Error, calls: unknown[] = []): WalPublicBootstrapSource {
  return {
    id,
    async fetchPublic(networkId, collection, options) {
      calls.push({ networkId, collection: new Uint8Array(collection), signal: options?.signal });
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function privateSource(id: string, response: WalProviderBootstrapResponse | Error, calls: unknown[] = []): WalPrivateBootstrapSource {
  return {
    id,
    async fetchPrivate(agent, options) {
      calls.push({ agent: new Uint8Array(agent), signal: options?.signal });
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function discovery(input: {
  current?: ProtocolTuple<'AuthoritySetV1'> | null;
  resolver?: (peer: Uint8Array, signed: readonly string[], persisted: readonly string[], options?: { signal?: AbortSignal }) => Promise<readonly WalProviderPath[]>;
  state?: WalProviderStateStore;
  privateOpen?: (ticketValue: ProtocolTuple<'PrivateBootstrapTicketV1'>) => Uint8Array | null | Promise<Uint8Array | null>;
  accept?: (value: Uint8Array) => void | Promise<void>;
  now?: () => number;
  limits?: Partial<ConstructorParameters<typeof WalProviderDiscovery>[0]>;
} = {}): { value: WalProviderDiscovery; state: WalProviderStateStore; current: { value: ProtocolTuple<'AuthoritySetV1'> | null } } {
  const current = { value: input.current ?? null };
  const state = input.state ?? new MemoryState();
  const value = new WalProviderDiscovery({
    networkId: 'testnet',
    collectionId,
    namespaceIds: [namespaceId],
    authority: {
      acceptAuthorityEvidence: input.accept ?? (canonical => { current.value = decodeProtocolTuple('AuthoritySetV1', canonical); }),
      currentNetworkAuthority: () => current.value,
    },
    resolver: {
      resolve: input.resolver ?? (async (_peer, signed) => signed.map(address => ({ address, kind: 'direct' as const }))),
    },
    state,
    privateOpener: input.privateOpen ? { open: input.privateOpen } : undefined,
    now: input.now ?? (() => NOW),
    ...input.limits,
  });
  return { value, state, current };
}

function baseOptions(overrides: Partial<WalProviderDiscoveryOptions> = {}): WalProviderDiscoveryOptions {
  return {
    networkId: 'testnet',
    collectionId,
    namespaceIds: [namespaceId],
    authority: { acceptAuthorityEvidence: () => undefined, currentNetworkAuthority: () => null },
    resolver: { resolve: async () => [] },
    state: new MemoryState(),
    now: () => NOW,
    ...overrides,
  };
}

function expectProviderError(operation: () => unknown, code: WalProviderDiscoveryError['code']): void {
  try {
    const result = operation();
    if (result instanceof Promise) throw new Error('use rejects for asynchronous errors');
  } catch (error) {
    expect(error).toBeInstanceOf(WalProviderDiscoveryError);
    expect((error as WalProviderDiscoveryError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    length += chunk.length;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

describe('WAL provider discovery', () => {
  it('cold-starts through the real authority lifecycle without a second trust model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dkg-wal-provider-authority-lifecycle-'));
    roots.push(root);
    const store = new PackedWalObjectStore({ root });
    stores.push(store);
    const control = new WalControlStore({ root, now: () => NOW });
    controls.push(control);
    const a = await authority({ epoch: 0n });
    const lifecycle = new WalAuthorityLifecycle({
      networkId: 'testnet',
      genesisCuratorAuthoritySetId: bytes('unused-curator-anchor'),
      genesisNetworkAuthoritySetId: a.id,
      root,
      rollbackStore: control,
      adapter: {
        validateMembership: () => false,
        validateOpenAuthor: () => false,
        validateEpochSnapshot: () => false,
        authorizePrivateDisclosure: () => false,
        isWalObjectAdmitted: () => false,
      },
      now: () => NOW,
    });
    lifecycles.push(lifecycle);
    const m = await manifest(a, [{ peerId: peerA, endpoints: ['dialable'] }]);
    const value = new WalProviderDiscovery({
      networkId: 'testnet', collectionId, namespaceIds: [namespaceId],
      authority: lifecycle,
      resolver: { resolve: async () => [{ address: 'dialable', kind: 'direct' }] },
      state: control,
      now: () => NOW,
    });
    const result = await value.coldStartPublic([
      publicSource('bootstrap-a', { authorityEvidence: [a.bytes], manifestBytes: m.bytes }),
      publicSource('bootstrap-b', { authorityEvidence: [a.bytes], manifestBytes: m.bytes }),
    ]);
    expect(result.status).toBe('provider-ready');
    expect(result.authoritySetId).toEqual(a.id);
    expect(result.providers).toHaveLength(1);
    expect(lifecycle.currentNetworkAuthority()).toEqual(a.tuple);
  });

  it('cold-starts an empty public node from threshold authority and a resolved provider', async () => {
    const a = await authority();
    const m = await manifest(a);
    const calls: unknown[] = [];
    const resolved: unknown[] = [];
    const { value } = discovery({
      resolver: async (peer, signed, persisted, options) => {
        resolved.push({ peer, signed, persisted, signal: options?.signal });
        return [{ address: signed[0], kind: 'direct' }, { address: signed[0], kind: 'persisted' }];
      },
    });
    const result = await value.coldStartPublic([
      publicSource('broken', new Error('offline'), calls),
      publicSource('curator', { authorityEvidence: [a.bytes], manifestBytes: m.bytes }, calls),
    ]);

    expect(result.status).toBe('provider-ready');
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].peerId).toEqual(peerA);
    expect(result.providers[0].paths).toEqual([{ address: '/ip4/127.0.0.1/tcp/4001', kind: 'direct' }]);
    expect(result.authoritySetId).toEqual(a.id);
    expect(result.manifestIds).toEqual([m.id]);
    expect(calls).toHaveLength(2);
    expect(resolved).toHaveLength(1);
  });

  it('ignores malicious and stale sources without changing the signed target', async () => {
    const a = await authority();
    const valid = await manifest(a);
    const wrongSigner = await manifest(a, [{}], { signer: otherSigner });
    const stale = await manifest(a, [{}], { expiresAt: 2_000n });
    const { value } = discovery({ current: a.tuple, limits: { clockSkewMs: 0 } });
    const result = await value.coldStartPublic([
      publicSource('malicious', { authorityEvidence: [], manifestBytes: wrongSigner.bytes }),
      publicSource('stale', { authorityEvidence: [], manifestBytes: stale.bytes }),
      publicSource('valid', { authorityEvidence: [], manifestBytes: valid.bytes }),
    ]);
    expect(result.status).toBe('provider-ready');
    expect(result.manifestIds).toEqual([valid.id]);
  });

  it('reports unknown freshness without authority or a valid manifest and never complete', async () => {
    const a = await authority();
    const noAuthority = discovery({ accept: () => undefined });
    expect((await noAuthority.value.coldStartPublic([
      publicSource('one', { authorityEvidence: [] }),
      publicSource('two', { authorityEvidence: [] }),
    ])).status).toBe('unknown-freshness');

    const noManifest = discovery({ current: a.tuple });
    const result = await noManifest.value.coldStartPublic([
      publicSource('one', { authorityEvidence: [] }),
      publicSource('two', { authorityEvidence: [], manifestBytes: Uint8Array.of(0) }),
    ]);
    expect(result.status).toBe('unknown-freshness');
    expect(result.status).not.toBe('complete');
  });

  it('reports known incomplete and persists backoff when signed providers have no usable path', async () => {
    const a = await authority();
    const m = await manifest(a);
    const state = new MemoryState();
    const { value } = discovery({ current: a.tuple, state, resolver: async () => [] });
    const result = await value.coldStartPublic([
      publicSource('one', { authorityEvidence: [], manifestBytes: m.bytes }),
      publicSource('two', { authorityEvidence: [], manifestBytes: m.bytes }),
    ]);
    expect(result.status).toBe('known-incomplete');
    expect(result.providers).toEqual([]);
    expect(state.getPeerState(peerA)?.failureCount).toBe(1);
    expect(state.retries).toHaveLength(1);
  });

  it('does not expose private collection metadata and collapses unauthorized tickets', async () => {
    const a = await authority();
    const m = await manifest(a);
    const t = ticket(m.id);
    const sourceCalls: unknown[] = [];
    const open = vi.fn(() => null);
    const resolve = vi.fn(async () => []);
    const { value } = discovery({ current: a.tuple, privateOpen: open, resolver: resolve });
    const result = await value.coldStartPrivate([
      privateSource('one', { authorityEvidence: [], privateTicketBytes: t.bytes }, sourceCalls),
      privateSource('two', { authorityEvidence: [], privateTicketBytes: t.bytes }, sourceCalls),
    ], { memberAgentAddress: member.address, membershipCheckpointId: t.membership });
    expect(result).toMatchObject({ status: 'denied', providers: [], reason: 'private bootstrap denied' });
    expect(sourceCalls).toEqual([
      { agent: member.address, signal: undefined },
      { agent: member.address, signal: undefined },
    ]);
    expect(open).toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(Buffer.from(collectionId).toString('hex'));
  });

  it('opens an authorized private ticket and verifies its exact signed manifest binding', async () => {
    const a = await authority();
    const m = await manifest(a);
    const t = ticket(m.id);
    const { value } = discovery({ current: a.tuple, privateOpen: () => m.bytes });
    const result = await value.coldStartPrivate([
      privateSource('one', { authorityEvidence: [], privateTicketBytes: t.bytes }),
      privateSource('two', { authorityEvidence: [], privateTicketBytes: t.bytes }),
    ], { memberAgentAddress: member.address, membershipCheckpointId: t.membership });
    expect(result.status).toBe('provider-ready');
    expect(result.manifestIds).toEqual([m.id]);
  });

  it('switches only at request boundaries and accepts a provider only after result verification', async () => {
    const { value } = discovery();
    const state = value['options'].state as MemoryState;
    const providers: WalProviderCandidate[] = [
      { peerId: peerA, agentAddress: providerAgent.address, namespaceIds: [namespaceId], paths: [{ address: 'a', kind: 'direct' }], score: 100 },
      { peerId: peerB, agentAddress: providerAgent.address, namespaceIds: [namespaceId], paths: [{ address: 'b', kind: 'relay' }], score: 10 },
    ];
    const operations: string[] = [];
    const result = await value.executeAtRequestBoundary(providers, {
      targetFresh: true,
      operation: async provider => {
        operations.push(Buffer.from(provider.peerId).toString('hex'));
        return provider.peerId === peerA ? 'poison' : 'exact';
      },
      verify: answer => { if (answer !== 'exact') throw new Error('invalid signed response'); },
    });
    expect(result.value).toBe('exact');
    expect(result.provider.peerId).toEqual(peerB);
    expect(operations).toHaveLength(2);
    expect(state.getPeerState(peerA)?.failureCount).toBe(1);
    expect(state.getPeerState(peerB)?.successCount).toBe(1);
  });

  it('switches providers for symbols, fallback pages, and whole-object ranges without duplicate durable parts', async () => {
    const providers: WalProviderCandidate[] = [
      { peerId: peerA, agentAddress: providerAgent.address, namespaceIds: [namespaceId], paths: [{ address: 'a', kind: 'direct' }], score: 100 },
      { peerId: peerB, agentAddress: providerAgent.address, namespaceIds: [namespaceId], paths: [{ address: 'b', kind: 'relay' }], score: 10 },
    ];
    const object = await createWalObjectV1([
      1n,
      namespaceId,
      providerAgent.address,
      0n,
      0n,
      null,
      Uint8Array.from({ length: 257 }, (_, index) => (index * 19) & 0xff),
    ], providerAgent);
    const objectId = walObjectId(object.walObjectId);
    const head = deterministicHead('provider-switch', [objectId]);
    const seed = deterministicSeed('provider-switch');

    const encoder = new RatelessIbltEncoder({
      ids: [objectId], reconciliationSeed: seed, algorithm: PAPER_BASELINE_V0.algorithm,
    });
    const probe = new RatelessIbltDecoder({
      receiverIds: [], reconciliationSeed: seed, algorithm: PAPER_BASELINE_V0.algorithm,
    });
    const validSymbols: ReconciliationSymbolV1[] = [];
    while (!probe.complete && validSymbols.length < 64) {
      const symbol = encoder.produceNext();
      validSymbols.push(symbol);
      probe.addProviderSymbol(symbol);
    }
    expect(probe.complete).toBe(true);
    const malformedSymbols = validSymbols.map((symbol, index) => index === 0
      ? { ...symbol, symbolIndex: symbol.symbolIndex + 1 }
      : symbol);
    const symbols = await discovery().value.executeAtRequestBoundary(providers, {
      targetFresh: true,
      operation: async provider => provider.peerId === peerA ? malformedSymbols : validSymbols,
      verify: response => {
        const decoder = new RatelessIbltDecoder({
          receiverIds: [], reconciliationSeed: seed, algorithm: PAPER_BASELINE_V0.algorithm,
        });
        decoder.addProviderWindow(response);
        verifyDecodedDifference([], decoder.snapshot(), head);
      },
    });
    expect(symbols.provider.peerId).toEqual(peerB);
    expect(symbols.value).toEqual(validSymbols);

    const validPages = createFallbackPages([objectId], head, 1);
    const malformedPages = validPages.map((page, index) => index === 0
      ? { ...page, headId: reconciliationHeadId(bytes('wrong-fallback-head')) }
      : page);
    const fallback = await discovery().value.executeAtRequestBoundary(providers, {
      targetFresh: true,
      operation: async provider => provider.peerId === peerA ? malformedPages : validPages,
      verify: response => { verifyFallbackPages(response, head); },
    });
    expect(fallback.provider.peerId).toEqual(peerB);
    expect(verifyFallbackPages(fallback.value, head)).toEqual([objectId]);

    const root = await mkdtemp(join(tmpdir(), 'dkg-wal-provider-range-switch-'));
    roots.push(root);
    const store = new PackedWalObjectStore({ root: join(root, 'objects') });
    stores.push(store);
    let durableParts = 0;
    const receiver = new FileWalObjectRangeReceiver({
      stagingRoot: join(root, 'ranges'),
      store,
      maximumRangeBytes: 64,
      durabilityHook: point => { if (point === 'range-file-synced') durableParts += 1; },
    });
    const totalObjectLength = BigInt(object.canonicalBytes.length);
    const requested = await receiver.missing(objectId, totalObjectLength, 64);
    const rangeDiscovery = discovery().value;
    const fetch = async (offset: bigint, maximumLength: number) => rangeDiscovery.executeAtRequestBoundary(providers, {
      targetFresh: true,
      operation: async provider => {
        if (provider.peerId === peerA) throw new Error('direct provider disconnected at the request boundary');
        const start = Number(offset);
        return {
          walObjectId: objectId,
          totalObjectLength,
          offset,
          bytes: object.canonicalBytes.slice(start, start + maximumLength),
        };
      },
      verify: response => {
        if (
          response.offset !== offset
          || response.totalObjectLength !== totalObjectLength
          || !Buffer.from(response.walObjectId).equals(Buffer.from(objectId))
          || response.bytes.length < 1
          || response.bytes.length > maximumLength
        ) throw new Error('range response is not bound to the request');
      },
    });

    const first = await fetch(requested[0].offset, requested[0].maximumLength);
    expect(first.provider.peerId).toEqual(peerB);
    expect(await receiver.accept(first.value)).toBe('stored');
    const repeated = await fetch(requested[0].offset, requested[0].maximumLength);
    expect(await receiver.accept(repeated.value)).toBe('duplicate');
    for (const range of requested.slice(1)) {
      const response = await fetch(range.offset, range.maximumLength);
      await receiver.accept(response.value);
    }
    expect(await receiver.missing(objectId, totalObjectLength, 64)).toEqual([]);
    expect(await collect(store.read(objectId))).toEqual(object.canonicalBytes);
    expect(durableParts).toBe(requested.length);
  });

  it('restores provider state after restart and suppresses tight retry loops', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dkg-wal-provider-state-'));
    roots.push(root);
    new PackedWalObjectStore({ root }).close();
    let control = new WalControlStore({ root, now: () => NOW });
    controls.push(control);
    const first = discovery({ state: control });
    const backoff = first.value.recordFailure(peerA, new Error('offline'));
    control.close();
    controls.splice(controls.indexOf(control), 1);

    control = new WalControlStore({ root, now: () => NOW });
    controls.push(control);
    expect(control.getPeerState(peerA)).toMatchObject({ failureCount: 1, backoffUntilMs: backoff });
    const second = discovery({ state: control });
    const operation = vi.fn(async () => 'never');
    await expect(second.value.executeAtRequestBoundary([
      { peerId: peerA, agentAddress: providerAgent.address, namespaceIds: [namespaceId], paths: [{ address: 'a', kind: 'direct' }], score: 1 },
    ], { targetFresh: false, operation, verify: () => undefined })).rejects.toMatchObject({
      code: 'WAL_PROVIDER_UNAVAILABLE', readiness: 'unknown-freshness',
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it('bounds bootstrap and resolution fan-out and supports direct-to-relay path changes', async () => {
    const a = await authority();
    const m = await manifest(a);
    let active = 0;
    let maximum = 0;
    let pathKind: WalProviderPath['kind'] = 'direct';
    const sources = Array.from({ length: 5 }, (_, index): WalPublicBootstrapSource => ({
      id: `source-${index}`,
      async fetchPublic() {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 2));
        active -= 1;
        return { authorityEvidence: [], manifestBytes: m.bytes };
      },
    }));
    const { value } = discovery({
      current: a.tuple,
      resolver: async (_peer, signed) => [{ address: signed[0], kind: pathKind }],
      limits: { maximumBootstrapSources: 4, maximumResolutionFanout: 2 },
    });
    const direct = await value.coldStartPublic(sources);
    pathKind = 'relay';
    const relay = await value.coldStartPublic(sources);
    expect(maximum).toBeLessThanOrEqual(2);
    expect(direct.providers[0].paths[0].kind).toBe('direct');
    expect(relay.providers[0].paths[0].kind).toBe('relay');
    expect(direct.manifestIds).toEqual(relay.manifestIds);
  });

  it('rejects invalid bootstrap and manifest configurations with stable codes', async () => {
    expectProviderError(() => new WalProviderDiscovery(null as never), 'WAL_PROVIDER_INVALID_CONFIGURATION');
    expectProviderError(() => discovery({ limits: { maximumSelectedProviders: 65 } }), 'WAL_PROVIDER_INVALID_CONFIGURATION');
    const a = await authority();
    const m = await manifest(a);
    expectProviderError(() => verifyProviderBootstrapManifest(new Uint8Array(), {
      networkId: 'testnet', collectionId, networkAuthority: a.tuple, nowMs: NOW,
    }), 'WAL_PROVIDER_INVALID_MANIFEST');
    await expect(discovery({ current: a.tuple }).value.coldStartPublic([
      publicSource('same', { authorityEvidence: [], manifestBytes: m.bytes }),
      publicSource('same', { authorityEvidence: [], manifestBytes: m.bytes }),
    ])).rejects.toMatchObject({ code: 'WAL_PROVIDER_INVALID_CONFIGURATION' });
  });

  it('classifies unavailable errors and rejects empty provider execution cleanly', async () => {
    const { value } = discovery();
    let captured: unknown;
    try {
      await value.executeAtRequestBoundary([], {
        targetFresh: true,
        operation: async () => 1,
        verify: () => undefined,
      });
    } catch (error) {
      captured = error;
    }
    expect(isWalProvidersUnavailable(captured)).toBe(true);
    expect(isWalProvidersUnavailable(new Error('other'))).toBe(false);
    expect(captured).toMatchObject({ readiness: 'known-incomplete' });
    await expect(value.executeAtRequestBoundary([], {
      targetFresh: false,
      operation: async () => 1,
      verify: () => undefined,
    })).rejects.toMatchObject({ readiness: 'unknown-freshness' });
  });

  it('enforces every signed provider-manifest authority, window, identity, and size boundary', async () => {
    const a = await authority();
    const valid = await manifest(a);
    const verify = (canonical: Uint8Array, authorityTuple = a.tuple, extra: Record<string, unknown> = {}) =>
      verifyProviderBootstrapManifest(canonical, {
        networkId: 'testnet', collectionId, networkAuthority: authorityTuple, nowMs: NOW, clockSkewMs: 0, ...extra,
      });
    const invalid = (operation: () => unknown, code: WalProviderDiscoveryError['code'] = 'WAL_PROVIDER_INVALID_MANIFEST') =>
      expectProviderError(operation, code);

    expect(verify(valid.bytes).id).toEqual(valid.id);
    expect(verifyProviderBootstrapManifest(valid.bytes, {
      networkId: 'testnet', collectionId, networkAuthority: a.tuple, nowMs: NOW,
    }).id).toEqual(valid.id);
    invalid(() => verifyProviderBootstrapManifest(null as never, {
      networkId: 'testnet', collectionId, networkAuthority: a.tuple, nowMs: NOW,
    }));
    invalid(() => verify(valid.bytes, a.tuple, { collectionId: Uint8Array.of(1) }), 'WAL_PROVIDER_INVALID_CONFIGURATION');
    invalid(() => verify(valid.bytes, a.tuple, { nowMs: -1 }), 'WAL_PROVIDER_INVALID_CONFIGURATION');
    invalid(() => verify(valid.bytes, a.tuple, { clockSkewMs: -1 }), 'WAL_PROVIDER_INVALID_CONFIGURATION');
    invalid(() => verify(valid.bytes, a.tuple, { maximumProviders: 0 }), 'WAL_PROVIDER_INVALID_CONFIGURATION');
    invalid(() => verify(valid.bytes, [1n] as never));

    const graphAuthority = await authority({ scope: 0n });
    invalid(() => verify(valid.bytes, graphAuthority.tuple));
    const foreignAuthority = await authority({ networkId: 'other' });
    invalid(() => verify(valid.bytes, foreignAuthority.tuple));
    const expiredAuthority = await authority({ expiresAt: 4_000n });
    const expiredAuthorityManifest = await manifest(expiredAuthority);
    invalid(() => verify(expiredAuthorityManifest.bytes, expiredAuthority.tuple));
    const emptyAuthorityWindow = await authority({ notBefore: 5_000n, expiresAt: 5_000n });
    const emptyAuthorityWindowManifest = await manifest(emptyAuthorityWindow);
    invalid(() => verify(emptyAuthorityWindowManifest.bytes, emptyAuthorityWindow.tuple));
    const oversizedAuthorityTime = await authority({ expiresAt: BigInt(Number.MAX_SAFE_INTEGER) + 1n });
    const oversizedAuthorityManifest = await manifest(oversizedAuthorityTime);
    invalid(() => verify(oversizedAuthorityManifest.bytes, oversizedAuthorityTime.tuple));

    const wrongNetwork = await manifest(a, [{}], { networkId: 'other' });
    const wrongCollection = await manifest(a, [{}], { collection: bytes('other-collection') });
    const wrongEpoch = await manifest(a, [{}], { epoch: 2n });
    const wrongAuthorityId = await manifest(a, [{}], { authorityId: bytes('other-authority') });
    const future = await manifest(a, [{}], { notBefore: 6_000n, expiresAt: 9_000n });
    const emptyWindow = await manifest(a, [{}], { notBefore: 5_000n, expiresAt: 5_000n });
    const emptyProviders = await manifest(a, []);
    const tooManyProviders = await manifest(a, [{ peerId: peerA }, { peerId: peerB }]);
    const emptyPeer = await manifest(a, [{ peerId: new Uint8Array() }]);
    const longPeer = await manifest(a, [{ peerId: new Uint8Array(129) }]);
    const duplicatePeer = await manifest(a, [
      { peerId: peerA, endpoints: ['a'] },
      { peerId: peerA, endpoints: ['b'] },
    ]);
    const tooManyEndpoints = await manifest(a, [{ endpoints: Array.from({ length: 33 }, (_, index) => `endpoint-${index.toString().padStart(2, '0')}`) }]);
    const longEndpoint = await manifest(a, [{ endpoints: ['x'.repeat(2_049)] }]);
    const unauthorized = await manifest(a, [{}], { signer: otherSigner });
    for (const item of [wrongNetwork, wrongCollection, wrongEpoch, wrongAuthorityId, future, emptyWindow, emptyProviders, emptyPeer, longPeer, duplicatePeer, tooManyEndpoints, longEndpoint]) {
      invalid(() => verify(item.bytes));
    }
    invalid(() => verify(tooManyProviders.bytes, a.tuple, { maximumProviders: 1 }));
    invalid(() => verify(unauthorized.bytes), 'WAL_PROVIDER_UNAUTHORIZED');
  });

  it('rejects invalid discovery construction and bootstrap-source shapes', async () => {
    const invalidOptions: Array<Partial<WalProviderDiscoveryOptions>> = [
      { networkId: '' },
      { networkId: 'e\u0301' },
      { collectionId: Uint8Array.of(1) },
      { namespaceIds: [] },
      { namespaceIds: [namespaceId, namespaceId] },
      { authority: null as never },
      { resolver: null as never },
      { state: null as never },
      { clockSkewMs: -1 },
      { maximumBootstrapSources: 0 },
      { maximumResolutionFanout: 0 },
      { maximumCandidates: 0 },
      { maximumSelectedProviders: 0 },
      { maximumPathsPerProvider: 0 },
      { baseBackoffMs: 0 },
      { maximumBackoffMs: 0 },
      { maximumCandidates: 1, maximumSelectedProviders: 2 },
      { baseBackoffMs: 2, maximumBackoffMs: 1 },
    ];
    for (const options of invalidOptions) {
      expectProviderError(() => new WalProviderDiscovery(baseOptions(options)), 'WAL_PROVIDER_INVALID_CONFIGURATION');
    }
    expect(new WalProviderDiscovery(baseOptions({ now: undefined })).networkId).toBe('testnet');
    const value = new WalProviderDiscovery(baseOptions());
    const response = { authorityEvidence: [] };
    await expect(value.coldStartPublic([])).rejects.toMatchObject({ code: 'WAL_PROVIDER_INVALID_CONFIGURATION' });
    await expect(value.coldStartPublic([publicSource('one', response)])).rejects.toMatchObject({ code: 'WAL_PROVIDER_INVALID_CONFIGURATION' });
    await expect(value.coldStartPublic([null as never, publicSource('two', response)])).rejects.toMatchObject({ code: 'WAL_PROVIDER_INVALID_CONFIGURATION' });
    await expect(value.coldStartPublic([{ id: 1 } as never, publicSource('two', response)])).rejects.toMatchObject({ code: 'WAL_PROVIDER_INVALID_CONFIGURATION' });
    await expect(value.coldStartPublic([publicSource('', response), publicSource('two', response)])).rejects.toMatchObject({ code: 'WAL_PROVIDER_INVALID_CONFIGURATION' });
  });

  it('validates, ranks, deduplicates, and bounds every resolver path kind', async () => {
    const a = await authority();
    const m = await manifest(a);
    const { value } = discovery({
      current: a.tuple,
      limits: { maximumPathsPerProvider: 7 },
      resolver: async () => [
        { address: 'same', kind: 'persisted' },
        { address: 'same', kind: 'live' },
        { address: 'direct-b', kind: 'direct' },
        { address: 'direct-a', kind: 'direct' },
        { address: 'dht', kind: 'dht' },
        { address: 'directory', kind: 'directory' },
        { address: 'relay', kind: 'relay' },
        { address: 'signed', kind: 'signed' },
        { address: 'persisted', kind: 'persisted' },
        { address: '', kind: 'direct' },
        { address: 'e\u0301', kind: 'direct' },
        { address: 7 as never, kind: 'direct' },
      ],
    });
    const result = await value.coldStartPublic([
      publicSource('one', { authorityEvidence: [], manifestBytes: m.bytes }),
      publicSource('two', { authorityEvidence: [], manifestBytes: m.bytes }),
    ]);
    expect(result.providers[0].paths.map(path => path.kind)).toEqual([
      'live', 'direct', 'direct', 'dht', 'directory', 'relay', 'signed',
    ]);
  });

  it('treats corrupt or malformed persisted availability hints only as untrusted hints', async () => {
    const a = await authority();
    const peers = Array.from({ length: 7 }, (_, index) => Uint8Array.of(4, index));
    const m = await manifest(a, peers.map(peerId => ({ peerId })));
    const hints = [
      Uint8Array.of(0xff),
      encodeCanonicalCbor(null),
      encodeCanonicalCbor([1n]),
      encodeCanonicalCbor([2n, [], 0n]),
      encodeCanonicalCbor([1n, 'bad', 0n]),
      encodeCanonicalCbor([1n, [], 'bad']),
      encodeCanonicalCbor([1n, [1n], 0n]),
    ];
    const state = new MemoryState();
    for (let index = 0; index < peers.length; index += 1) state.putPeerState({
      peerId: peers[index], successCount: 0, failureCount: 0, backoffUntilMs: 0,
      availabilityHint: hints[index], updatedAtMs: 1,
    });
    const observed: string[][] = [];
    const { value } = discovery({ current: a.tuple, state, resolver: async (_peer, _signed, persisted) => {
      observed.push([...persisted]);
      return [{ address: 'dialable', kind: 'direct' }];
    } });
    const result = await value.coldStartPublic([
      publicSource('one', { authorityEvidence: [], manifestBytes: m.bytes }),
      publicSource('two', { authorityEvidence: [], manifestBytes: m.bytes }),
    ]);
    expect(result.status).toBe('provider-ready');
    expect(observed).toEqual(Array.from({ length: 7 }, () => []));

    value.recordSuccess(result.providers[0]);
    let restored: readonly string[] = [];
    const restarted = discovery({ current: a.tuple, state, resolver: async (_peer, _signed, persisted) => {
      restored = persisted;
      return [{ address: 'dialable', kind: 'direct' }];
    } });
    await restarted.value.coldStartPublic([
      publicSource('one', { authorityEvidence: [], manifestBytes: m.bytes }),
      publicSource('two', { authorityEvidence: [], manifestBytes: m.bytes }),
    ]);
    expect(restored).toContain('dialable');
  });

  it('fails private discovery closed for missing authority, malformed, stale, empty, and misbound tickets', async () => {
    const a = await authority();
    const m = await manifest(a);
    const good = ticket(m.id);
    await expect(discovery({ current: a.tuple }).value.coldStartPrivate([
      privateSource('one', { authorityEvidence: [] }),
      privateSource('two', { authorityEvidence: [] }),
    ], { memberAgentAddress: member.address, membershipCheckpointId: good.membership })).rejects.toMatchObject({
      code: 'WAL_PROVIDER_INVALID_CONFIGURATION',
    });

    const unknown = discovery({ privateOpen: () => m.bytes, accept: () => undefined });
    expect((await unknown.value.coldStartPrivate([
      privateSource('one', { authorityEvidence: [] }),
      privateSource('two', { authorityEvidence: [] }),
    ], { memberAgentAddress: member.address, membershipCheckpointId: good.membership })).status).toBe('unknown-freshness');

    const cases = [
      Uint8Array.of(0),
      ticket(m.id, { collection: bytes('wrong-collection') }).bytes,
      ticket(m.id, { agent: otherSigner.address }).bytes,
      ticket(m.id, { membership: bytes('wrong-membership') }).bytes,
      ticket(m.id, { notBefore: 6_000n }).bytes,
      ticket(m.id, { ciphertext: new Uint8Array() }).bytes,
    ];
    const open = vi.fn(() => m.bytes);
    const guarded = discovery({ current: a.tuple, privateOpen: open, limits: { clockSkewMs: 0 } });
    for (let index = 0; index < cases.length; index += 1) {
      const result = await guarded.value.coldStartPrivate([
        privateSource(`one-${index}`, { authorityEvidence: [], privateTicketBytes: cases[index] }),
        privateSource(`two-${index}`, { authorityEvidence: [] }),
      ], { memberAgentAddress: member.address, membershipCheckpointId: good.membership });
      expect(result.status).toBe('denied');
    }
    expect(open).not.toHaveBeenCalled();

    const wrongManifest = await manifest(a, [{ peerId: peerB }]);
    const wrongOpen = discovery({ current: a.tuple, privateOpen: () => wrongManifest.bytes });
    expect((await wrongOpen.value.coldStartPrivate([
      privateSource('one', { authorityEvidence: [], privateTicketBytes: good.bytes }),
      privateSource('two', { authorityEvidence: [] }),
    ], { memberAgentAddress: member.address, membershipCheckpointId: good.membership })).status).toBe('denied');

    const throws = discovery({ current: a.tuple, privateOpen: () => { throw new Error('decrypt'); } });
    expect((await throws.value.coldStartPrivate([
      privateSource('one', { authorityEvidence: [], privateTicketBytes: good.bytes }),
      privateSource('two', new Error('offline')),
    ], { memberAgentAddress: member.address, membershipCheckpointId: good.membership })).status).toBe('denied');
  });

  it('short-circuits aborted sources and rejects bad authority evidence uniformly', async () => {
    const a = await authority();
    const m = await manifest(a);
    const controller = new AbortController();
    controller.abort();
    const publicFetch = vi.fn();
    const publicResult = await discovery({ current: a.tuple }).value.coldStartPublic([
      { id: 'one', fetchPublic: publicFetch },
      { id: 'two', fetchPublic: publicFetch },
    ], { signal: controller.signal });
    expect(publicResult.status).toBe('unknown-freshness');
    expect(publicFetch).not.toHaveBeenCalled();

    const t = ticket(m.id);
    const privateFetch = vi.fn();
    const privateResult = await discovery({ current: a.tuple, privateOpen: () => m.bytes }).value.coldStartPrivate([
      { id: 'one', fetchPrivate: privateFetch },
      { id: 'two', fetchPrivate: privateFetch },
    ], { memberAgentAddress: member.address, membershipCheckpointId: t.membership, signal: controller.signal });
    expect(privateResult.status).toBe('unknown-freshness');
    expect(privateFetch).not.toHaveBeenCalled();

    const accepted: string[] = [];
    const evidence = discovery({
      current: a.tuple,
      accept: value => {
        const label = Buffer.from(value).toString('hex');
        accepted.push(label);
        if (value[0] === 9) throw new Error('invalid rotation');
      },
    });
    const result = await evidence.value.coldStartPublic([
      publicSource('invalid-evidence', { authorityEvidence: [Uint8Array.of(9)], manifestBytes: m.bytes }),
      publicSource('invalid-shape', { authorityEvidence: null as never, manifestBytes: m.bytes }),
      publicSource('valid', { authorityEvidence: [Uint8Array.of(8)], manifestBytes: m.bytes }),
    ]);
    expect(result.status).toBe('provider-ready');
    expect(accepted).toEqual(['09', '08']);
  });

  it('unions agreeing manifests, rejects peer-agent ambiguity, filters namespaces, and handles resolver failures', async () => {
    const a = await authority();
    const otherNamespace = bytes('other-namespace');
    const first = await manifest(a, [{ peerId: peerA, endpoints: ['a'], namespaces: [namespaceId] }]);
    const second = await manifest(a, [
      { peerId: peerA, endpoints: ['b'], namespaces: [namespaceId, otherNamespace] },
      { peerId: peerB, endpoints: ['ignored'], namespaces: [otherNamespace] },
    ]);
    const calls: Array<{ signed: readonly string[] }> = [];
    const union = discovery({ current: a.tuple, resolver: async (_peer, signed) => {
      calls.push({ signed });
      return signed.map(address => ({ address, kind: 'direct' as const }));
    } });
    const result = await union.value.coldStartPublic([
      publicSource('one', { authorityEvidence: [], manifestBytes: first.bytes }),
      publicSource('two', { authorityEvidence: [], manifestBytes: second.bytes }),
    ]);
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].namespaceIds).toEqual([namespaceId, otherNamespace]);
    expect(calls[0].signed).toEqual(['a', 'b']);

    const conflicting = await manifest(a, [{ peerId: peerA, agentAddress: otherSigner.address }]);
    const afterConflict = await manifest(a, [{ peerId: peerA }]);
    const ambiguous = discovery({ current: a.tuple });
    const ambiguousResult = await ambiguous.value.coldStartPublic([
      publicSource('one', { authorityEvidence: [], manifestBytes: first.bytes }),
      publicSource('two', { authorityEvidence: [], manifestBytes: conflicting.bytes }),
      publicSource('three', { authorityEvidence: [], manifestBytes: afterConflict.bytes }),
    ]);
    expect(ambiguousResult.status).toBe('known-incomplete');

    const state = new MemoryState();
    const throwing = discovery({ current: a.tuple, state, resolver: async () => { throw new Error('resolver'); } });
    expect((await throwing.value.coldStartPublic([
      publicSource('one', { authorityEvidence: [], manifestBytes: first.bytes }),
      publicSource('two', { authorityEvidence: [], manifestBytes: first.bytes }),
    ])).status).toBe('known-incomplete');
    expect(state.retries).toHaveLength(1);

    const backedOffState = new MemoryState();
    backedOffState.putPeerState({
      peerId: peerA, successCount: 0, failureCount: 1, backoffUntilMs: NOW + 1,
      availabilityHint: null, updatedAtMs: NOW,
    });
    const backedOffResolver = vi.fn(async () => [{ address: 'unused', kind: 'direct' as const }]);
    const backedOff = discovery({ current: a.tuple, state: backedOffState, resolver: backedOffResolver });
    expect((await backedOff.value.coldStartPublic([
      publicSource('one', { authorityEvidence: [], manifestBytes: first.bytes }),
      publicSource('two', { authorityEvidence: [], manifestBytes: first.bytes }),
    ])).status).toBe('known-incomplete');
    expect(backedOffResolver).not.toHaveBeenCalled();
  });

  it('saturates scoring and retry arithmetic while preserving existing success, failure, and hints', async () => {
    const a = await authority();
    const m = await manifest(a, [{ peerId: peerA }, { peerId: peerB }]);
    const state = new MemoryState();
    state.putPeerState({
      peerId: peerA, successCount: Number.MAX_SAFE_INTEGER, failureCount: 0,
      backoffUntilMs: 0, availabilityHint: encodeCanonicalCbor([1n, ['old'], 1n]), updatedAtMs: 1,
    });
    state.putPeerState({
      peerId: peerB, successCount: 0, failureCount: Number.MAX_SAFE_INTEGER,
      backoffUntilMs: 0, availabilityHint: null, updatedAtMs: 1,
    });
    const { value } = discovery({ current: a.tuple, state, resolver: async peer => [{
      address: peer[peer.length - 1] === peerA[peerA.length - 1] ? 'a' : 'b', kind: 'direct',
    }] });
    const result = await value.coldStartPublic([
      publicSource('one', { authorityEvidence: [], manifestBytes: m.bytes }),
      publicSource('two', { authorityEvidence: [], manifestBytes: m.bytes }),
    ]);
    expect(result.providers.map(provider => provider.score)).toEqual([Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]);
    value.recordSuccess(result.providers[0]);
    expect(state.getPeerState(peerA)).toMatchObject({
      successCount: Number.MAX_SAFE_INTEGER, failureCount: 0, backoffUntilMs: 0,
    });

    const tiny = discovery({ state: new MemoryState(), limits: { baseBackoffMs: 1, maximumBackoffMs: 1 } });
    expect(tiny.value.recordFailure(Uint8Array.of(0), null)).toBe(NOW + 1);
    expectProviderError(() => tiny.value.recordFailure(new Uint8Array(), null), 'WAL_PROVIDER_INVALID_CONFIGURATION');

    const saturated = new MemoryState();
    saturated.putPeerState({
      peerId: peerA, successCount: 7, failureCount: 20, backoffUntilMs: 0,
      availabilityHint: Uint8Array.of(1), updatedAtMs: 1,
    });
    const late = discovery({ state: saturated, now: () => Number.MAX_SAFE_INTEGER, limits: { baseBackoffMs: 1, maximumBackoffMs: 10 } });
    expect(late.value.recordFailure(peerA, null)).toBe(Number.MAX_SAFE_INTEGER);
    expect(saturated.getPeerState(peerA)).toMatchObject({ successCount: 7, failureCount: 21, availabilityHint: Uint8Array.of(1) });
  });

  it('honors explicit attempt bounds, deterministic provider order, and invalid clocks', async () => {
    const first: WalProviderCandidate = {
      peerId: peerA, agentAddress: providerAgent.address, namespaceIds: [namespaceId], paths: [{ address: 'a', kind: 'direct' }], score: 1,
    };
    const second: WalProviderCandidate = { ...first, peerId: peerB };
    const { value } = discovery();
    const calls: string[] = [];
    await expect(value.executeAtRequestBoundary([second, first], {
      targetFresh: true,
      maximumAttempts: 1,
      operation: async provider => { calls.push(Buffer.from(provider.peerId).toString('hex')); throw new Error('offline'); },
      verify: () => undefined,
    })).rejects.toMatchObject({ code: 'WAL_PROVIDER_UNAVAILABLE', readiness: 'known-incomplete' });
    expect(calls).toEqual([Buffer.from(peerA).toString('hex')]);
    await expect(value.executeAtRequestBoundary([first], {
      targetFresh: true, maximumAttempts: 0, operation: async () => 1, verify: () => undefined,
    })).rejects.toMatchObject({ code: 'WAL_PROVIDER_INVALID_CONFIGURATION' });

    const badClock = discovery({ now: () => -1 });
    expectProviderError(() => badClock.value.recordSuccess(first), 'WAL_PROVIDER_INVALID_CONFIGURATION');
    const fractionalClock = discovery({ now: () => 1.5 });
    expectProviderError(() => fractionalClock.value.recordFailure(peerA, null), 'WAL_PROVIDER_INVALID_CONFIGURATION');
  });
});
