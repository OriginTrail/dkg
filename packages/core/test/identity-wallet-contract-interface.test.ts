import { describe, expect, it } from 'vitest';
import {
  IDENTITY_STORAGE_WALLET_ABI,
  IDENTITY_WALLET_ABI,
  IDENTITY_WALLET_CONTRACT_INTERFACE,
  PROFILE_IDENTITY_WALLET_ABI,
  identityWalletFunctionSignature,
} from '../src/identity-wallet-contract-interface.js';

describe('identity-wallet contract interface', () => {
  it('exposes the minimal grouped interface with canonical function signatures', () => {
    expect(IDENTITY_WALLET_CONTRACT_INTERFACE).toEqual({
      profile: PROFILE_IDENTITY_WALLET_ABI,
      identity: IDENTITY_WALLET_ABI,
      storage: IDENTITY_STORAGE_WALLET_ABI,
    });
    expect([
      ...PROFILE_IDENTITY_WALLET_ABI,
      ...IDENTITY_WALLET_ABI,
      ...IDENTITY_STORAGE_WALLET_ABI,
    ].map(identityWalletFunctionSignature)).toEqual([
      'addOperationalWallets(uint72,address[])',
      'addKey(uint72,bytes32,uint256,uint256)',
      'removeKey(uint72,bytes32)',
      'keyHasPurpose(uint72,bytes32,uint256)',
      'getKeysByPurpose(uint72,uint256)',
    ]);
  });
});
