/**
 * #2849: a sender that lacks roster members' encryption keys fetches the
 * `agents` phonebook for all of them at once, then resolves their keys again.
 * Every member still needs a key, so a share whose keys cannot be found fails
 * closed with an error that says what to do.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  DKG_ONTOLOGY,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  contextGraphDataUri,
  contextGraphMetaUri,
  encodeWorkspaceEncryptionKey,
  generateWorkspaceRecipientEncryptionKey,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  isWorkspaceAgentEncryptionKeyMissingError,
  WorkspaceAgentEncryptionKeyMissingError,
} from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/dkg-agent.js';
import { stubFence } from './_helpers/recipient-fence-stub.js';

const CONTEXT_GRAPH_ID = '0x00000000000000000000000000000000000000c1/key-fetch';
const PROFILE_GRAPH = 'did:dkg:context-graph:agents';

function signedKeyQuads(wallet: ethers.HDNodeWallet): Quad[] {
  const agentUri = `did:dkg:agent:${ethers.getAddress(wallet.address)}`;
  const key = generateWorkspaceRecipientEncryptionKey(agentUri, `${agentUri}#key-fetch-x25519`);
  const publicKeyBytes = key.publicKeyBytes!;
  const proof = wallet.signingKey.sign(ethers.hashMessage(computeWorkspaceAgentEncryptionKeyProofPayload({
    agentAddress: wallet.address,
    encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
    publicKeyBytes,
  }))).serialized;
  return [
    {
      subject: agentUri,
      predicate: DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY,
      object: `"${encodeWorkspaceEncryptionKey(publicKeyBytes)}"`,
      graph: PROFILE_GRAPH,
    },
    {
      subject: agentUri,
      predicate: DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_ALGORITHM,
      object: `"${WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519}"`,
      graph: PROFILE_GRAPH,
    },
    {
      subject: agentUri,
      predicate: DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_PROOF,
      object: `"${proof}"`,
      graph: PROFILE_GRAPH,
    },
  ];
}

describe('private share recipients with a missing member key (#2849)', () => {
  const stores: OxigraphStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  /**
   * A registered private graph whose chain roster is `members`. The phonebook
   * fetch is a stub: `onFetch` decides which member profiles it brings in.
   */
  function sender(
    members: ethers.HDNodeWallet[],
    onFetch?: (wallets: readonly string[]) => ethers.HDNodeWallet[],
    transportKind: 'private-roster' | 'legacy-unregistered' = 'private-roster',
  ) {
    const store = new OxigraphStore();
    stores.push(store);
    const host = Object.create(DKGAgent.prototype) as DKGAgent;
    const ensureAgentsInOnDemandPhonebook = vi.fn(async (
      wallets: readonly string[],
      _signal?: AbortSignal,
    ): Promise<ReadonlySet<string>> => {
      const fetched = onFetch?.(wallets) ?? [];
      for (const wallet of fetched) await store.insert(signedKeyQuads(wallet));
      return new Set(fetched.map((wallet) => wallet.address.toLowerCase()));
    });
    Object.assign(host, {
      store,
      contextGraphMetaProjection: {
        readAuthorityFactsRevision: 0,
        readContextGraphAuthorityFactsRevision: () => '0:0',
        recipientKeyRouteFence: stubFence(),
      },
      resolveSwmTransportAuthority: vi.fn(async () => (transportKind === 'private-roster'
        ? { kind: 'private-roster' as const, participantAgents: members.map((member) => member.address) }
        : { kind: 'legacy-unregistered' as const })),
      getContextGraphAllowedPeers: vi.fn(async () => null),
      ensureAgentsInOnDemandPhonebook,
    });
    return { host, store, ensureAgentsInOnDemandPhonebook };
  }

  const resolve = (host: DKGAgent) => host.resolveWorkspaceAgentRecipientsForCurrentAuthority({
    contextGraphId: CONTEXT_GRAPH_ID,
  } as never);

  it('fetches a missing member key once, then resolves every recipient', async () => {
    const member = ethers.Wallet.createRandom();
    const { host, ensureAgentsInOnDemandPhonebook } = sender([member], () => [member]);

    const resolution = await resolve(host);

    expect(resolution.requiresEncryption).toBe(true);
    expect(resolution.recipients.map((recipient) => recipient.agentAddress))
      .toEqual([ethers.getAddress(member.address)]);
    expect(ensureAgentsInOnDemandPhonebook).toHaveBeenCalledTimes(1);
    expect(ensureAgentsInOnDemandPhonebook).toHaveBeenCalledWith(
      [member.address.toLowerCase()],
      expect.any(AbortSignal),
    );
  });

  it('fails closed with an actionable error when the fetch cannot find the key', async () => {
    const member = ethers.Wallet.createRandom();
    const { host, ensureAgentsInOnDemandPhonebook } = sender([member]);

    const error = await resolve(host).then(() => null, (thrown: unknown) => thrown);

    expect(isWorkspaceAgentEncryptionKeyMissingError(error)).toBe(true);
    expect((error as WorkspaceAgentEncryptionKeyMissingError).agentAddress)
      .toBe(ethers.getAddress(member.address));
    expect((error as Error).message).toContain(
      `Missing public encryption key for DKG agent ${ethers.getAddress(member.address)}`,
    );
    expect((error as Error).message).toContain('join through an invite');
    expect(ensureAgentsInOnDemandPhonebook).toHaveBeenCalledTimes(1);
  });

  it('fetches once: a fetch that reports the wallet but brings no usable key still fails closed', async () => {
    const member = ethers.Wallet.createRandom();
    const { host, ensureAgentsInOnDemandPhonebook } = sender([member]);
    ensureAgentsInOnDemandPhonebook.mockImplementation(async (wallets) => new Set(wallets));

    await expect(resolve(host)).rejects.toThrow('join through an invite');
    expect(ensureAgentsInOnDemandPhonebook).toHaveBeenCalledTimes(1);
  });

  it('asks for every missing member in one fetch and rechecks the roster afterward', async () => {
    const first = ethers.Wallet.createRandom();
    const keyed = ethers.Wallet.createRandom();
    const second = ethers.Wallet.createRandom();
    const { host, store, ensureAgentsInOnDemandPhonebook } = sender(
      [first, keyed, second],
      (wallets) => [first, second].filter((wallet) => wallets.includes(wallet.address.toLowerCase())),
    );
    await store.insert(signedKeyQuads(keyed));

    const resolution = await resolve(host);

    expect(resolution.recipients).toHaveLength(3);
    expect(ensureAgentsInOnDemandPhonebook.mock.calls.map(([wallets]) => wallets)).toEqual([
      [first.address.toLowerCase(), second.address.toLowerCase()],
    ]);
    const internals = host as unknown as {
      resolveSwmTransportAuthority: ReturnType<typeof vi.fn>;
      getContextGraphAllowedPeers: ReturnType<typeof vi.fn>;
    };
    expect(internals.resolveSwmTransportAuthority).toHaveBeenCalledTimes(2);
    // Each resolution attempt owns its peer-gate snapshot, including the retry
    // after phonebook hydration, and the confirmation reads the gate once more.
    expect(internals.getContextGraphAllowedPeers).toHaveBeenCalledTimes(3);
  });

  it('names every member still without a key when the fetch cannot find them', async () => {
    const first = ethers.Wallet.createRandom();
    const second = ethers.Wallet.createRandom();
    const { host, ensureAgentsInOnDemandPhonebook } = sender([first, second]);

    const error = await resolve(host).then(() => null, (thrown: unknown) => thrown);

    expect(isWorkspaceAgentEncryptionKeyMissingError(error)).toBe(true);
    expect((error as WorkspaceAgentEncryptionKeyMissingError).agentAddresses)
      .toEqual([first, second].map((wallet) => ethers.getAddress(wallet.address)));
    expect((error as Error).message).toContain('Have each member join through an invite');
    expect(ensureAgentsInOnDemandPhonebook).toHaveBeenCalledTimes(1);
  });

  it('fetches the missing members of an unregistered graph the same way', async () => {
    const first = ethers.Wallet.createRandom();
    const second = ethers.Wallet.createRandom();
    const { host, store, ensureAgentsInOnDemandPhonebook } = sender(
      [first, second],
      (wallets) => [first, second].filter((wallet) => wallets.includes(wallet.address.toLowerCase())),
      'legacy-unregistered',
    );
    // The local gate of an unregistered graph lists its members.
    for (const member of [first, second]) {
      await store.insert([{
        subject: contextGraphDataUri(CONTEXT_GRAPH_ID),
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
        object: `"${member.address}"`,
        graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
      }]);
    }

    const resolution = await resolve(host);

    expect(resolution.recipients).toHaveLength(2);
    // One request with both members; the local gate lists them in store order.
    expect(ensureAgentsInOnDemandPhonebook).toHaveBeenCalledTimes(1);
    expect([...ensureAgentsInOnDemandPhonebook.mock.calls[0]![0]].sort())
      .toEqual([first, second].map((wallet) => wallet.address.toLowerCase()).sort());
  });

  it('counts a recipient as known to the phonebook fetcher only by a verified key', async () => {
    const member = ethers.Wallet.createRandom();
    const { host, store } = sender([member]);
    const deps = host.createOnDemandAgentsPhonebookDeps();
    const wallet = member.address.toLowerCase();
    const signal = new AbortController().signal;
    // An older profile maps the agent to a peer but carries no key.
    await store.insert([{
      subject: `did:dkg:agent:${ethers.getAddress(member.address)}`,
      predicate: DKG_ONTOLOGY.DKG_PEER_ID,
      object: '"12D3KooWOlderProfileWithoutKey"',
      graph: PROFILE_GRAPH,
    }]);
    expect(await deps.recipientKeyKnown(wallet, signal)).toBe(false);

    await store.insert(signedKeyQuads(member));
    expect(await deps.recipientKeyKnown(wallet, signal)).toBe(true);
  });

  it('leaves every other recipient failure untouched', async () => {
    const member = ethers.Wallet.createRandom();
    const { host, ensureAgentsInOnDemandPhonebook } = sender([member], () => [member]);
    (host as unknown as { getContextGraphAllowedPeers: () => Promise<string[]> })
      .getContextGraphAllowedPeers = async () => ['12D3KooWOnlyThisPeerMayReceive'];
    const { store } = { store: (host as unknown as { store: OxigraphStore }).store };
    await store.insert(signedKeyQuads(member));

    // A key exists but no allowed peer advertises it: not a missing key.
    await expect(resolve(host)).rejects.toThrow('has no recipient key advertised by a peer');
    expect(ensureAgentsInOnDemandPhonebook).not.toHaveBeenCalled();
  });

  it('keeps the closed failure on a host without the phonebook fetcher', async () => {
    const member = ethers.Wallet.createRandom();
    const { host } = sender([member]);
    delete (host as unknown as { ensureAgentsInOnDemandPhonebook?: unknown }).ensureAgentsInOnDemandPhonebook;
    Object.defineProperty(host, 'ensureAgentsInOnDemandPhonebook', { value: undefined });

    await expect(resolve(host)).rejects.toThrow(
      `Missing public encryption key for DKG agent ${ethers.getAddress(member.address)}`,
    );
  });
});
