// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalizeSignedContextGraphPolicyEnvelopeBytesV1,
  contextGraphDataGraphUri,
  parseCanonicalSignedContextGraphPolicyEnvelopeV1,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

import { Rfc64SeedStoreMethods } from '../src/dkg-agent-rfc64-seed-store.js';
import { openRfc64PersistenceV1 } from '../src/rfc64/persistence-v1.js';
import {
  RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1,
} from '../src/rfc64/unregistered-authority-seed-store-v1.js';
import {
  RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1,
  loadRfc64UnregisteredReplicaAuthorityV1,
  mintRfc64UnregisteredReplicaAuthorityEvidenceV1,
  mintRfc64UnregisteredReplicaAuthoritySeedV1,
} from '../src/rfc64/unregistered-replica-authority-v1.js';

const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const OWNER_WALLET = new ethers.Wallet(`0x${'71'.repeat(32)}`);
const OWNER = OWNER_WALLET.address.toLowerCase() as EvmAddressV1;
const ATTACKER_WALLET = new ethers.Wallet(`0x${'72'.repeat(32)}`);
const ATTACKER = ATTACKER_WALLET.address.toLowerCase() as EvmAddressV1;
const CONTEXT_GRAPH_ID = `${OWNER}/seed-contract` as ContextGraphIdV1;
const OTHER_CONTEXT_GRAPH_ID = `${OWNER}/other` as ContextGraphIdV1;
const ONTOLOGY_SOURCE = 'agent.rfc64.unregisteredReplicaAuthority';

type SeedStore = Awaited<ReturnType<typeof openRfc64PersistenceV1>>['unregisteredAuthoritySeeds'];
type SeedAgent = Rfc64SeedStoreMethods & {
  readonly log: { warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
  readonly persistence: Awaited<ReturnType<typeof openRfc64PersistenceV1>> | undefined;
  /** Call-counting wrappers around the real (frozen) seed store facade. */
  readonly seeds: { read: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
};

const roots: string[] = [];
const persistences: Array<Awaited<ReturnType<typeof openRfc64PersistenceV1>>> = [];

afterEach(async () => {
  for (const persistence of persistences.splice(0)) {
    if (!persistence.closed) await persistence.close();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

/**
 * The contract methods depend only on `rfc64PersistenceV1` and `log`, so the
 * mixin prototype plus those two fields is a faithful stand-in for a DKGAgent
 * (the same shape other RFC-64 mixin tests use).
 */
async function createSeedAgent(options: { readonly persistence?: boolean } = {}): Promise<SeedAgent> {
  let persistence: Awaited<ReturnType<typeof openRfc64PersistenceV1>> | undefined;
  if (options.persistence !== false) {
    const dataDir = await mkdtemp(join(tmpdir(), 'rfc64-seed-agent-'));
    roots.push(dataDir);
    persistence = await openRfc64PersistenceV1(dataDir, {
      yieldAfterPurgeBatch: async () => undefined,
    });
    persistences.push(persistence);
  }
  const agent = Object.create(Rfc64SeedStoreMethods.prototype) as SeedAgent;
  // The persistence facade is frozen, so count calls through a thin wrapper
  // that the agent sees as its `unregisteredAuthoritySeeds`.
  const seeds = {
    read: vi.fn((...input: Parameters<SeedStore['read']>) =>
      persistence!.unregisteredAuthoritySeeds.read(...input)),
    put: vi.fn((...input: Parameters<SeedStore['put']>) =>
      persistence!.unregisteredAuthoritySeeds.put(...input)),
  };
  Reflect.set(
    agent,
    'rfc64PersistenceV1',
    persistence === undefined ? undefined : { ...persistence, unregisteredAuthoritySeeds: seeds },
  );
  Reflect.set(agent, 'log', { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() });
  Reflect.set(agent, 'persistence', persistence);
  Reflect.set(agent, 'seeds', seeds);
  return agent;
}

async function mintSeed(input: Readonly<{
  readonly wallet?: ethers.Wallet;
  readonly owner?: EvmAddressV1;
  readonly contextGraphId?: ContextGraphIdV1;
  readonly networkId?: NetworkIdV1;
  readonly accessPolicy?: 0 | 1;
  readonly publishPolicy?: 0 | 1;
}> = {}) {
  const wallet = input.wallet ?? OWNER_WALLET;
  const owner = input.owner ?? OWNER;
  return mintRfc64UnregisteredReplicaAuthoritySeedV1({
    networkId: input.networkId ?? NETWORK_ID,
    contextGraphId: input.contextGraphId ?? CONTEXT_GRAPH_ID,
    ownerAddress: owner,
    accessPolicy: input.accessPolicy ?? 0,
    publishPolicy: input.publishPolicy ?? 1,
    publishAuthorityAccountId: '0',
    memberAddresses: [],
    rosterVersion: '0',
    signer: {
      issuer: owner,
      signDigest: (digest) => wallet.signMessage(digest),
    },
  });
}

function ontologyStore(literals: readonly string[]): TripleStore & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (_sparql: string, options?: { source?: string }) => {
    if (options?.source !== ONTOLOGY_SOURCE) throw new Error(`unexpected query source ${options?.source}`);
    return {
      type: 'bindings' as const,
      bindings: literals.map((evidence) => ({ evidence: `"${evidence}"` })),
    };
  });
  return { query } as unknown as TripleStore & { query: ReturnType<typeof vi.fn> };
}

describe('Rfc64SeedStoreMethods contract', () => {
  it('persists a verified seed and reads the exact canonical bytes back', async () => {
    const agent = await createSeedAgent();
    const seed = await mintSeed();

    await expect(agent.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
    })).resolves.toBeNull();
    await agent.persistVerifiedRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      canonicalEnvelopeBytes: seed.canonicalEnvelopeBytes,
    });
    // Idempotent for identical bytes.
    await agent.persistVerifiedRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      canonicalEnvelopeBytes: Uint8Array.from(seed.canonicalEnvelopeBytes),
    });
    const stored = await agent.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
    });
    expect(stored).not.toBeNull();
    expect(Buffer.from(stored!).equals(Buffer.from(seed.canonicalEnvelopeBytes))).toBe(true);
    // The base64url ontology literal decodes to the same bytes.
    expect(Buffer.from(seed.evidence, 'base64url').equals(Buffer.from(stored!))).toBe(true);
    // Read is CG-scoped.
    await expect(agent.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: OTHER_CONTEXT_GRAPH_ID,
    })).resolves.toBeNull();
  });

  it('fails closed on forged, wrong-wallet, wrong-network, cross-graph, private and oversize seeds', async () => {
    const agent = await createSeedAgent();
    const valid = await mintSeed();
    // Same structure and issuer, canonical bytes, but the signature belongs to
    // another object: only the signature check can refuse this.
    const donor = parseCanonicalSignedContextGraphPolicyEnvelopeV1(
      (await mintSeed({ contextGraphId: OTHER_CONTEXT_GRAPH_ID })).canonicalEnvelopeBytes,
    );
    const forged = canonicalizeSignedContextGraphPolicyEnvelopeBytesV1({
      ...valid.envelope,
      signature: donor.signature,
    });
    const wrongWallet = await mintSeed({ wallet: ATTACKER_WALLET, owner: ATTACKER });
    const wrongNetwork = await mintSeed({ networkId: 'otp:1' as NetworkIdV1 });
    const crossGraph = await mintSeed({ contextGraphId: OTHER_CONTEXT_GRAPH_ID });
    const privatePolicy = await mintSeed({ accessPolicy: 1 });

    const rejected: ReadonlyArray<readonly [string, Uint8Array, RegExp]> = [
      ['forged signature', forged, /signature/u],
      ['not canonical', new TextEncoder().encode('{"not":"an envelope"}'), /canonical/u],
      ['wrong wallet', wrongWallet.canonicalEnvelopeBytes, /wallet owner/u],
      ['wrong network', wrongNetwork.canonicalEnvelopeBytes, /different network or Context Graph/u],
      ['cross-graph replay', crossGraph.canonicalEnvelopeBytes, /different network or Context Graph/u],
      ['private policy', privatePolicy.canonicalEnvelopeBytes, /generation-0 public owner policy/u],
      ['oversize', new Uint8Array(RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1 + 1), /byte bound/u],
      ['empty', new Uint8Array(0), /byte bound/u],
    ];
    for (const [label, bytes, message] of rejected) {
      await expect(
        agent.persistVerifiedRfc64UnregisteredAuthoritySeedV1({
          networkId: NETWORK_ID,
          contextGraphId: CONTEXT_GRAPH_ID,
          canonicalEnvelopeBytes: bytes,
        }),
        label,
      ).rejects.toThrow(message);
    }
    // A signature must never self-assign a non-wallet-namespaced name.
    await expect(agent.persistVerifiedRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: 'global-name',
      canonicalEnvelopeBytes: valid.canonicalEnvelopeBytes,
    })).rejects.toThrow(/wallet-namespaced/u);
    await expect(agent.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
    })).resolves.toBeNull();
    await expect(agent.persistence!.unregisteredAuthoritySeeds.read(NETWORK_ID, CONTEXT_GRAPH_ID))
      .resolves.toBeNull();
  });

  it('refuses a second signed generation for the same graph and keeps the first', async () => {
    const agent = await createSeedAgent();
    const first = await mintSeed({ publishPolicy: 1 });
    const second = await mintSeed({ publishPolicy: 0 });
    await agent.persistVerifiedRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      canonicalEnvelopeBytes: first.canonicalEnvelopeBytes,
    });
    await expect(agent.persistVerifiedRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      canonicalEnvelopeBytes: second.canonicalEnvelopeBytes,
    })).rejects.toMatchObject({ code: 'seed-conflict' });
    const stored = await agent.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
    });
    expect(Buffer.from(stored!).equals(Buffer.from(first.canonicalEnvelopeBytes))).toBe(true);
  });

  it('returns null for absent, non-wallet-namespaced and persistence-less reads; persist needs a store', async () => {
    const withStore = await createSeedAgent();
    const read = withStore.seeds.read;
    await expect(withStore.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
    })).resolves.toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    // Non-wallet-namespaced ids never touch the store.
    await expect(withStore.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: 'global-name',
    })).resolves.toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    await expect(withStore.readRfc64UnregisteredAuthoritySeedV1({
      networkId: '',
      contextGraphId: CONTEXT_GRAPH_ID,
    })).rejects.toThrow();

    const withoutStore = await createSeedAgent({ persistence: false });
    const seed = await mintSeed();
    await expect(withoutStore.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
    })).resolves.toBeNull();
    await expect(withoutStore.persistVerifiedRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      canonicalEnvelopeBytes: seed.canonicalEnvelopeBytes,
    })).rejects.toMatchObject({ code: 'seed-store-unavailable' });
    // The loader adapter contains that failure instead of surfacing it.
    await expect(withoutStore.rfc64UnregisteredAuthoritySeedAccessV1().persist({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      canonicalEnvelopeBytes: seed.canonicalEnvelopeBytes,
    })).resolves.toBeUndefined();
  });

  it('honours an aborted signal before touching verification or the store', async () => {
    const agent = await createSeedAgent();
    const seed = await mintSeed();
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(agent.persistVerifiedRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      canonicalEnvelopeBytes: seed.canonicalEnvelopeBytes,
      signal: controller.signal,
    })).rejects.toThrow('stop');
    await expect(agent.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      signal: controller.signal,
    })).rejects.toThrow('stop');
    await expect(agent.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
    })).resolves.toBeNull();
  });
});

describe('loadRfc64UnregisteredReplicaAuthorityV1 with the keyed seed store', () => {
  it('prefers the keyed store and never issues the ontology scan when a seed is stored', async () => {
    const agent = await createSeedAgent();
    const seed = await mintSeed();
    await agent.persistVerifiedRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      canonicalEnvelopeBytes: seed.canonicalEnvelopeBytes,
    });
    const store = ontologyStore([seed.evidence]);

    const authority = await loadRfc64UnregisteredReplicaAuthorityV1({
      store,
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      seeds: agent.rfc64UnregisteredAuthoritySeedAccessV1(),
    });
    expect(authority).toMatchObject({
      source: 'owner-signed-unregistered',
      policyDigest: seed.policyDigest,
      roster: null,
      ownerAddress: OWNER,
      policy: { contextGraphId: CONTEXT_GRAPH_ID, networkId: NETWORK_ID, accessPolicy: 0 },
    });
    expect(store.query).not.toHaveBeenCalled();
  });

  it('falls back to the deprecated ontology carrier on a store miss and writes the seed through', async () => {
    const agent = await createSeedAgent();
    const seed = await mintSeed();
    const store = ontologyStore([seed.evidence]);
    const seeds = agent.rfc64UnregisteredAuthoritySeedAccessV1();

    const first = await loadRfc64UnregisteredReplicaAuthorityV1({
      store,
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      seeds,
    });
    expect(first).toMatchObject({ source: 'owner-signed-unregistered', policyDigest: seed.policyDigest });
    expect(store.query).toHaveBeenCalledTimes(1);
    expect(store.query.mock.calls[0]?.[0]).toContain(RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1);
    expect(store.query.mock.calls[0]?.[0]).toContain(contextGraphDataGraphUri(CONTEXT_GRAPH_ID));
    const stored = await agent.readRfc64UnregisteredAuthoritySeedV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
    });
    expect(Buffer.from(stored!).equals(Buffer.from(seed.canonicalEnvelopeBytes))).toBe(true);

    // The next read is a point lookup.
    const second = await loadRfc64UnregisteredReplicaAuthorityV1({
      store,
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      seeds,
    });
    expect(second?.policyDigest).toBe(seed.policyDigest);
    expect(store.query).toHaveBeenCalledTimes(1);
  });

  it('keeps ontology-only behaviour without a seed store and returns null when nothing authenticates', async () => {
    const seed = await mintSeed();
    const wrongWallet = await mintRfc64UnregisteredReplicaAuthorityEvidenceV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: ATTACKER,
      accessPolicy: 0,
      publishPolicy: 1,
      publishAuthorityAccountId: '0',
      memberAddresses: [],
      rosterVersion: '0',
      signer: { issuer: ATTACKER, signDigest: (digest) => ATTACKER_WALLET.signMessage(digest) },
    });

    await expect(loadRfc64UnregisteredReplicaAuthorityV1({
      store: ontologyStore([seed.evidence]),
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
    })).resolves.toMatchObject({ policyDigest: seed.policyDigest });
    await expect(loadRfc64UnregisteredReplicaAuthorityV1({
      store: ontologyStore([wrongWallet]),
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
    })).resolves.toBeNull();
    await expect(loadRfc64UnregisteredReplicaAuthorityV1({
      store: ontologyStore([]),
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
    })).resolves.toBeNull();
    // Two distinct authenticated generations remain a hard conflict.
    const other = await mintSeed({ publishPolicy: 0 });
    await expect(loadRfc64UnregisteredReplicaAuthorityV1({
      store: ontologyStore([seed.evidence, other.evidence]),
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
    })).rejects.toThrow(/conflicting signed generations/u);
  });

  it('never touches the store or the ontology for a non-wallet-namespaced graph', async () => {
    const agent = await createSeedAgent();
    const read = agent.seeds.read;
    const store = ontologyStore([]);
    await expect(loadRfc64UnregisteredReplicaAuthorityV1({
      store,
      networkId: NETWORK_ID,
      contextGraphId: 'global-name' as ContextGraphIdV1,
      seeds: agent.rfc64UnregisteredAuthoritySeedAccessV1(),
    })).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(store.query).not.toHaveBeenCalled();
  });

  it('contains a failing keyed read (warned once) so the ontology copy still reconciles; only abort propagates', async () => {
    const agent = await createSeedAgent();
    const seed = await mintSeed();
    agent.seeds.read.mockRejectedValue(new Error('inventory latency budget exceeded'));
    const store = ontologyStore([seed.evidence]);
    const seeds = agent.rfc64UnregisteredAuthoritySeedAccessV1();

    const first = await loadRfc64UnregisteredReplicaAuthorityV1({
      store,
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      seeds,
    });
    expect(first).toMatchObject({ source: 'owner-signed-unregistered', policyDigest: seed.policyDigest });
    expect(store.query).toHaveBeenCalledTimes(1);
    expect(agent.log.warn).toHaveBeenCalledTimes(1);
    expect(String(agent.log.warn.mock.calls[0]?.[1])).toMatch(/seed read .* failed.*latency budget exceeded/u);
    // The write-through still landed even though the read path is wedged.
    await expect(agent.persistence!.unregisteredAuthoritySeeds.read(NETWORK_ID, CONTEXT_GRAPH_ID))
      .resolves.toMatchObject({ policyDigest: seed.policyDigest });

    // Repeats for the same graph stay at debug: a wedged inventory must not
    // flood the log from every reconcile.
    const second = await loadRfc64UnregisteredReplicaAuthorityV1({
      store,
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      seeds,
    });
    expect(second?.policyDigest).toBe(seed.policyDigest);
    expect(agent.log.warn).toHaveBeenCalledTimes(1);
    expect(agent.log.debug).toHaveBeenCalledTimes(1);
    expect(store.query).toHaveBeenCalledTimes(2);

    // The caller's own abort is never swallowed.
    const controller = new AbortController();
    agent.seeds.read.mockImplementation(async () => {
      controller.abort(new Error('bootstrap budget exhausted'));
      throw new Error('read torn down');
    });
    await expect(seeds.read({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      signal: controller.signal,
    })).rejects.toThrow(/read torn down/u);
    expect(agent.log.warn).toHaveBeenCalledTimes(1);
  });

  it('treats a stored row that no longer authenticates as absent and still resolves from the carrier', async () => {
    const agent = await createSeedAgent();
    const seed = await mintSeed();
    // A row whose bytes are a valid seed for a *different* graph passes the
    // storage-boundary shape checks but must never authenticate for this key.
    const foreign = await mintSeed({ contextGraphId: OTHER_CONTEXT_GRAPH_ID });
    await agent.persistence!.unregisteredAuthoritySeeds.put({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: OWNER,
      policyDigest: foreign.policyDigest,
      signedEnvelope: foreign.canonicalEnvelopeBytes,
    });
    const store = ontologyStore([seed.evidence]);

    const authority = await loadRfc64UnregisteredReplicaAuthorityV1({
      store,
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      seeds: agent.rfc64UnregisteredAuthoritySeedAccessV1(),
    });
    expect(authority?.policyDigest).toBe(seed.policyDigest);
    expect(store.query).toHaveBeenCalledTimes(1);
    // The write-through hits the first-writer-wins fence; that is contained
    // and logged, never surfaced as authority loss, and the row is unchanged.
    expect(agent.log.warn).toHaveBeenCalledTimes(1);
    expect(String(agent.log.warn.mock.calls[0]?.[1])).toMatch(/different signed generation/u);
    const stored = await agent.persistence!.unregisteredAuthoritySeeds.read(NETWORK_ID, CONTEXT_GRAPH_ID);
    expect(stored?.policyDigest).toBe(foreign.policyDigest);
  });
});
