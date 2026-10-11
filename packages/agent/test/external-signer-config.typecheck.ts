// SPDX-License-Identifier: Apache-2.0

import type { EvmSigner, ExternalEvmSigner } from '@origintrail-official/dkg-chain';
import type { DKGAgentConfig } from '../src/index.js';

type ChainConfig = NonNullable<DKGAgentConfig['chainConfig']>;
declare const external: readonly ExternalEvmSigner[];
declare const localWallet: EvmSigner;
const endpoint = { rpcUrl: 'http://127.0.0.1:8545', hubAddress: '0x0000000000000000000000000000000000000001' };

// External signers are the source the agent builds its own adapter from.
export const externalSigners: ChainConfig = { ...endpoint, signers: external };
export const localKeys: ChainConfig = { ...endpoint, operationalKeys: ['0x01'] };
// @ts-expect-error a local wallet is configured by its key (operationalKeys), never as a signer
export const localSigner: ChainConfig = { ...endpoint, signers: [localWallet] };
// @ts-expect-error signers are wholly external: no local wallet beside them
export const mixedSigners: ChainConfig = { ...endpoint, signers: [...external, localWallet] };
