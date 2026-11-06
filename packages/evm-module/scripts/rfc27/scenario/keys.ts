// The scenario's keys, all derived from one random 32-byte seed:
// keccak256(seed || "rfc27-scenario/<role>"). The seed and the keys are never
// printed; only addresses leave this module.

import { ethers } from 'ethers';

import type { BuyerName } from './config';

export function seedFromHex(text: string): Uint8Array {
  const hex = text.trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('the seed must be 32 bytes of hex');
  return ethers.getBytes(`0x${hex}`);
}

export function deriveKey(seed: Uint8Array, role: string): string {
  return ethers.keccak256(ethers.concat([seed, ethers.toUtf8Bytes(`rfc27-scenario/${role}`)]));
}

export const walletOf = (seed: Uint8Array, role: string): ethers.Wallet => new ethers.Wallet(deriveKey(seed, role));

export const buyerWallet = (seed: Uint8Array, buyer: BuyerName): ethers.Wallet => walletOf(seed, `buyer/${buyer}`);

/** An account's owner: its own key, distinct from its buyer's. */
export const ownerWallet = (seed: Uint8Array, buyer: BuyerName): ethers.Wallet => walletOf(seed, `owner/${buyer}`);

/** The key a buyer signs the requests of one subscription with. */
export const sessionWallet = (seed: Uint8Array, buyer: BuyerName, epoch: number): ethers.Wallet => walletOf(seed, `session/${buyer}/${epoch}`);
