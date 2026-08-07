// SPDX-License-Identifier: Apache-2.0

import {
  assertCanonicalEvmAddress,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

export interface EvmPersonalMessageSignerV1 {
  readonly address: EvmAddressV1;
  signMessage(message: Uint8Array): Promise<string>;
}

interface CreateEvmPersonalMessageSignerBaseV1 {
  readonly address: string;
  readonly purpose: string;
}

interface CompactEvmSignatureV1 {
  readonly r: Uint8Array;
  readonly vs: Uint8Array;
}

export type CreateEvmPersonalMessageSignerInputV1 = CreateEvmPersonalMessageSignerBaseV1 & (
  | Readonly<{
    mode: 'custodial';
    privateKey: string;
  }>
  | Readonly<{
    mode: 'chain-as';
    signMessageAs: (
    address: string,
    message: Uint8Array,
    ) => Promise<CompactEvmSignatureV1>;
  }>
  | Readonly<{
    mode: 'chain-default';
    signMessage: (
    message: Uint8Array,
    ) => Promise<CompactEvmSignatureV1>;
  }>
);

/**
 * Build one EIP-191 signer without exposing the selected private-key path.
 * Every returned signature is recovered before it leaves this boundary.
 */
export function createEvmPersonalMessageSignerV1(
  input: CreateEvmPersonalMessageSignerInputV1,
): EvmPersonalMessageSignerV1 {
  const expectedAddress = ethers.getAddress(input.address).toLowerCase();
  assertCanonicalEvmAddress(expectedAddress, 'EVM personal-message signer address');
  const canonicalAddress = expectedAddress as EvmAddressV1;
  if (input.mode === 'custodial') {
    const key = input.privateKey.startsWith('0x')
      ? input.privateKey
      : `0x${input.privateKey}`;
    const wallet = new ethers.Wallet(key);
    if (wallet.address.toLowerCase() !== expectedAddress) {
      throw new Error(`${input.purpose} custodial key does not match ${expectedAddress}`);
    }
    return Object.freeze({
      address: canonicalAddress,
      signMessage: async (message: Uint8Array) => {
        assertMessageBytes(message);
        const signature = await wallet.signMessage(message);
        assertRecoveredSigner(message, signature, expectedAddress, input.purpose);
        return signature.toLowerCase();
      },
    });
  }

  return Object.freeze({
    address: canonicalAddress,
    signMessage: async (message: Uint8Array) => {
      assertMessageBytes(message);
      const compact = input.mode === 'chain-as'
        ? await input.signMessageAs(expectedAddress, message)
        : await input.signMessage(message);
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
