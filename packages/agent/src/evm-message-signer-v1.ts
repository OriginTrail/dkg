// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';

export interface EvmPersonalMessageSignerV1 {
  readonly address: string;
  signMessage(message: Uint8Array): Promise<string>;
}

export interface CreateEvmPersonalMessageSignerInputV1 {
  readonly address: string;
  readonly custodialPrivateKey?: string;
  readonly signMessageAs?: (
    address: string,
    message: Uint8Array,
  ) => Promise<{ readonly r: Uint8Array; readonly vs: Uint8Array }>;
  readonly signMessage?: (
    message: Uint8Array,
  ) => Promise<{ readonly r: Uint8Array; readonly vs: Uint8Array }>;
  readonly purpose: string;
}

/**
 * Build one EIP-191 signer without exposing the selected private-key path.
 * Every returned signature is recovered before it leaves this boundary.
 */
export function createEvmPersonalMessageSignerV1(
  input: CreateEvmPersonalMessageSignerInputV1,
): EvmPersonalMessageSignerV1 {
  const expectedAddress = ethers.getAddress(input.address).toLowerCase();
  if (input.custodialPrivateKey !== undefined) {
    const key = input.custodialPrivateKey.startsWith('0x')
      ? input.custodialPrivateKey
      : `0x${input.custodialPrivateKey}`;
    const wallet = new ethers.Wallet(key);
    if (wallet.address.toLowerCase() !== expectedAddress) {
      throw new Error(`${input.purpose} custodial key does not match ${expectedAddress}`);
    }
    return Object.freeze({
      address: expectedAddress,
      signMessage: async (message: Uint8Array) => {
        assertMessageBytes(message);
        const signature = await wallet.signMessage(message);
        assertRecoveredSigner(message, signature, expectedAddress, input.purpose);
        return signature.toLowerCase();
      },
    });
  }

  return Object.freeze({
    address: expectedAddress,
    signMessage: async (message: Uint8Array) => {
      assertMessageBytes(message);
      const compact = input.signMessageAs !== undefined
        ? await input.signMessageAs(expectedAddress, message)
        : input.signMessage !== undefined
          ? await input.signMessage(message)
          : (() => {
              throw new Error(`${input.purpose} configured chain has no message signer`);
            })();
      const signature = ethers.Signature.from({
        r: ethers.hexlify(compact.r),
        yParityAndS: ethers.hexlify(compact.vs),
      }).serialized.toLowerCase();
      assertRecoveredSigner(message, signature, expectedAddress, input.purpose);
      return signature;
    },
  });
}

function assertMessageBytes(message: Uint8Array): void {
  if (!(message instanceof Uint8Array)) {
    throw new TypeError('EVM personal-sign message must be a Uint8Array');
  }
}

function assertRecoveredSigner(
  message: Uint8Array,
  signature: string,
  expectedAddress: string,
  purpose: string,
): void {
  if (ethers.verifyMessage(message, signature).toLowerCase() !== expectedAddress) {
    throw new Error(`${purpose} configured signer cannot sign for ${expectedAddress}`);
  }
}
