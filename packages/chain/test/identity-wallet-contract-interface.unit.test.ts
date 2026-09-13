import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  IDENTITY_STORAGE_WALLET_ABI,
  IDENTITY_WALLET_ABI,
  PROFILE_IDENTITY_WALLET_ABI,
  identityWalletFunctionSignature,
  type IdentityWalletAbiFunction,
} from '@origintrail-official/dkg-core';
import { loadAbi } from '../src/evm-adapter-abi.js';

function canonicalFunction(contract: string, name: string): IdentityWalletAbiFunction {
  const fragment = (loadAbi(contract) as unknown[]).find((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const value = candidate as { type?: unknown; name?: unknown };
    return value.type === 'function' && value.name === name;
  });
  if (!fragment) throw new Error(`Missing ${contract}.${name} in canonical ABI snapshot`);
  return fragment as IdentityWalletAbiFunction;
}

describe('shared identity-wallet contract interface', () => {
  it.each([
    ['Profile', PROFILE_IDENTITY_WALLET_ABI[0]],
    ['Identity', IDENTITY_WALLET_ABI[0]],
    ['Identity', IDENTITY_WALLET_ABI[1]],
    ['IdentityStorage', IDENTITY_STORAGE_WALLET_ABI[0]],
    ['IdentityStorage', IDENTITY_STORAGE_WALLET_ABI[1]],
  ] as const)('%s.%s stays pinned to the canonical chain ABI', (contract, shared) => {
    expect(shared).toEqual(canonicalFunction(contract, shared.name));
  });

  it('derives the daemon allowlist selectors from the same storage fragments', () => {
    expect(IDENTITY_STORAGE_WALLET_ABI.map((fragment) =>
      ethers.id(identityWalletFunctionSignature(fragment)).slice(0, 10),
    )).toEqual([
      ethers.id('keyHasPurpose(uint72,bytes32,uint256)').slice(0, 10),
      ethers.id('getKeysByPurpose(uint72,uint256)').slice(0, 10),
    ]);
  });
});
