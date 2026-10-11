/**
 * The author-signing capability that finalize, selection publishing and
 * updates resolve: a custodial agent's key held on the node, or the external
 * signer that holds a self-sovereign agent's author key. Both sign the same
 * typed data alike.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { heldAuthorSigner, registeredAgentAuthorSigner } from '../src/author-signer.js';
import { HARDHAT_KEYS } from '../../chain/test/hardhat-harness.js';

const custodial = new ethers.Wallet(HARDHAT_KEYS.EXTRA1);
const held = new ethers.Wallet(HARDHAT_KEYS.EXTRA2);
const notHeld = new ethers.Wallet(HARDHAT_KEYS.EXTRA3).address;
const keyless = new ethers.Wallet(HARDHAT_KEYS.PUBLISHER2).address;
const unknown = new ethers.Wallet(HARDHAT_KEYS.PUBLISHER).address;

const modes: Record<string, 'custodial' | 'self-sovereign'> = {
  [custodial.address]: 'custodial',
  [keyless]: 'custodial',
  [held.address]: 'self-sovereign',
  [notHeld]: 'self-sovereign',
};
const agents = {
  getLocalAgentMode: (address: string) => modes[address],
  // Stored without the 0x prefix, as some keystores hold it.
  getCustodialAgentPrivateKey: (address: string) => (address === custodial.address ? custodial.privateKey.slice(2) : undefined),
};
const config = {
  chainConfig: {
    authors: {
      addresses: [held.address],
      signerFor: async (address: string) => (address === held.address ? held : undefined),
      firstSignerOf: async (addresses: readonly string[]) => (
        addresses.includes(held.address) ? { address: held.address, signer: held } : undefined
      ),
    },
  },
};

const DOMAIN = { name: 'Example', version: '1', chainId: 31337, verifyingContract: '0x00000000000000000000000000000000000000c3' };
const TYPES = { Attestation: [{ name: 'root', type: 'bytes32' }, { name: 'author', type: 'address' }] };
const VALUE = { root: ethers.keccak256('0x01'), author: custodial.address };

describe('author signer', () => {
  it('signs with a custodial key held on the node, else through the external signer that holds the key', async () => {
    const fromKey = await heldAuthorSigner(agents, config, custodial.address);
    expect(await fromKey!.signTypedData(DOMAIN, TYPES, VALUE)).toBe(await custodial.signTypedData(DOMAIN, TYPES, VALUE));
    expect(await heldAuthorSigner(agents, config, held.address)).toBe(held);
    expect(await heldAuthorSigner(agents, config, notHeld)).toBeUndefined();
    expect(await heldAuthorSigner(agents, undefined, held.address)).toBeUndefined();
  });

  it('resolves a registered agent named as the author, or says why the node cannot sign for it', async () => {
    const fromKey = await registeredAgentAuthorSigner(agents, config, custodial.address, 'assertionFinalize', 'SEAL_CAPABILITY_GAP');
    expect(await fromKey.signTypedData(DOMAIN, TYPES, VALUE)).toBe(await custodial.signTypedData(DOMAIN, TYPES, VALUE));
    expect(await registeredAgentAuthorSigner(agents, config, held.address, 'assertionFinalize')).toBe(held);

    await expect(registeredAgentAuthorSigner(agents, config, unknown, 'assertionFinalize'))
      .rejects.toThrow(`assertionFinalize: authorAgentAddress ${unknown} is not a registered local agent on this node`);
    await expect(registeredAgentAuthorSigner(agents, config, notHeld, 'Selection-based VM publish'))
      .rejects.toThrow(`Selection-based VM publish: agent ${notHeld} is registered as self-sovereign — this node does not hold its private key.`);
    await expect(registeredAgentAuthorSigner(agents, config, keyless, 'assertionFinalize', 'SEAL_CAPABILITY_GAP'))
      .rejects.toMatchObject({
        code: 'SEAL_CAPABILITY_GAP',
        message: `assertionFinalize: custodial agent ${keyless} has no private key on file`,
      });
    const uncoded = await registeredAgentAuthorSigner(agents, config, keyless, 'Selection-based VM publish').catch((error: unknown) => error);
    expect(uncoded).toMatchObject({ message: `Selection-based VM publish: custodial agent ${keyless} has no private key on file` });
    expect((uncoded as { code?: unknown }).code).toBeUndefined();
  });
});
