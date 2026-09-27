/**
 * #2849: a sender that lacks a roster member's encryption key fetches the
 * `agents` phonebook for that member once, then resolves the recipients
 * again. Every member still needs a key, so a share whose key cannot be found
 * fails closed with an error that says what to do.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  DKG_ONTOLOGY,
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  computeWorkspaceAgentEncryptionKeyProofPayload,
  encodeWorkspaceEncryptionKey,
  generateWorkspaceRecipientEncryptionKey,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  isWorkspaceAgentEncryptionKeyMissingError,
  WorkspaceAgentEncryptionKeyMissingError,
} from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/dkg-agent.js';

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
      resolveSwmTransportAuthority: vi.fn(async () => ({
        kind: 'private-roster' as const,
        participantAgents: members.map((member) => member.address),
      })),
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

  it('asks once per member: a known profile without a usable key still fails closed', async () => {
    const member = ethers.Wallet.createRandom();
    const { host, ensureAgentsInOnDemandPhonebook } = sender([member]);
    // The phonebook knows the wallet, but its profile carries no key.
    ensureAgentsInOnDemandPhonebook.mockImplementation(async (wallets) => new Set(wallets));

    await expect(resolve(host)).rejects.toThrow('join through an invite');
    expect(ensureAgentsInOnDemandPhonebook).toHaveBeenCalledTimes(1);
  });

  it('asks again only for the next member that is still missing', async () => {
    const first = ethers.Wallet.createRandom();
    const second = ethers.Wallet.createRandom();
    const { host, ensureAgentsInOnDemandPhonebook } = sender(
      [first, second],
      (wallets) => [first, second].filter((wallet) => wallets.includes(wallet.address.toLowerCase())),
    );

    const resolution = await resolve(host);

    expect(resolution.recipients).toHaveLength(2);
    expect(ensureAgentsInOnDemandPhonebook.mock.calls.map(([wallets]) => wallets)).toEqual([
      [first.address.toLowerCase()],
      [second.address.toLowerCase()],
    ]);
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
