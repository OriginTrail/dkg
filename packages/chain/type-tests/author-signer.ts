import type { Wallet } from 'ethers';
import type {
  AuthorSigner,
  EVMAdapterConfig,
  EvmSigner,
  ExternalAuthorSigners,
  RemoteSigner,
} from '../dist/index.js';

// Compile against the published declarations: an author key is a signing
// capability of its own (typed data and messages for one address), never a
// transaction signer.
const author = {
  address: '0x0000000000000000000000000000000000000002',
  signTypedData: async () => '0x',
  signMessage: async () => '0x',
};

export const authors: ExternalAuthorSigners = {
  defaultAuthor: author,
  addresses: [author.address],
  signerFor: async (address) => (address === author.address ? author : undefined),
  firstSignerOf: async (addresses) => (
    addresses.includes(author.address) ? { address: author.address, signer: author } : undefined
  ),
};

// A local wallet and an external signer's account both provide it.
declare const wallet: Wallet;
declare const remote: RemoteSigner;
export const localAuthor: AuthorSigner = wallet;
export const remoteAuthor: AuthorSigner = remote;

// @ts-expect-error an author key is not an operational signer
export const authorAsSigner: EvmSigner = author;
// @ts-expect-error nor does it pay for transactions as an external signer
export const authorAsPayer: EVMAdapterConfig = { rpcUrl: 'http://127.0.0.1:8545', hubAddress: '0x0000000000000000000000000000000000000001', signers: [author] };
