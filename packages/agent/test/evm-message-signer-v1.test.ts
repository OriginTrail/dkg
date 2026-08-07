import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

import { createEvmPersonalMessageSignerV1 } from '../src/evm-message-signer-v1.js';

const KEY = `0x${'11'.repeat(32)}`;
const OTHER_KEY = `0x${'22'.repeat(32)}`;
const MESSAGE = new TextEncoder().encode('system-record signer fixture');

describe('shared EVM personal-message signer V1', () => {
  it('signs and re-verifies with a matching custodial key', async () => {
    const wallet = new ethers.Wallet(KEY);
    const signer = createEvmPersonalMessageSignerV1({
      address: wallet.address,
      custodialPrivateKey: KEY,
      purpose: 'fixture',
    });
    const signature = await signer.signMessage(MESSAGE);
    expect(signer.address).toBe(wallet.address.toLowerCase());
    expect(ethers.verifyMessage(MESSAGE, signature).toLowerCase()).toBe(signer.address);
  });

  it('normalizes a chain compact signature and rejects the wrong chain signer', async () => {
    const wallet = new ethers.Wallet(KEY);
    const compact = async (_address: string, message: Uint8Array) => {
      const signature = ethers.Signature.from(await wallet.signMessage(message));
      return {
        r: ethers.getBytes(signature.r),
        vs: ethers.getBytes(signature.yParityAndS),
      };
    };
    const signer = createEvmPersonalMessageSignerV1({
      address: wallet.address,
      signMessageAs: compact,
      purpose: 'fixture',
    });
    await expect(signer.signMessage(MESSAGE)).resolves.toMatch(/^0x[0-9a-f]{130}$/);

    const wrong = new ethers.Wallet(OTHER_KEY);
    const wrongSigner = createEvmPersonalMessageSignerV1({
      address: wallet.address,
      signMessage: async (message) => {
        const signature = ethers.Signature.from(await wrong.signMessage(message));
        return { r: ethers.getBytes(signature.r), vs: ethers.getBytes(signature.yParityAndS) };
      },
      purpose: 'fixture',
    });
    await expect(wrongSigner.signMessage(MESSAGE)).rejects.toThrow(/cannot sign for/);
  });

  it('rejects a custodial key that does not own the requested address', () => {
    expect(() => createEvmPersonalMessageSignerV1({
      address: new ethers.Wallet(KEY).address,
      custodialPrivateKey: OTHER_KEY,
      purpose: 'fixture',
    })).toThrow(/custodial key does not match/);
  });
});
