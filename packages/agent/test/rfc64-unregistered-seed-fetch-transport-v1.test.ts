// SPDX-License-Identifier: Apache-2.0

/**
 * RFC-64 unregistered-authority seed transport: the policy-less pull of an
 * owner-signed seed for a wallet-namespaced Context Graph. Pins the wire
 * contract (protocol id, caps, status framing), the fail-closed verification
 * at both ends (issuer == wallet prefix, exact network/graph binding, public
 * generation-0 shape), the non-wallet-id rejection before any I/O, and the
 * service-level first-verified-wins fan-out.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import {
  DKGNode,
  ProtocolRouter,
  canonicalizeSignedContextGraphPolicyEnvelopeBytesV1,
  parseCanonicalSignedContextGraphPolicyEnvelopeV1,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type NetworkIdV1,
  type SendOptions,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  encodeRfc64FlatCanonicalJsonV1,
  encodeRfc64FoundStatusResponseV1,
} from '../src/rfc64/catalog-transport-wire-v1-internal.js';
import { Rfc64PublicCatalogServiceV1 } from '../src/rfc64/public-catalog-service-v1.js';
import { RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1 } from
  '../src/rfc64/public-catalog-transport-v1.js';
import { RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1 as SEED_STORE_MAX_BYTES } from
  '../src/rfc64/unregistered-authority-seed-store-v1.js';
import {
  RFC64_UNREGISTERED_AUTHORITY_FANOUT_CONCURRENCY_V1,
  RFC64_UNREGISTERED_AUTHORITY_MAX_FANOUT_PEERS_V1,
  RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1,
  RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1,
  RFC64_UNREGISTERED_AUTHORITY_QUERY_MAX_BYTES_V1,
  RFC64_UNREGISTERED_AUTHORITY_RESPONSE_MAX_BYTES_V1,
  RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1,
  Rfc64UnregisteredAuthorityTransportErrorV1,
  Rfc64UnregisteredAuthorityTransportV1,
  authenticateRfc64UnregisteredAuthorityEnvelopeV1,
  encodeRfc64UnregisteredAuthorityQueryV1,
  parseRfc64UnregisteredAuthorityQueryV1,
  rfc64UnregisteredAuthorityOwnerV1,
  type Rfc64UnregisteredAuthorityScopeV1,
} from '../src/rfc64/unregistered-authority-transport-v1.js';
import { mintRfc64UnregisteredReplicaAuthorityEvidenceV1 } from
  '../src/rfc64/unregistered-replica-authority-v1.js';

const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const OTHER_NETWORK_ID = 'otp:1' as NetworkIdV1;
const OWNER_WALLET = new ethers.Wallet(`0x${'71'.repeat(32)}`);
const OWNER = OWNER_WALLET.address.toLowerCase() as EvmAddressV1;
const ATTACKER_WALLET = new ethers.Wallet(`0x${'72'.repeat(32)}`);
const ATTACKER = ATTACKER_WALLET.address.toLowerCase() as EvmAddressV1;
const CONTEXT_GRAPH_ID = `${OWNER}/seed-fetch` as ContextGraphIdV1;
const OTHER_CONTEXT_GRAPH_ID = `${OWNER}/other` as ContextGraphIdV1;
const NON_WALLET_CONTEXT_GRAPH_ID = 'plain-global-name' as ContextGraphIdV1;
const SCOPE: Rfc64UnregisteredAuthorityScopeV1 = Object.freeze({
  networkId: NETWORK_ID,
  contextGraphId: CONTEXT_GRAPH_ID,
});
const PROVIDER_PEER = '12D3KooWAUCFb3hwTLUu3bhMqAsqtF1YH1sTUaMuTXiyvC1z7k65';
const REQUESTER_PEER = '12D3KooWM72VdeDJFRRhrm9LKLYPrDyQjomVtccJuV8WXYG7uBUU';

type RouterHandler = (
  data: Uint8Array,
  peerId: { toString(): string },
  options?: { signal?: AbortSignal },
) => Promise<Uint8Array>;

/** In-process router: registered handlers answer `send` by peer id. */
class FakeRouter {
  readonly handlers = new Map<string, RouterHandler>();
  readonly sends: Array<{ peerId: string; protocolId: string; data: Uint8Array; options?: SendOptions }> = [];
  respond: (peerId: string, protocolId: string, data: Uint8Array, options?: SendOptions) => Promise<Uint8Array>;

  constructor(respond?: FakeRouter['respond']) {
    this.respond = respond ?? (async (_peerId, protocolId, data, options) => {
      const handler = this.handlers.get(protocolId);
      if (handler === undefined) throw new Error(`protocol is not registered: ${protocolId}`);
      return handler(data, { toString: () => REQUESTER_PEER }, { signal: options?.signal });
    });
  }

  register(protocolId: string, handler: RouterHandler): void {
    this.handlers.set(protocolId, handler);
  }

  unregister(protocolId: string): void {
    this.handlers.delete(protocolId);
  }

  async send(
    peerId: string,
    protocolId: string,
    data: Uint8Array,
    options?: SendOptions,
  ): Promise<Uint8Array> {
    this.sends.push({ peerId, protocolId, data, options });
    return this.respond(peerId, protocolId, data, options);
  }

  asProtocolRouter(): ProtocolRouter {
    return this as unknown as ProtocolRouter;
  }

  invoke(protocolId: string, data: Uint8Array, remotePeerId = REQUESTER_PEER, signal?: AbortSignal) {
    const handler = this.handlers.get(protocolId);
    if (handler === undefined) throw new Error(`protocol is not registered: ${protocolId}`);
    return handler(data, { toString: () => remotePeerId }, { signal });
  }
}

const temporaryDirectories: string[] = [];
const nodes: DKGNode[] = [];
const transports: Rfc64UnregisteredAuthorityTransportV1[] = [];
const services: Rfc64PublicCatalogServiceV1[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) {
    try { await service.close(); } catch {}
  }
  for (const transport of transports.splice(0)) {
    try { transport.stop(); } catch {}
  }
  for (const node of nodes.splice(0)) {
    try { await node.stop(); } catch {}
  }
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
  vi.restoreAllMocks();
});

async function mintSeedBytes(input: Readonly<{
  readonly wallet?: ethers.Wallet;
  readonly owner?: EvmAddressV1;
  readonly contextGraphId?: ContextGraphIdV1;
  readonly networkId?: NetworkIdV1;
  readonly accessPolicy?: 0 | 1;
}> = {}): Promise<Uint8Array> {
  const wallet = input.wallet ?? OWNER_WALLET;
  const owner = input.owner ?? (wallet.address.toLowerCase() as EvmAddressV1);
  const evidence = await mintRfc64UnregisteredReplicaAuthorityEvidenceV1({
    networkId: input.networkId ?? NETWORK_ID,
    contextGraphId: input.contextGraphId ?? CONTEXT_GRAPH_ID,
    ownerAddress: owner,
    accessPolicy: input.accessPolicy ?? 0,
    publishPolicy: 1,
    publishAuthorityAccountId: '0',
    memberAddresses: [],
    rosterVersion: '0',
    signer: {
      issuer: owner,
      signDigest: (digest) => wallet.signMessage(digest),
    },
  });
  return Uint8Array.from(Buffer.from(evidence, 'base64url'));
}

/** Same structure and issuer, but the signature bytes belong to another object. */
async function forgeSignature(seed: Uint8Array): Promise<Uint8Array> {
  const envelope = parseCanonicalSignedContextGraphPolicyEnvelopeV1(seed);
  const donor = parseCanonicalSignedContextGraphPolicyEnvelopeV1(
    await mintSeedBytes({ contextGraphId: OTHER_CONTEXT_GRAPH_ID }),
  );
  return canonicalizeSignedContextGraphPolicyEnvelopeBytesV1({
    ...envelope,
    signature: donor.signature,
  });
}

function startTransport(
  router: FakeRouter,
  readSeedEnvelopeBytes: (
    scope: Rfc64UnregisteredAuthorityScopeV1,
    signal?: AbortSignal,
  ) => Promise<Uint8Array | null>,
  isServingAllowed?: (contextGraphId: ContextGraphIdV1) => boolean,
): Rfc64UnregisteredAuthorityTransportV1 {
  const transport = new Rfc64UnregisteredAuthorityTransportV1(router.asProtocolRouter(), {
    readSeedEnvelopeBytes,
    verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    ...(isServingAllowed === undefined ? {} : { isServingAllowed }),
  });
  transports.push(transport);
  transport.start();
  return transport;
}

async function expectCode(
  promise: Promise<unknown>,
  code: Rfc64UnregisteredAuthorityTransportErrorV1['code'],
): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) =>
    error instanceof Rfc64UnregisteredAuthorityTransportErrorV1 && error.code === code);
}

/** Several failures share one code; the message is what discriminates them. */
async function expectCodeAndMessage(
  promise: Promise<unknown>,
  code: Rfc64UnregisteredAuthorityTransportErrorV1['code'],
  message: RegExp,
): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) =>
    error instanceof Rfc64UnregisteredAuthorityTransportErrorV1
    && error.code === code
    && message.test(error.message));
}

describe('RFC-64 unregistered-authority seed transport (wire contract)', () => {
  it('pins the protocol id, kind and caps, sharing the single seed bound with the keyed store', () => {
    expect(RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1).toBe('/dkg/catalog/1/unregistered-authority');
    expect(RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1).toBe('rfc64-unregistered-authority-query-v1');
    expect(RFC64_UNREGISTERED_AUTHORITY_QUERY_MAX_BYTES_V1).toBe(2 * 1024);
    // One bound: the store's SQL CHECK, the persist path and the wire agree.
    expect(RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1).toBe(4096);
    expect(RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1).toBe(SEED_STORE_MAX_BYTES);
    // Found response = one status byte + the seed.
    expect(RFC64_UNREGISTERED_AUTHORITY_RESPONSE_MAX_BYTES_V1).toBe(4096 + 1);
  });

  it('round-trips a canonical query and rejects oversize, extra-key and non-wallet queries', () => {
    const query = Object.freeze({
      kind: RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1,
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
    });
    const bytes = encodeRfc64UnregisteredAuthorityQueryV1(query);
    expect(parseRfc64UnregisteredAuthorityQueryV1(bytes)).toEqual(query);
    expect(bytes.byteLength).toBeLessThan(RFC64_UNREGISTERED_AUTHORITY_QUERY_MAX_BYTES_V1);

    expect(() => parseRfc64UnregisteredAuthorityQueryV1(
      new Uint8Array(RFC64_UNREGISTERED_AUTHORITY_QUERY_MAX_BYTES_V1 + 1).fill(0x20),
    )).toThrow(/empty or oversized/u);
    expect(() => parseRfc64UnregisteredAuthorityQueryV1(encodeRfc64FlatCanonicalJsonV1(
      { ...query, extra: 'x' },
      RFC64_UNREGISTERED_AUTHORITY_QUERY_MAX_BYTES_V1,
    ))).toThrow(/missing or unknown fields/u);
    expect(() => parseRfc64UnregisteredAuthorityQueryV1(encodeRfc64FlatCanonicalJsonV1(
      { ...query, contextGraphId: NON_WALLET_CONTEXT_GRAPH_ID },
      RFC64_UNREGISTERED_AUTHORITY_QUERY_MAX_BYTES_V1,
    ))).toThrow(/wallet-namespaced/u);
    expect(() => encodeRfc64UnregisteredAuthorityQueryV1({
      ...query,
      contextGraphId: NON_WALLET_CONTEXT_GRAPH_ID,
    })).toThrow(/wallet-namespaced/u);
  });

  it('derives the owner only from the wallet prefix of the graph id', () => {
    expect(rfc64UnregisteredAuthorityOwnerV1(CONTEXT_GRAPH_ID)).toBe(OWNER);
    expect(rfc64UnregisteredAuthorityOwnerV1(OWNER.toUpperCase().replace('0X', '0x'))).toBe(OWNER);
    expect(rfc64UnregisteredAuthorityOwnerV1(NON_WALLET_CONTEXT_GRAPH_ID)).toBeNull();
    expect(rfc64UnregisteredAuthorityOwnerV1(`${OWNER}x/trailing`)).toBeNull();
  });
});

describe('RFC-64 unregistered-authority seed transport (fake router)', () => {
  it('serves a stored seed and the requester authenticates it against the wallet prefix', async () => {
    const seed = await mintSeedBytes();
    const router = new FakeRouter();
    const read = vi.fn(async () => seed);
    const provider = startTransport(router, read);

    const fetched = await provider.fetchUnregisteredAuthority(PROVIDER_PEER, SCOPE);

    expect(fetched).not.toBeNull();
    expect(fetched!.ownerAddress).toBe(OWNER);
    expect(fetched!.envelope.issuer).toBe(OWNER);
    expect(fetched!.envelope.payload.contextGraphId).toBe(CONTEXT_GRAPH_ID);
    expect(fetched!.envelope.payload.networkId).toBe(NETWORK_ID);
    expect(fetched!.policyDigest).toBe(fetched!.envelope.objectDigest);
    expect(Buffer.from(fetched!.canonicalBytes).equals(Buffer.from(seed))).toBe(true);
    expect(Object.isFrozen(fetched)).toBe(true);
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]![0]).toEqual(SCOPE);
    expect(router.sends).toHaveLength(1);
    expect(router.sends[0]!.protocolId).toBe(RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1);
    // The requester hands the router the v1 response cap as its read ceiling
    // so it never buffers up to the router-wide default for this protocol.
    expect(router.sends[0]!.options?.maxReadBytes).toBe(RFC64_UNREGISTERED_AUTHORITY_RESPONSE_MAX_BYTES_V1);
    // Wire framing: status byte 1 followed by the exact canonical bytes.
    const response = await router.invoke(
      RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1,
      encodeRfc64UnregisteredAuthorityQueryV1({ kind: RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1, ...SCOPE }),
    );
    expect(response[0]).toBe(1);
    expect(Buffer.from(response.subarray(1)).equals(Buffer.from(seed))).toBe(true);
  });

  it('answers not-found with a single status byte and the requester resolves null', async () => {
    const router = new FakeRouter();
    const read = vi.fn(async () => null);
    const provider = startTransport(router, read);

    await expect(provider.fetchUnregisteredAuthority(PROVIDER_PEER, SCOPE)).resolves.toBeNull();
    await expect(router.invoke(
      RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1,
      encodeRfc64UnregisteredAuthorityQueryV1({ kind: RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1, ...SCOPE }),
    )).resolves.toEqual(Uint8Array.of(0));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('denies without touching the store when serving is switched off, and the requester fails closed', async () => {
    const router = new FakeRouter();
    const read = vi.fn(async () => mintSeedBytes());
    const provider = startTransport(router, read, () => false);

    await expect(router.invoke(
      RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1,
      encodeRfc64UnregisteredAuthorityQueryV1({ kind: RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1, ...SCOPE }),
    )).resolves.toEqual(Uint8Array.of(2));
    await expectCode(
      provider.fetchUnregisteredAuthority(PROVIDER_PEER, SCOPE),
      'unregistered-authority-denied',
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a non-wallet-namespaced id on both sides before any I/O', async () => {
    const router = new FakeRouter();
    const read = vi.fn(async () => mintSeedBytes());
    const provider = startTransport(router, read);

    await expectCode(
      provider.fetchUnregisteredAuthority(PROVIDER_PEER, {
        networkId: NETWORK_ID,
        contextGraphId: NON_WALLET_CONTEXT_GRAPH_ID,
      }),
      'unregistered-authority-wire',
    );
    expect(router.sends).toHaveLength(0);

    const crafted = encodeRfc64FlatCanonicalJsonV1({
      kind: RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1,
      networkId: NETWORK_ID,
      contextGraphId: NON_WALLET_CONTEXT_GRAPH_ID,
    }, RFC64_UNREGISTERED_AUTHORITY_QUERY_MAX_BYTES_V1);
    await expectCode(
      router.invoke(RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1, crafted),
      'unregistered-authority-wire',
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects oversize, trailing-byte and invalid-status responses', async () => {
    const seed = await mintSeedBytes();
    let response: Uint8Array = Uint8Array.of(0);
    const router = new FakeRouter(async () => response);
    const requester = startTransport(router, async () => null);

    // Exactly one byte over the response cap fails on SIZE (the same code as
    // a malformed payload, so the message is what proves the cap is live).
    response = new Uint8Array(RFC64_UNREGISTERED_AUTHORITY_RESPONSE_MAX_BYTES_V1 + 1).fill(1);
    await expectCodeAndMessage(
      requester.fetchUnregisteredAuthority(PROVIDER_PEER, SCOPE),
      'unregistered-authority-wire',
      /response is empty or oversized/u,
    );
    // A found frame carrying a seed one byte over the seed cap is refused by
    // the seed bound before any parse, not by the response frame.
    response = encodeRfc64FoundStatusResponseV1(new Uint8Array(RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1).fill(0x20));
    await expectCodeAndMessage(
      requester.fetchUnregisteredAuthority(PROVIDER_PEER, SCOPE),
      'unregistered-authority-wire',
      /not a canonical signed Context Graph policy envelope/u,
    );
    response = Uint8Array.of(0, 0);
    await expectCode(requester.fetchUnregisteredAuthority(PROVIDER_PEER, SCOPE), 'unregistered-authority-wire');
    response = Uint8Array.of(7, ...seed);
    await expectCode(requester.fetchUnregisteredAuthority(PROVIDER_PEER, SCOPE), 'unregistered-authority-wire');
    response = new Uint8Array(0);
    await expectCode(requester.fetchUnregisteredAuthority(PROVIDER_PEER, SCOPE), 'unregistered-authority-wire');
    // A found frame whose payload is not a canonical envelope is a wire fault.
    response = encodeRfc64FoundStatusResponseV1(new TextEncoder().encode('{"not":"canonical envelope"}'));
    await expectCode(requester.fetchUnregisteredAuthority(PROVIDER_PEER, SCOPE), 'unregistered-authority-wire');
  });

  it('rejects forged, wrong-owner, cross-graph, wrong-network and private seeds at the requester', async () => {
    const cases: Array<[string, Uint8Array, Rfc64UnregisteredAuthorityTransportErrorV1['code']]> = [
      ['forged signature', await forgeSignature(await mintSeedBytes()), 'unregistered-authority-signature'],
      [
        'wrong owner for the victim namespace',
        await mintSeedBytes({ wallet: ATTACKER_WALLET, owner: ATTACKER, contextGraphId: CONTEXT_GRAPH_ID }),
        'unregistered-authority-mismatch',
      ],
      ['cross-graph replay', await mintSeedBytes({ contextGraphId: OTHER_CONTEXT_GRAPH_ID }), 'unregistered-authority-mismatch'],
      ['wrong network', await mintSeedBytes({ networkId: OTHER_NETWORK_ID }), 'unregistered-authority-mismatch'],
      ['private policy', await mintSeedBytes({ accessPolicy: 1 }), 'unregistered-authority-mismatch'],
    ];
    for (const [label, bytes, code] of cases) {
      // Raw responder: bypass the provider-side check to prove the requester
      // alone refuses the payload.
      const router = new FakeRouter(async () => encodeRfc64FoundStatusResponseV1(bytes));
      const requester = startTransport(router, async () => null);
      await expect(
        requester.fetchUnregisteredAuthority(PROVIDER_PEER, SCOPE),
        label,
      ).rejects.toSatisfy((error: unknown) =>
        error instanceof Rfc64UnregisteredAuthorityTransportErrorV1 && error.code === code);
      requester.stop();
    }
  });

  it('never serves stored bytes that fail authentication (fail closed on the provider)', async () => {
    const forged = await forgeSignature(await mintSeedBytes());
    const router = new FakeRouter();
    startTransport(router, async () => forged);

    await expectCode(
      router.invoke(
        RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1,
        encodeRfc64UnregisteredAuthorityQueryV1({ kind: RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1, ...SCOPE }),
      ),
      'unregistered-authority-signature',
    );
    const attackerRouter = new FakeRouter();
    startTransport(attackerRouter, async () => mintSeedBytes({
      wallet: ATTACKER_WALLET,
      owner: ATTACKER,
      contextGraphId: CONTEXT_GRAPH_ID,
    }));
    await expectCode(
      attackerRouter.invoke(
        RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1,
        encodeRfc64UnregisteredAuthorityQueryV1({ kind: RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1, ...SCOPE }),
      ),
      'unregistered-authority-mismatch',
    );
  });

  it('honours the handler abort signal and a store failure without serving', async () => {
    const router = new FakeRouter();
    const read = vi.fn(async () => mintSeedBytes());
    startTransport(router, read);
    const aborted = AbortSignal.abort(new Error('stream closed by peer'));

    await expect(router.invoke(
      RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1,
      encodeRfc64UnregisteredAuthorityQueryV1({ kind: RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1, ...SCOPE }),
      REQUESTER_PEER,
      aborted,
    )).rejects.toThrow(/stream closed by peer/u);
    expect(read).not.toHaveBeenCalled();

    const failingRouter = new FakeRouter();
    startTransport(failingRouter, async () => { throw new Error('sqlite is closed'); });
    await expectCode(
      failingRouter.invoke(
        RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1,
        encodeRfc64UnregisteredAuthorityQueryV1({ kind: RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1, ...SCOPE }),
      ),
      'unregistered-authority-state',
    );
  });

  it('refuses to fetch or serve before start and after stop', async () => {
    const router = new FakeRouter();
    const transport = new Rfc64UnregisteredAuthorityTransportV1(router.asProtocolRouter(), {
      readSeedEnvelopeBytes: async () => null,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    await expectCode(transport.fetchUnregisteredAuthority(PROVIDER_PEER, SCOPE), 'unregistered-authority-state');
    transport.start();
    expect(router.handlers.has(RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1)).toBe(true);
    transport.stop();
    expect(router.handlers.has(RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1)).toBe(false);
    await expectCode(transport.fetchUnregisteredAuthority(PROVIDER_PEER, SCOPE), 'unregistered-authority-state');
  });

  it('shares one verifier: authenticate accepts the exact seed and nothing else', async () => {
    const seed = await mintSeedBytes();
    const verified = await authenticateRfc64UnregisteredAuthorityEnvelopeV1(
      seed,
      SCOPE,
      verifyControlEnvelopeIssuerSignatureV1,
    );
    expect(verified.ownerAddress).toBe(OWNER);
    await expectCode(
      authenticateRfc64UnregisteredAuthorityEnvelopeV1(
        seed,
        { networkId: NETWORK_ID, contextGraphId: NON_WALLET_CONTEXT_GRAPH_ID },
        verifyControlEnvelopeIssuerSignatureV1,
      ),
      'unregistered-authority-wire',
    );
    await expectCodeAndMessage(
      authenticateRfc64UnregisteredAuthorityEnvelopeV1(
        new Uint8Array(RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1 + 1),
        SCOPE,
        verifyControlEnvelopeIssuerSignatureV1,
      ),
      'unregistered-authority-wire',
      /seed bytes are empty or oversized/u,
    );
    await expectCodeAndMessage(
      authenticateRfc64UnregisteredAuthorityEnvelopeV1(
        new Uint8Array(0),
        SCOPE,
        verifyControlEnvelopeIssuerSignatureV1,
      ),
      'unregistered-authority-wire',
      /seed bytes are empty or oversized/u,
    );
    // Exactly at the cap the bound passes and the canonical parse decides.
    await expectCodeAndMessage(
      authenticateRfc64UnregisteredAuthorityEnvelopeV1(
        new Uint8Array(RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1).fill(0x20),
        SCOPE,
        verifyControlEnvelopeIssuerSignatureV1,
      ),
      'unregistered-authority-wire',
      /not a canonical signed Context Graph policy envelope/u,
    );
  });

  it('binds the injected verifier proof to the exact envelope', async () => {
    const seed = await mintSeedBytes();
    const donor = parseCanonicalSignedContextGraphPolicyEnvelopeV1(
      await mintSeedBytes({ contextGraphId: OTHER_CONTEXT_GRAPH_ID }),
    );
    const donorProof = await verifyControlEnvelopeIssuerSignatureV1(donor);
    // A verifier answering with a proof it minted for ANOTHER envelope.
    await expectCodeAndMessage(
      authenticateRfc64UnregisteredAuthorityEnvelopeV1(seed, SCOPE, async () => donorProof),
      'unregistered-authority-signature',
      /not bound to the exact seed envelope/u,
    );
    // A verifier answering with an object the verifier never minted.
    await expectCodeAndMessage(
      authenticateRfc64UnregisteredAuthorityEnvelopeV1(seed, SCOPE, async () => ({}) as never),
      'unregistered-authority-signature',
      /not minted by the verifier/u,
    );
    // A verifier that throws is a signature failure carrying its cause.
    await expect(authenticateRfc64UnregisteredAuthorityEnvelopeV1(
      seed,
      SCOPE,
      async () => { throw new Error('recovery failed'); },
    )).rejects.toSatisfy((error: unknown) =>
      error instanceof Rfc64UnregisteredAuthorityTransportErrorV1
      && error.code === 'unregistered-authority-signature'
      && /issuer signature failed/u.test(error.message)
      && (error.cause as Error | undefined)?.cause instanceof Error
      && /recovery failed/u.test(String(((error.cause as Error).cause as Error).message)));
    // An abort raised while verifying surfaces as the abort, never as a code.
    const controller = new AbortController();
    await expect(authenticateRfc64UnregisteredAuthorityEnvelopeV1(
      seed,
      SCOPE,
      async () => {
        controller.abort(new Error('bootstrap budget exhausted'));
        throw new Error('verifier torn down');
      },
      controller.signal,
    )).rejects.toThrow(/bootstrap budget exhausted/u);
  });

  it('rejects malformed queries and peer ids at the handler and requester boundaries', async () => {
    const router = new FakeRouter();
    const read = vi.fn(async () => mintSeedBytes());
    const transport = startTransport(router, read);

    const wrongKind = encodeRfc64FlatCanonicalJsonV1({
      kind: 'rfc64-other-query-v1',
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
    }, RFC64_UNREGISTERED_AUTHORITY_QUERY_MAX_BYTES_V1);
    await expectCodeAndMessage(
      router.invoke(RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1, wrongKind),
      'unregistered-authority-wire',
      /query kind must be rfc64-unregistered-authority-query-v1/u,
    );
    const emptyNetwork = encodeRfc64FlatCanonicalJsonV1({
      kind: RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1,
      networkId: '',
      contextGraphId: CONTEXT_GRAPH_ID,
    }, RFC64_UNREGISTERED_AUTHORITY_QUERY_MAX_BYTES_V1);
    await expectCodeAndMessage(
      router.invoke(RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1, emptyNetwork),
      'unregistered-authority-wire',
      /scope contains an invalid scalar/u,
    );
    const validQuery = encodeRfc64UnregisteredAuthorityQueryV1({
      kind: RFC64_UNREGISTERED_AUTHORITY_QUERY_KIND_V1,
      ...SCOPE,
    });
    await expectCodeAndMessage(
      router.invoke(RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1, validQuery, ''),
      'unregistered-authority-input',
      /remotePeerId is empty, oversized, or noncanonical/u,
    );
    await expectCodeAndMessage(
      transport.fetchUnregisteredAuthority(42 as never, SCOPE),
      'unregistered-authority-input',
      /remotePeerId must be a string/u,
    );
    await expectCodeAndMessage(
      transport.fetchUnregisteredAuthority(PROVIDER_PEER, { networkId: '' as NetworkIdV1, contextGraphId: CONTEXT_GRAPH_ID }),
      'unregistered-authority-wire',
      /scope contains an invalid scalar/u,
    );
    // A non-Error abort reason is wrapped so the handler still fails closed.
    await expect(router.invoke(
      RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1,
      validQuery,
      REQUESTER_PEER,
      AbortSignal.abort('peer went away'),
    )).rejects.toSatisfy((error: unknown) =>
      error instanceof Error
      && /request was aborted/u.test(error.message)
      && error.cause === 'peer went away');
    expect(read).not.toHaveBeenCalled();
    expect(router.sends).toHaveLength(0);
  });

  it('refuses construction without its collaborators and rolls back a failed registration', () => {
    const router = new FakeRouter();
    expect(() => new Rfc64UnregisteredAuthorityTransportV1(router.asProtocolRouter(), {
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    } as never)).toThrow(/readSeedEnvelopeBytes must be a function/u);
    expect(() => new Rfc64UnregisteredAuthorityTransportV1(router.asProtocolRouter(), {
      readSeedEnvelopeBytes: async () => null,
    } as never)).toThrow(/verifyIssuerSignature must be a function/u);
    expect(() => new Rfc64UnregisteredAuthorityTransportV1(router.asProtocolRouter(), {
      readSeedEnvelopeBytes: async () => null,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      isServingAllowed: true as never,
    })).toThrow(/isServingAllowed must be a function when configured/u);

    const refusing = new FakeRouter();
    const unregister = vi.spyOn(refusing, 'unregister');
    vi.spyOn(refusing, 'register').mockImplementation(() => {
      throw new Error('router is closing');
    });
    const transport = new Rfc64UnregisteredAuthorityTransportV1(refusing.asProtocolRouter(), {
      readSeedEnvelopeBytes: async () => null,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    expect(() => transport.start()).toThrow(/router is closing/u);
    expect(transport.started).toBe(false);
    expect(unregister).toHaveBeenCalledWith(RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1);
    // Idempotent lifecycle: a second start after success is a no-op, as is a
    // stop when never started.
    const transportB = startTransport(new FakeRouter(), async () => null);
    transportB.start();
    expect(transportB.started).toBe(true);
    transportB.stop();
    transportB.stop();
    expect(transportB.started).toBe(false);
  });
});

describe('RFC-64 unregistered-authority seed fan-out (service)', () => {
  function controlObjects() {
    return {
      namespaceDurability: 'posix-hardlink-no-replace-directory-fsync-v1',
      getVerifiedObject: vi.fn(async () => null),
      getVerifiedObjectByDigest: vi.fn(async () => null),
      stageVerifiedObjects: vi.fn(async () => ({
        durable: true,
        namespaceDurability: 'posix-hardlink-no-replace-directory-fsync-v1',
        objects: [],
      })),
    } as never;
  }

  function startService(
    router: FakeRouter,
    readSeedEnvelopeBytes: (scope: Rfc64UnregisteredAuthorityScopeV1) => Promise<Uint8Array | null>,
    localPeerId?: string,
  ): Rfc64PublicCatalogServiceV1 {
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: controlObjects(),
      ...(localPeerId === undefined ? {} : { localPeerId }),
      unregisteredAuthority: { readSeedEnvelopeBytes },
      transportTimeoutMs: 2_000,
    });
    services.push(service);
    service.start();
    return service;
  }

  it('returns the first verified seed, skipping not-found and forged providers', async () => {
    const seed = await mintSeedBytes();
    const forged = await forgeSignature(seed);
    const router = new FakeRouter(async (peerId) => {
      if (peerId === 'peer-a') return Uint8Array.of(0);
      if (peerId === 'peer-b') return encodeRfc64FoundStatusResponseV1(forged);
      if (peerId === 'peer-c') return encodeRfc64FoundStatusResponseV1(seed);
      throw new Error(`dial failed: ${peerId}`);
    });
    const service = startService(router, async () => null, 'peer-self');

    const fetched = await service.fetchUnregisteredAuthorityFromPeers({
      ...SCOPE,
      peerIds: ['peer-a', 'peer-b', 'peer-self', 'peer-c', 'peer-dead'],
    });

    expect(fetched?.remotePeerId).toBe('peer-c');
    expect(Buffer.from(fetched!.seed.canonicalBytes).equals(Buffer.from(seed))).toBe(true);
    // Self is never dialled; every other candidate is asked at most once and
    // all sends carry the short per-peer deadline.
    const asked = router.sends.map((send) => send.peerId);
    expect(asked).not.toContain('peer-self');
    expect(new Set(asked).size).toBe(asked.length);
    for (const send of router.sends) {
      expect(send.options?.timeoutMs).toBe(2_000);
      expect(send.options?.signal).toBeInstanceOf(AbortSignal);
      expect(send.options?.maxReadBytes).toBe(RFC64_UNREGISTERED_AUTHORITY_RESPONSE_MAX_BYTES_V1);
    }
  });

  it('lets the first verified seed win while a hanging sibling is aborted, and skips denials', async () => {
    const seed = await mintSeedBytes();
    let hangSignal: AbortSignal | undefined;
    let markHangAborted: (() => void) | undefined;
    // Resolves once the fan-out aborts the hanging request.
    const hung = new Promise<void>((resolve) => { markHangAborted = resolve; });
    const router = new FakeRouter(async (peerId, _protocol, _data, options) => {
      if (peerId === 'peer-hang') {
        hangSignal = options?.signal;
        return new Promise<Uint8Array>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            markHangAborted?.();
            reject(options.signal!.reason);
          }, { once: true });
        });
      }
      if (peerId === 'peer-denied') return Uint8Array.of(2);
      if (peerId === 'peer-seed') return encodeRfc64FoundStatusResponseV1(seed);
      throw new Error(`unexpected peer ${peerId}`);
    });
    const service = startService(router, async () => null, 'peer-self');

    const fetched = await service.fetchUnregisteredAuthorityFromPeers({
      ...SCOPE,
      peerIds: ['peer-hang', 'peer-denied', 'peer-seed'],
    });

    expect(fetched?.remotePeerId).toBe('peer-seed');
    expect(Buffer.from(fetched!.seed.canonicalBytes).equals(Buffer.from(seed))).toBe(true);
    await hung;
    expect(hangSignal?.aborted).toBe(true);
    expect(router.sends.map((send) => send.peerId).sort()).toEqual(['peer-denied', 'peer-hang', 'peer-seed']);
  });

  it('stops its seed endpoint again when a later protocol registration fails during start', () => {
    const router = new FakeRouter();
    const register = router.register.bind(router);
    vi.spyOn(router, 'register').mockImplementation((protocolId, handler) => {
      if (protocolId === RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_PROTOCOL_V1) {
        throw new Error('announcement protocol refused');
      }
      register(protocolId, handler);
    });
    const service = new Rfc64PublicCatalogServiceV1({
      router: router.asProtocolRouter(),
      controlObjects: controlObjects(),
      unregisteredAuthority: { readSeedEnvelopeBytes: async () => null },
    });
    services.push(service);

    expect(() => service.start()).toThrow(/announcement protocol refused/u);
    // The seed endpoint registered first and was rolled back with the rest.
    expect(router.handlers.has(RFC64_UNREGISTERED_AUTHORITY_PROTOCOL_V1)).toBe(false);
  });

  it('resolves null when every peer misses, and caps the fan-out at the peer bound', async () => {
    const router = new FakeRouter(async () => Uint8Array.of(0));
    const service = startService(router, async () => null);
    const many = Array.from(
      { length: RFC64_UNREGISTERED_AUTHORITY_MAX_FANOUT_PEERS_V1 + 5 },
      (_, index) => `peer-${index}`,
    );

    await expect(service.fetchUnregisteredAuthorityFromPeers({ ...SCOPE, peerIds: many }))
      .resolves.toBeNull();
    expect(router.sends).toHaveLength(RFC64_UNREGISTERED_AUTHORITY_MAX_FANOUT_PEERS_V1);
    expect(RFC64_UNREGISTERED_AUTHORITY_FANOUT_CONCURRENCY_V1).toBeLessThanOrEqual(
      RFC64_UNREGISTERED_AUTHORITY_MAX_FANOUT_PEERS_V1,
    );
    await expect(service.fetchUnregisteredAuthorityFromPeers({ ...SCOPE, peerIds: [] }))
      .resolves.toBeNull();
  });

  it('propagates a caller abort and stops asking further peers', async () => {
    const controller = new AbortController();
    const router = new FakeRouter(async (_peerId, _protocol, _data, options) =>
      new Promise<Uint8Array>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
      }));
    const service = startService(router, async () => null);
    const pending = service.fetchUnregisteredAuthorityFromPeers({
      ...SCOPE,
      peerIds: ['peer-a', 'peer-b'],
      signal: controller.signal,
    });
    controller.abort(new Error('bootstrap budget exhausted'));

    await expect(pending).rejects.toThrow(/bootstrap budget exhausted/u);
  });

  it('is unavailable when the service was not configured with the seed exchange', async () => {
    const service = new Rfc64PublicCatalogServiceV1({
      router: new FakeRouter().asProtocolRouter(),
      controlObjects: controlObjects(),
    });
    services.push(service);
    service.start();
    await expect(service.fetchUnregisteredAuthorityFromPeers({ ...SCOPE, peerIds: ['peer-a'] }))
      .rejects.toThrow(/not configured/u);
  });
});

describe('RFC-64 unregistered-authority seed transport (real libp2p)', () => {
  async function startNode(): Promise<DKGNode> {
    const node = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    nodes.push(node);
    await node.start();
    return node;
  }

  async function connect(from: DKGNode, to: DKGNode): Promise<void> {
    const address = to.multiaddrs.find((candidate) => candidate.includes('/tcp/'));
    if (address === undefined) throw new Error('test node has no TCP multiaddr');
    await from.libp2p.dial(multiaddr(address));
  }

  it('fetches and verifies a seed over TCP without any accepted policy on either side', async () => {
    temporaryDirectories.push(await mkdtemp(join(tmpdir(), 'dkg-rfc64-seed-fetch-')));
    const [providerNode, requesterNode] = await Promise.all([startNode(), startNode()]);
    await connect(requesterNode, providerNode);
    const seed = await mintSeedBytes();
    const read = vi.fn(async (scope: Rfc64UnregisteredAuthorityScopeV1) =>
      scope.contextGraphId === CONTEXT_GRAPH_ID ? seed : null);

    const provider = new Rfc64UnregisteredAuthorityTransportV1(new ProtocolRouter(providerNode), {
      readSeedEnvelopeBytes: read,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    const requester = new Rfc64UnregisteredAuthorityTransportV1(new ProtocolRouter(requesterNode), {
      readSeedEnvelopeBytes: async () => null,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    transports.push(provider, requester);
    provider.start();
    requester.start();

    const fetched = await requester.fetchUnregisteredAuthority(
      providerNode.peerId,
      SCOPE,
      { timeoutMs: 4_000 },
    );
    expect(fetched?.ownerAddress).toBe(OWNER);
    expect(Buffer.from(fetched!.canonicalBytes).equals(Buffer.from(seed))).toBe(true);
    expect(read).toHaveBeenCalledOnce();

    await expect(requester.fetchUnregisteredAuthority(
      providerNode.peerId,
      { networkId: NETWORK_ID, contextGraphId: OTHER_CONTEXT_GRAPH_ID },
      { timeoutMs: 4_000 },
    )).resolves.toBeNull();
  }, 30_000);
});
