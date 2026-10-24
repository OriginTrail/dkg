/**
 * Minimal browser-facing node-identity contract interface.
 *
 * The full canonical ABI snapshots live in `packages/chain/abi`. Keep this
 * surface deliberately small: it contains only the reads and writes used by
 * the daemon's restricted bridge and the node UI's hardware-wallet flow. A
 * chain-package parity test pins every entry to those canonical snapshots.
 */

export interface IdentityWalletAbiParameter {
  readonly internalType: string;
  readonly name: string;
  readonly type: string;
}

export interface IdentityWalletAbiFunction {
  readonly inputs: readonly IdentityWalletAbiParameter[];
  readonly name: string;
  readonly outputs: readonly IdentityWalletAbiParameter[];
  readonly stateMutability: 'nonpayable' | 'view';
  readonly type: 'function';
}

export const PROFILE_IDENTITY_WALLET_ABI = [
  {
    inputs: [
      { internalType: 'uint72', name: 'identityId', type: 'uint72' },
      { internalType: 'address[]', name: 'operationalWallets', type: 'address[]' },
    ],
    name: 'addOperationalWallets',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const satisfies readonly IdentityWalletAbiFunction[];

export const IDENTITY_WALLET_ABI = [
  {
    inputs: [
      { internalType: 'uint72', name: 'identityId', type: 'uint72' },
      { internalType: 'bytes32', name: 'key', type: 'bytes32' },
      { internalType: 'uint256', name: 'keyPurpose', type: 'uint256' },
      { internalType: 'uint256', name: 'keyType', type: 'uint256' },
    ],
    name: 'addKey',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint72', name: 'identityId', type: 'uint72' },
      { internalType: 'bytes32', name: 'key', type: 'bytes32' },
    ],
    name: 'removeKey',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const satisfies readonly IdentityWalletAbiFunction[];

export const IDENTITY_STORAGE_WALLET_ABI = [
  {
    inputs: [
      { internalType: 'uint72', name: 'identityId', type: 'uint72' },
      { internalType: 'bytes32', name: '_key', type: 'bytes32' },
      { internalType: 'uint256', name: '_purpose', type: 'uint256' },
    ],
    name: 'keyHasPurpose',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint72', name: 'identityId', type: 'uint72' },
      { internalType: 'uint256', name: '_purpose', type: 'uint256' },
    ],
    name: 'getKeysByPurpose',
    outputs: [{ internalType: 'bytes32[]', name: '', type: 'bytes32[]' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const satisfies readonly IdentityWalletAbiFunction[];

export const IDENTITY_WALLET_CONTRACT_INTERFACE = Object.freeze({
  profile: PROFILE_IDENTITY_WALLET_ABI,
  identity: IDENTITY_WALLET_ABI,
  storage: IDENTITY_STORAGE_WALLET_ABI,
});

/** Canonical Solidity signature used to derive a function selector. */
export function identityWalletFunctionSignature(
  fragment: Pick<IdentityWalletAbiFunction, 'name' | 'inputs'>,
): string {
  return `${fragment.name}(${fragment.inputs.map((input) => input.type).join(',')})`;
}
