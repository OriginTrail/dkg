/**
 * The author-signing capability that finalize, selection publishing and
 * updates resolve: a custodial agent's key held on the node, or the external
 * signer that holds a self-sovereign agent's author key. Both sign the same
 * typed data alike, and the same RFC-64 control-object digests.
 */
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { agentKeyWallet, agentSigner, heldAuthorSigner, registeredAgentAuthorSigner } from '../src/author-signer.js';
import { rfc64AuthorDigestSignerV1 } from '../src/rfc64/control-envelope-signer-v1.js';
import { HARDHAT_KEYS } from '../../chain/test/hardhat-harness.js';

const custodial = new ethers.Wallet(HARDHAT_KEYS.EXTRA1);
const held = new ethers.Wallet(HARDHAT_KEYS.EXTRA2);
const notHeld = new ethers.Wallet(HARDHAT_KEYS.EXTRA3).address;
const keyless = new ethers.Wallet(HARDHAT_KEYS.PUBLISHER2).address;
const unknown = new ethers.Wallet(HARDHAT_KEYS.PUBLISHER).address;
// A custodial agent whose key moved off the node into the external signer, as an author key.
const moved = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);

const modes: Record<string, 'custodial' | 'self-sovereign'> = {
  [custodial.address]: 'custodial',
  [keyless]: 'custodial',
  [moved.address]: 'custodial',
  [held.address]: 'self-sovereign',
  [notHeld]: 'self-sovereign',
};
const agents = {
  getLocalAgentMode: (address: string) => modes[address],
  // Stored without the 0x prefix, as some keystores hold it.
  getCustodialAgentPrivateKey: (address: string) => (address === custodial.address ? custodial.privateKey.slice(2) : undefined),
};
const authors = {
  addresses: [held.address, moved.address],
  signerFor: async (address: string) => [held, moved].find((key) => key.address === address),
  firstSignerOf: async (addresses: readonly string[]) => (
    addresses.includes(held.address) ? { address: held.address, signer: held } : undefined
  ),
};

const DOMAIN = { name: 'Example', version: '1', chainId: 31337, verifyingContract: '0x00000000000000000000000000000000000000c3' };
const TYPES = { Attestation: [{ name: 'root', type: 'bytes32' }, { name: 'author', type: 'address' }] };
const VALUE = { root: ethers.keccak256('0x01'), author: custodial.address };

describe('author signer', () => {
  it('resolves one signer for an agent: its key on the node first, else the external signer, asked only then', async () => {
    const signerFor = vi.fn(authors.signerFor);
    const counted = { ...authors, signerFor };
    const message = ethers.getBytes(ethers.id('agent message'));
    // A key held on the node signs, stored with or without its 0x prefix, and the external signer is not asked.
    for (const key of [custodial.privateKey, custodial.privateKey.slice(2)]) {
      expect(agentKeyWallet(key).address).toBe(custodial.address);
      const local = await agentSigner(counted, custodial.address, key);
      expect(await local!.signMessage(message)).toBe(await custodial.signMessage(message));
    }
    // For an address both hold, the key on the node wins.
    const both = await agentSigner(counted, held.address, held.privateKey);
    expect(both).not.toBe(held);
    expect(both!.address).toBe(held.address);
    expect(signerFor).not.toHaveBeenCalled();
    // Else the external signer that holds the address as an author key; neither way, no signer.
    expect(await agentSigner(counted, held.address, undefined)).toBe(held);
    expect(signerFor).toHaveBeenCalledTimes(1);
    expect(await agentSigner(counted, notHeld, undefined)).toBeUndefined();
    expect(await agentSigner(undefined, held.address, undefined)).toBeUndefined();
  });

  it('signs with a custodial key held on the node, else through the external signer that holds the key', async () => {
    const fromKey = await heldAuthorSigner(agents, authors, custodial.address);
    expect(await fromKey!.signTypedData(DOMAIN, TYPES, VALUE)).toBe(await custodial.signTypedData(DOMAIN, TYPES, VALUE));
    expect(await heldAuthorSigner(agents, authors, held.address)).toBe(held);
    expect(await heldAuthorSigner(agents, authors, notHeld)).toBeUndefined();
    expect(await heldAuthorSigner(agents, undefined, held.address)).toBeUndefined();
  });

  it('resolves a registered agent named as the author, or says why the node cannot sign for it', async () => {
    const fromKey = await registeredAgentAuthorSigner(agents, authors, custodial.address, 'assertionFinalize', 'SEAL_CAPABILITY_GAP');
    expect(await fromKey.signTypedData(DOMAIN, TYPES, VALUE)).toBe(await custodial.signTypedData(DOMAIN, TYPES, VALUE));
    expect(await registeredAgentAuthorSigner(agents, authors, held.address, 'assertionFinalize')).toBe(held);
    // A custodial agent whose key moved into the signer signs through it; one whose key is still on the node signs
    // with it, and the signer is not asked even when it holds the address too.
    expect(await registeredAgentAuthorSigner(agents, authors, moved.address, 'assertionFinalize', 'SEAL_CAPABILITY_GAP')).toBe(moved);
    const signerFor = vi.fn(async () => custodial);
    const onNode = await registeredAgentAuthorSigner(agents, { ...authors, signerFor }, custodial.address, 'assertionFinalize');
    expect(onNode).not.toBe(custodial);
    expect(onNode.address).toBe(custodial.address);
    expect(signerFor).not.toHaveBeenCalled();

    await expect(registeredAgentAuthorSigner(agents, authors, unknown, 'assertionFinalize'))
      .rejects.toThrow(`assertionFinalize: authorAgentAddress ${unknown} is not a registered local agent on this node`);
    await expect(registeredAgentAuthorSigner(agents, authors, notHeld, 'Selection-based VM publish'))
      .rejects.toThrow(`Selection-based VM publish: agent ${notHeld} is registered as self-sovereign — this node does not hold its private key.`);
    await expect(registeredAgentAuthorSigner(agents, authors, keyless, 'assertionFinalize', 'SEAL_CAPABILITY_GAP'))
      .rejects.toMatchObject({
        code: 'SEAL_CAPABILITY_GAP',
        message: `assertionFinalize: custodial agent ${keyless} has no private key on file`,
      });
    const uncoded = await registeredAgentAuthorSigner(agents, authors, keyless, 'Selection-based VM publish').catch((error: unknown) => error);
    expect(uncoded).toMatchObject({ message: `Selection-based VM publish: custodial agent ${keyless} has no private key on file` });
    expect((uncoded as { code?: unknown }).code).toBeUndefined();
  });

  it('signs RFC-64 control-object digests through either, as the key itself would', async () => {
    const digest = ethers.getBytes(ethers.id('control object'));
    for (const [address, key] of [[custodial.address, custodial], [held.address, held]] as const) {
      const author = await heldAuthorSigner(agents, authors, address);
      const sign = rfc64AuthorDigestSignerV1(address.toLowerCase(), author!);
      expect(await sign(digest)).toBe(await key.signMessage(digest));
    }

    // A key that is not the issuer's never signs, and a cancelled request never starts.
    let signed = 0;
    const counting = { address: held.address, signMessage: async (message: string | Uint8Array) => { signed += 1; return held.signMessage(message); } };
    await expect(rfc64AuthorDigestSignerV1(custodial.address, counting)(digest)).rejects.toThrow(/does not belong to author/);
    const abort = new AbortController();
    const reason = new Error('cancelled');
    abort.abort(reason);
    await expect(rfc64AuthorDigestSignerV1(held.address, counting, abort.signal)(digest)).rejects.toBe(reason);
    expect(signed).toBe(0);
    // A signature by another key is refused.
    const misrouted = { address: held.address, signMessage: (message: string | Uint8Array) => custodial.signMessage(message) };
    await expect(rfc64AuthorDigestSignerV1(held.address, misrouted)(digest)).rejects.toThrow(/does not recover to author/);
  });
});
