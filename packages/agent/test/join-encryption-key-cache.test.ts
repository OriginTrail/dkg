import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  encodeWorkspaceEncryptionKey,
  generateWorkspaceRecipientEncryptionKey,
} from '@origintrail-official/dkg-core';
import { resolveWorkspaceAgentRecipientKeys } from '@origintrail-official/dkg-publisher';
import {
  OxigraphStore,
  SparqlHttpStore,
  type QueryResult,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import type { DKGAgent } from '../src/dkg-agent.js';
import { JoinRequestMethods } from '../src/dkg-agent-join.js';
import {
  computeWorkspaceEncryptionKeysAttestationDigest,
  signAgentDelegation,
  type SignedAgentDelegation,
} from '../src/auth/agent-delegation.js';

const CARRIER_PEER_ID = 'cold-key-cache-test-peer';

async function signedKeyDelegation(
  wallet: ethers.Wallet,
  contextGraphId: string,
  suffix: string,
  issuedAtMs = Date.now(),
): Promise<Readonly<{
  delegation: SignedAgentDelegation;
  publicEncryptionKey: string;
}>> {
  const recipient = generateWorkspaceRecipientEncryptionKey(
    `did:dkg:agent:${wallet.address}`,
    `did:dkg:agent:${wallet.address}#${suffix}`,
  );
  const publicKeyBytes = recipient.publicKeyBytes!;
  const publicEncryptionKey = encodeWorkspaceEncryptionKey(publicKeyBytes);
  const signed = await signAgentDelegation({
    agentAddress: wallet.address,
    scope: `dkg:test:join:${contextGraphId}`,
    issuedAtMs,
    expiresAtMs: issuedAtMs + 60_000,
    delegateePeerId: CARRIER_PEER_ID,
    agentPrivateKey: wallet.privateKey,
  });
  const unsignedBundle: SignedAgentDelegation = {
    ...signed,
    workspaceEncryptionKeys: [{
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicEncryptionKey,
      encryptionKeyProof: await wallet.signMessage(
        computeWorkspaceAgentEncryptionKeyProofPayload({
          agentAddress: wallet.address,
          encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
          publicKeyBytes,
        }),
      ),
    }],
  };
  return {
    delegation: {
      ...unsignedBundle,
      workspaceEncryptionKeysSignature: await wallet.signMessage(
        computeWorkspaceEncryptionKeysAttestationDigest(unsignedBundle),
      ),
    },
    publicEncryptionKey,
  };
}

function cacheHost(store: TripleStore): DKGAgent {
  return { store } as unknown as DKGAgent;
}

async function cache(
  agent: DKGAgent,
  delegation: SignedAgentDelegation,
  carrierPeerId = CARRIER_PEER_ID,
): Promise<void> {
  await JoinRequestMethods.prototype.cacheVerifiedJoinEncryptionKeys.call(
    agent,
    delegation,
    carrierPeerId,
  );
}

async function cachedPublicKeys(
  store: TripleStore,
  agentAddress: string,
): Promise<string[]> {
  const keys = await resolveWorkspaceAgentRecipientKeys(store, agentAddress);
  return keys.map((entry) => encodeWorkspaceEncryptionKey(entry.publicKeyBytes!)).sort();
}

function withoutAtomicSubjectReplace(store: OxigraphStore): TripleStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === 'replaceSubject') return undefined;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as TripleStore;
}

type DelegationWorkspaceKey = NonNullable<
  SignedAgentDelegation['workspaceEncryptionKeys']
>[number];

function profileKeyBinding(
  key: DelegationWorkspaceKey,
  peerId: string | undefined = CARRIER_PEER_ID,
): Record<string, string> {
  return {
    key: JSON.stringify(key.publicEncryptionKey),
    algorithm: JSON.stringify(key.encryptionKeyAlgorithm),
    proof: JSON.stringify(key.encryptionKeyProof),
    ...(peerId === undefined ? {} : { peerId: JSON.stringify(peerId) }),
  };
}

function legacyCacheRows(
  keys: readonly DelegationWorkspaceKey[],
  peerId = CARRIER_PEER_ID,
): Array<Record<string, string>> {
  return [
    {
      predicate: 'https://dkg.network/ontology#peerId',
      object: JSON.stringify(peerId),
    },
    ...keys.flatMap((key) => [{
      predicate: 'https://dkg.network/ontology#publicEncryptionKey',
      object: JSON.stringify(key.publicEncryptionKey),
    }, {
      predicate: 'https://dkg.network/ontology#encryptionKeyAlgorithm',
      object: JSON.stringify(key.encryptionKeyAlgorithm),
    }, {
      predicate: 'https://dkg.network/ontology#encryptionKeyProof',
      object: JSON.stringify(key.encryptionKeyProof),
    }]),
  ];
}

function defaultBestEffortStore(input: Readonly<{
  cacheRows?: Array<Record<string, string>>;
  profileRows: Array<Record<string, string>>;
}>): Readonly<{
  store: SparqlHttpStore;
  query: ReturnType<typeof vi.spyOn>;
}> {
  const store = new SparqlHttpStore({
    queryEndpoint: 'http://best-effort.invalid/query',
    updateEndpoint: 'http://best-effort.invalid/update',
  });
  const query = vi.spyOn(store, 'query').mockImplementation(
    async (sparql): Promise<QueryResult> => {
      if (sparql.includes('SELECT ?predicate ?object')) {
        return { type: 'bindings', bindings: input.cacheRows ?? [] };
      }
      if (sparql.includes('SELECT ?key ?algorithm ?proof ?peerId')) {
        expect(sparql).toContain(
          'FILTER (?g NOT IN (<urn:dkg:local:join-encryption-key-cache>))',
        );
        expect(sparql).toContain('LIMIT 65');
        return { type: 'bindings', bindings: input.profileRows };
      }
      if (sparql.includes('SELECT ?keyId ?revokedAt ?revocationProof')) {
        return { type: 'bindings', bindings: [] };
      }
      throw new Error(`Unexpected query: ${sparql}`);
    },
  );
  return { store, query };
}

describe('cold join encryption-key cache replacement', () => {
  it('preserves the prior exact key set when atomic replacement fails', async () => {
    const store = new OxigraphStore();
    const agent = cacheHost(store);
    const wallet = ethers.Wallet.createRandom();
    const issuedAtMs = Date.now();
    const initial = await signedKeyDelegation(wallet, 'failure-cg', 'initial', issuedAtMs);
    const replacement = await signedKeyDelegation(
      wallet,
      'failure-cg',
      'replacement',
      issuedAtMs + 1,
    );
    await cache(agent, initial.delegation);

    const replaceSubject = vi.spyOn(store, 'replaceSubject')
      .mockRejectedValueOnce(new Error('simulated atomic replacement failure'));
    await expect(cache(agent, replacement.delegation)).rejects.toThrow(
      /simulated atomic replacement failure/i,
    );

    expect(replaceSubject).toHaveBeenCalledTimes(1);
    await expect(cachedPublicKeys(store, wallet.address)).resolves.toEqual([
      initial.publicEncryptionKey,
    ]);
  });

  it('keeps the newer cross-CG rotation when an older signed bundle arrives later', async () => {
    const store = new OxigraphStore();
    const agent = cacheHost(store);
    const wallet = ethers.Wallet.createRandom();
    const issuedAtMs = Date.now();
    const olderRotation = await signedKeyDelegation(
      wallet,
      'first-cg',
      'older-rotation',
      issuedAtMs,
    );
    const newerRotation = await signedKeyDelegation(
      wallet,
      'second-cg',
      'newer-rotation',
      issuedAtMs + 1,
    );

    await cache(agent, newerRotation.delegation);
    await cache(agent, olderRotation.delegation);

    await expect(cachedPublicKeys(store, wallet.address)).resolves.toEqual([
      newerRotation.publicEncryptionKey,
    ]);
  });

  it('serializes concurrent cross-CG rotations and retains the exact newer set', async () => {
    const store = new OxigraphStore();
    const agent = cacheHost(store);
    const wallet = ethers.Wallet.createRandom();
    const issuedAtMs = Date.now();
    const olderRotation = await signedKeyDelegation(
      wallet,
      'first-cg',
      'concurrent-older',
      issuedAtMs,
    );
    const newerRotation = await signedKeyDelegation(
      wallet,
      'second-cg',
      'concurrent-newer',
      issuedAtMs + 1,
    );
    const originalReplace = store.replaceSubject.bind(store);
    let observeFirstReplace!: () => void;
    const firstReplaceObserved = new Promise<void>((resolve) => {
      observeFirstReplace = resolve;
    });
    let releaseFirstReplace!: () => void;
    const firstReplaceReleased = new Promise<void>((resolve) => {
      releaseFirstReplace = resolve;
    });
    const replaceSubject = vi.spyOn(store, 'replaceSubject')
      .mockImplementation(async (...args) => {
        if (replaceSubject.mock.calls.length === 1) {
          observeFirstReplace();
          await firstReplaceReleased;
        }
        await originalReplace(...args);
      });

    const first = cache(agent, olderRotation.delegation);
    await firstReplaceObserved;
    const second = cache(agent, newerRotation.delegation);
    await Promise.resolve();
    await Promise.resolve();
    expect(replaceSubject).toHaveBeenCalledTimes(1);

    releaseFirstReplace();
    await Promise.all([first, second]);
    expect(replaceSubject).toHaveBeenCalledTimes(2);
    await expect(cachedPublicKeys(store, wallet.address)).resolves.toEqual([
      newerRotation.publicEncryptionKey,
    ]);
  });

  it('advances freshness for the same key set before rejecting an intermediate rotation', async () => {
    const store = new OxigraphStore();
    const agent = cacheHost(store);
    const wallet = ethers.Wallet.createRandom();
    const issuedAtMs = Date.now();
    const original = await signedKeyDelegation(wallet, 'first-cg', 'stable', issuedAtMs);
    const sameSetSigned = await signAgentDelegation({
      agentAddress: wallet.address,
      scope: 'dkg:test:join:second-cg',
      issuedAtMs: issuedAtMs + 2,
      expiresAtMs: issuedAtMs + 60_002,
      delegateePeerId: CARRIER_PEER_ID,
      agentPrivateKey: wallet.privateKey,
    });
    const sameSetUnsigned: SignedAgentDelegation = {
      ...sameSetSigned,
      workspaceEncryptionKeys: original.delegation.workspaceEncryptionKeys,
    };
    const sameSetNewer: SignedAgentDelegation = {
      ...sameSetUnsigned,
      workspaceEncryptionKeysSignature: await wallet.signMessage(
        computeWorkspaceEncryptionKeysAttestationDigest(sameSetUnsigned),
      ),
    };
    const intermediate = await signedKeyDelegation(
      wallet,
      'third-cg',
      'intermediate',
      issuedAtMs + 1,
    );

    await cache(agent, original.delegation);
    await cache(agent, sameSetNewer);
    await cache(agent, intermediate.delegation);

    await expect(cachedPublicKeys(store, wallet.address)).resolves.toEqual([
      original.publicEncryptionKey,
    ]);
  });

  it('rejects an equal-time carrier change even when the key set is unchanged', async () => {
    const store = new OxigraphStore();
    const agent = cacheHost(store);
    const wallet = ethers.Wallet.createRandom();
    const issuedAtMs = Date.now();
    const original = await signedKeyDelegation(wallet, 'first-cg', 'stable', issuedAtMs);
    const otherCarrier = 'cold-key-cache-other-peer';
    const conflictingSigned = await signAgentDelegation({
      agentAddress: wallet.address,
      scope: 'dkg:test:join:second-cg',
      issuedAtMs,
      expiresAtMs: issuedAtMs + 60_000,
      delegateePeerId: otherCarrier,
      agentPrivateKey: wallet.privateKey,
    });
    const conflictingUnsigned: SignedAgentDelegation = {
      ...conflictingSigned,
      workspaceEncryptionKeys: original.delegation.workspaceEncryptionKeys,
    };
    const conflicting: SignedAgentDelegation = {
      ...conflictingUnsigned,
      workspaceEncryptionKeysSignature: await wallet.signMessage(
        computeWorkspaceEncryptionKeysAttestationDigest(conflictingUnsigned),
      ),
    };

    await cache(agent, original.delegation);
    await expect(cache(agent, conflicting, otherCarrier)).rejects.toThrow(
      /conflicting join encryption-key bundle/i,
    );
    await expect(cachedPublicKeys(store, wallet.address)).resolves.toEqual([
      original.publicEncryptionKey,
    ]);
  });

  it('accepts a warm profile-resolvable key without mutating a default best-effort SPARQL store', async () => {
    const wallet = ethers.Wallet.createRandom();
    const warm = await signedKeyDelegation(wallet, 'warm-cg', 'warm-profile');
    const key = warm.delegation.workspaceEncryptionKeys![0]!;
    const { store, query } = defaultBestEffortStore({
      profileRows: [profileKeyBinding(key)],
    });
    const agent = cacheHost(store);
    const replaceSubject = vi.spyOn(store, 'replaceSubject');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(cache(agent, warm.delegation)).resolves.toBeUndefined();

      expect(replaceSubject).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledTimes(3);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rejects a warm subset when the profile resolves an extra active key', async () => {
    const wallet = ethers.Wallet.createRandom();
    const incoming = await signedKeyDelegation(wallet, 'warm-subset-cg', 'incoming');
    const extra = await signedKeyDelegation(wallet, 'warm-subset-cg', 'extra');
    const { store } = defaultBestEffortStore({
      profileRows: [
        profileKeyBinding(incoming.delegation.workspaceEncryptionKeys![0]!),
        profileKeyBinding(extra.delegation.workspaceEncryptionKeys![0]!),
      ],
    });

    await expect(cache(cacheHost(store), incoming.delegation)).rejects.toThrow(
      /requires atomic subject-replacement support/i,
    );
  });

  it.each([
    ['missing', undefined],
    ['stale', 'cold-key-cache-stale-peer'],
  ])('rejects an exact warm key with a %s profile peer route', async (_label, peerId) => {
    const wallet = ethers.Wallet.createRandom();
    const incoming = await signedKeyDelegation(wallet, 'warm-route-cg', `route-${_label}`);
    const profileRow = profileKeyBinding(
      incoming.delegation.workspaceEncryptionKeys![0]!,
      peerId ?? CARRIER_PEER_ID,
    );
    if (peerId === undefined) delete profileRow.peerId;
    const { store } = defaultBestEffortStore({
      profileRows: [profileRow],
    });

    await expect(cache(cacheHost(store), incoming.delegation)).rejects.toThrow(
      /requires atomic subject-replacement support/i,
    );
  });

  it.each([
    ['carrier then stale', false, false],
    ['stale then carrier', false, true],
    ['carrier then missing', true, false],
    ['missing then carrier', true, true],
  ])(
    'rejects duplicate valid warm rows ordered as %s',
    async (_label, missingPeer, invalidFirst) => {
      const wallet = ethers.Wallet.createRandom();
      const incoming = await signedKeyDelegation(wallet, 'warm-duplicate-cg', `duplicate-${_label}`);
      const key = incoming.delegation.workspaceEncryptionKeys![0]!;
      const carrierRow = profileKeyBinding(key);
      const invalidRouteRow = profileKeyBinding(
        key,
        missingPeer ? CARRIER_PEER_ID : 'cold-key-cache-stale-peer',
      );
      if (missingPeer) delete invalidRouteRow.peerId;
      const profileRows = invalidFirst
        ? [invalidRouteRow, carrierRow]
        : [carrierRow, invalidRouteRow];
      const { store } = defaultBestEffortStore({ profileRows });

      await expect(cache(cacheHost(store), incoming.delegation)).rejects.toThrow(
        /requires atomic subject-replacement support/i,
      );
    },
  );

  it('accepts an exact cache-only pre-marker legacy subject on default best-effort SPARQL', async () => {
    const wallet = ethers.Wallet.createRandom();
    const incoming = await signedKeyDelegation(wallet, 'legacy-exact-cg', 'legacy-exact');
    const key = incoming.delegation.workspaceEncryptionKeys![0]!;
    const { store } = defaultBestEffortStore({
      cacheRows: legacyCacheRows([key]),
      profileRows: [],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(cache(cacheHost(store), incoming.delegation)).resolves.toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each(['extra-key', 'wrong-carrier'])(
    'rejects a pre-marker legacy cache with %s on default best-effort SPARQL',
    async (mismatch) => {
      const wallet = ethers.Wallet.createRandom();
      const incoming = await signedKeyDelegation(wallet, 'legacy-mismatch-cg', 'incoming');
      const extra = await signedKeyDelegation(wallet, 'legacy-mismatch-cg', 'extra');
      const incomingKey = incoming.delegation.workspaceEncryptionKeys![0]!;
      const cacheKeys = mismatch === 'extra-key'
        ? [incomingKey, extra.delegation.workspaceEncryptionKeys![0]!]
        : [incomingKey];
      const { store } = defaultBestEffortStore({
        cacheRows: legacyCacheRows(
          cacheKeys,
          mismatch === 'wrong-carrier' ? 'cold-key-cache-stale-peer' : CARRIER_PEER_ID,
        ),
        profileRows: [],
      });

      await expect(cache(cacheHost(store), incoming.delegation)).rejects.toThrow(
        /requires atomic subject-replacement support/i,
      );
    },
  );

  it('fails closed for a cold key when atomic subject replacement is unsupported', async () => {
    const innerStore = new OxigraphStore();
    const unsupportedStore = withoutAtomicSubjectReplace(innerStore);
    const unsupportedAgent = cacheHost(unsupportedStore);
    const wallet = ethers.Wallet.createRandom();
    const cold = await signedKeyDelegation(wallet, 'cold-cg', 'cold');

    await expect(cache(unsupportedAgent, cold.delegation)).rejects.toThrow(
      /requires atomic subject-replacement support/i,
    );
    await expect(cachedPublicKeys(innerStore, wallet.address)).rejects.toThrow(
      /missing public encryption key/i,
    );
  });

  it('fails closed without atomic subject replacement and preserves the prior set', async () => {
    const innerStore = new OxigraphStore();
    const atomicAgent = cacheHost(innerStore);
    const wallet = ethers.Wallet.createRandom();
    const initial = await signedKeyDelegation(wallet, 'initial-cg', 'initial', Date.now());
    const replacement = await signedKeyDelegation(
      wallet,
      'replacement-cg',
      'replacement',
      initial.delegation.issuedAtMs + 1,
    );
    await cache(atomicAgent, initial.delegation);

    const unsupportedStore = withoutAtomicSubjectReplace(innerStore);
    const unsupportedAgent = cacheHost(unsupportedStore);
    const deleteByPattern = vi.spyOn(innerStore, 'deleteByPatternWithoutCount');
    await expect(cache(unsupportedAgent, replacement.delegation)).rejects.toThrow(
      /requires atomic subject-replacement support/i,
    );

    expect(deleteByPattern).not.toHaveBeenCalled();
    await expect(cachedPublicKeys(innerStore, wallet.address)).resolves.toEqual([
      initial.publicEncryptionKey,
    ]);
  });
});
