// SPDX-License-Identifier: Apache-2.0

import type { EvmSigner, ExternalAuthorSigners, ExternalEvmSigner } from '@origintrail-official/dkg-chain';
import type { DKGAgentConfig } from '../src/index.js';

type ChainConfig = NonNullable<DKGAgentConfig['chainConfig']>;
declare const external: readonly ExternalEvmSigner[];
declare const localWallet: EvmSigner;
const endpoint = { rpcUrl: 'http://127.0.0.1:8545', hubAddress: '0x0000000000000000000000000000000000000001' };

// External signers are the source the agent builds its own adapter from.
export const externalSigners: ChainConfig = { ...endpoint, signers: external };
// Author keys need only the author signing capability.
const author = {
  address: '0x0000000000000000000000000000000000000002',
  signTypedData: async () => '0x',
  signMessage: async () => '0x',
};
const authorSigners: ExternalAuthorSigners = {
  defaultAuthor: author,
  addresses: [author.address],
  signerFor: async () => author,
  firstSignerOf: async (addresses) => (
    addresses.includes(author.address) ? { address: author.address, signer: author } : undefined
  ),
};
// They sit beside the chain configuration, which only builds the operational adapter.
export const withAuthors: Pick<DKGAgentConfig, 'chainConfig' | 'authorSigners'> = {
  chainConfig: { ...endpoint, signers: external },
  authorSigners,
};
export const localKeys: ChainConfig = { ...endpoint, operationalKeys: ['0x01'] };
// A source that may be absent, as callers have always been able to pass it.
declare const maybeKeys: string[] | undefined;
declare const maybeSigners: readonly ExternalEvmSigner[] | undefined;
export const maybeLocalKeys: ChainConfig = { ...endpoint, operationalKeys: maybeKeys };
export const maybeExternalSigners: ChainConfig = { ...endpoint, signers: maybeSigners };
// No source at all: wallets that come with a supplied chain adapter, or no writes.
export const sourceFree: ChainConfig = { ...endpoint };
// A supplied chain adapter with author keys needs no chain configuration at all.
export const authorsOnly: Pick<DKGAgentConfig, 'chainConfig' | 'authorSigners'> = { authorSigners };
// @ts-expect-error author keys are not part of the chain configuration
export const authorsInChainConfig: ChainConfig = { ...endpoint, authors: authorSigners };
// @ts-expect-error one source of operational wallets: local keys or external signers, never both
export const mixedSources: ChainConfig = { ...endpoint, operationalKeys: ['0x01'], signers: external };
// @ts-expect-error a local wallet is configured by its key (operationalKeys), never as a signer
export const localSigner: ChainConfig = { ...endpoint, signers: [localWallet] };
// @ts-expect-error signers are wholly external: no local wallet beside them
export const mixedSigners: ChainConfig = { ...endpoint, signers: [...external, localWallet] };
