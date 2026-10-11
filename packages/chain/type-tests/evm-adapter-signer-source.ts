import { EVMChainAdapter, type EVMAdapterConfig, type EVMAdapterOptions, type EvmSigner } from '../dist/index.js';

// Compile against the published declarations: an adapter takes exactly one
// source of operational wallets, local keys or external signers.
declare const signers: readonly EvmSigner[];
const options = { rpcUrl: 'http://127.0.0.1:8545', hubAddress: '0x0000000000000000000000000000000000000001' };

export const localKeys: EVMAdapterConfig = { ...options, privateKey: '0x01', additionalKeys: ['0x02'] };
export const externalSigners: EVMAdapterConfig = { ...options, signers };
export const adapter = new EVMChainAdapter({ ...options, signers, allowNoAdminSigner: true });

// @ts-expect-error an adapter needs a source of operational wallets
export const noSource: EVMAdapterConfig = { ...options };
// @ts-expect-error additional keys need the primary local key
export const additionalKeysOnly: EVMAdapterConfig = { ...options, additionalKeys: ['0x02'] };
// @ts-expect-error local keys and external signers are mutually exclusive
export const keyAndSigners: EVMAdapterConfig = { ...options, privateKey: '0x01', signers };
// @ts-expect-error additional local keys cannot join external signers
export const signersAndKeys: EVMAdapterConfig = { ...options, signers, additionalKeys: ['0x02'] };

// The options without a source compose with either kind, for code that extended the configuration.
export interface WrappedAdapterOptions extends EVMAdapterOptions {
  label: string;
}
export const wrapped: WrappedAdapterOptions & EVMAdapterConfig = { ...options, label: 'node', privateKey: '0x01' };
