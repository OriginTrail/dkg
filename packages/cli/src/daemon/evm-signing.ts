/**
 * How the daemon signs EVM transactions: with the operational keys in
 * `wallets.json` (the default), or through an external signer configured in
 * `chain.signer`, in which case the node creates and loads no operational
 * private key at all.
 */
import { agentKeystorePath, assertKeystoreHoldsNoPayerKey, loadOpWallets, readAgentKeystore } from '@origintrail-official/dkg-agent';
import {
  connectConfiguredRemoteSigners,
  resolveChainSignerConfig,
  type RemoteAuthorSigners,
  type RemoteSigner,
} from '@origintrail-official/dkg-chain';
import { isPublisherRuntimeEnabled, type DkgConfig } from '../config.js';

/** The wallet facts the HTTP routes need: addresses only, never keys. */
export interface OperationalWalletAddresses {
  readonly adminWallet?: { readonly address: string };
  readonly wallets: ReadonlyArray<{ readonly address: string }>;
}

export type DaemonEvmSigning = (
  | {
    readonly mode: 'local';
    readonly addresses: OperationalWalletAddresses;
    readonly chainSigning: { adminPrivateKey?: string; operationalKeys: string[] };
  }
  | {
    readonly mode: 'remote';
    readonly addresses: OperationalWalletAddresses;
    readonly chainSigning: { signers: RemoteSigner[]; authors?: RemoteAuthorSigners };
  }
) & {
  /**
   * Close the connections to the external signer once nothing signs any more,
   * at shutdown. Calling it again does nothing; with local keys it does nothing.
   */
  readonly release: () => void;
};

export interface ResolveDaemonEvmSigningInput {
  config: Pick<DkgConfig, 'chain' | 'nodeRole' | 'publisher'>;
  /** The effective chain type (`mock` when the daemon runs the in-memory chain). */
  chainType: string | undefined;
  dataDir: string;
  log: (line: string) => void;
}

/**
 * Resolve the signing mode, load or connect the signers, and log what the node
 * signs with. Throws (with an operator-facing message) when the configuration
 * cannot be served, before any key is created.
 */
export async function resolveDaemonEvmSigning(input: ResolveDaemonEvmSigningInput): Promise<DaemonEvmSigning> {
  const { config, log } = input;
  const remote = resolveChainSignerConfig(config.chain?.signer);
  if (remote === undefined) {
    // Load admin + operational wallets from wallets.json (auto-generated on first run).
    const opWallets = await loadOpWallets(input.dataDir);
    log(`Admin wallet:`);
    log(opWallets.adminWallet
      ? `  ${opWallets.adminWallet.address}`
      : `  (missing from legacy wallets.json; auto-registration requires adding the profile admin key)`);
    log(`Operational wallets (${opWallets.wallets.length}):`);
    for (const w of opWallets.wallets) log(`  ${w.address}`);
    return {
      mode: 'local',
      release: () => {},
      addresses: {
        ...(opWallets.adminWallet ? { adminWallet: { address: opWallets.adminWallet.address } } : {}),
        wallets: opWallets.wallets.map((w) => ({ address: w.address })),
      },
      chainSigning: {
        ...(opWallets.adminWallet ? { adminPrivateKey: opWallets.adminWallet.privateKey } : {}),
        operationalKeys: opWallets.wallets.map((w) => w.privateKey),
      },
    };
  }
  if (input.chainType === 'mock') {
    throw new Error('chain.signer.type "remote" requires an EVM chain; it cannot be combined with chain.type "mock"');
  }
  if ((config.nodeRole ?? 'edge') === 'core') {
    throw new Error(
      'chain.signer.type "remote" is supported for edge nodes only: a core node signs StorageACKs, ' +
        'VERIFY approvals and profile operations with local keys',
    );
  }
  if (isPublisherRuntimeEnabled(config.publisher)) {
    throw new Error(
      'publisher.enabled (the async publisher runtime) signs with the keys in publisher-wallets.json ' +
        'and cannot be combined with chain.signer.type "remote"',
    );
  }
  const signers = await connectConfiguredRemoteSigners(remote, { onWarning: (message) => log(`[warn] ${message}`) });
  try {
    // A node that used local wallets keeps its former operational key as an
    // agent's key: it must not start while that account is one of the payers.
    const keystorePath = agentKeystorePath(input.dataDir);
    const payers = signers.operational.map((signer) => signer.address);
    assertKeystoreHoldsNoPayerKey(await readAgentKeystore(keystorePath), payers, keystorePath);
  } catch (err) {
    signers.destroy();
    throw err;
  }
  const endpoint = signers.operational[0].client.endpoint;
  log(`EVM signing: external signer at ${endpoint}; the node holds no operational private key`);
  log(`Payer accounts (${signers.operational.length}):`);
  for (const signer of signers.operational) log(`  ${signer.address}`);
  const authors = signers.authors;
  if (authors === undefined) {
    log('Author keys: none configured (publishing requires an agent with its own key)');
  } else {
    log(`Author keys at ${authors.endpoint}: ${authors.addresses.length}; ` +
      `default author ${authors.defaultAuthor?.address ?? '(none: requests must name an agent)'}`);
  }
  return {
    mode: 'remote',
    release: () => signers.destroy(),
    addresses: { wallets: signers.operational.map((signer) => ({ address: signer.address })) },
    chainSigning: {
      signers: signers.operational,
      ...(authors === undefined ? {} : { authors }),
    },
  };
}
