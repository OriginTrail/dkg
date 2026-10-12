import {
  EVMChainAdapter,
  NoChainAdapter,
  type ChainAdapter,
  type EVMAdapterConfig,
} from '@origintrail-official/dkg-chain';
import { operationalSignerSourceOf } from './agent-chain-signer-source.js';
import type { DKGAgentConfig } from './dkg-agent-types.js';
import { signsThroughExternalSigner } from './external-author-signing.js';

type ChainAdapterConstructionConfig = Pick<
  DKGAgentConfig,
  | 'chainAdapter'
  | 'chainConfig'
  | 'nodeRole'
  | 'contextGraphRegistryScanCursorStore'
  | 'localContextGraphAuthorityHistoryStore'
  | 'localContextGraphAuthorityIndexStore'
  | 'chainEventLogStore'
>;

const EXTERNAL_SIGNERS_EDGE_ONLY = 'External EVM signers are supported for edge nodes only: a core node signs StorageACKs, '
  + 'VERIFY approvals and profile operations with local keys';
const EXTERNAL_SIGNERS_NO_LOCAL_KEYS = 'DKGAgentConfig: chainConfig.operationalKeys are local wallet keys and cannot be combined '
  + 'with a supplied chainAdapter whose wallets sign through an external signer: such a node holds no operational key, '
  + 'and its agents sign with author keys of the external signer';
const EXTERNAL_ADAPTER_EXPOSES_KEY = 'DKGAgentConfig: a supplied chainAdapter that reports its wallets sign through an external signer '
  + 'cannot also expose a local operational key';

/**
 * The agent's chain adapter: the injected one, an EVM adapter over the
 * configured operational keys or external signers, or the no-chain adapter.
 * `operationalKeys` are the local keys only; with external signers it is
 * undefined, and nothing on this node holds an operational private key.
 * Whether the node signs externally is then the adapter's to say
 * (`signsThroughExternalSigner`), however it was made.
 */
export function constructConfiguredChainAdapter(
  config: ChainAdapterConstructionConfig,
  contextGraphAuthorityIndexBootstrap?: EVMAdapterConfig['contextGraphAuthorityIndexBootstrap'],
): Readonly<{ chain: ChainAdapter; operationalKeys: string[] | undefined }> {
  const core = (config.nodeRole ?? 'edge') === 'core';
  let operationalKeys = config.chainConfig?.operationalKeys;
  if (config.chainAdapter) {
    const chain = config.chainAdapter;
    if (config.chainConfig?.signers?.length) {
      throw new Error('DKGAgentConfig: chainConfig.signers build the agent\'s own chain adapter and cannot be combined with a supplied chainAdapter');
    }
    // A supplied adapter whose wallets sign externally is held to the same rules as configured signers:
    // edge nodes only, and no local operational key, configured or its own, which would become an agent's key and sign locally.
    if (signsThroughExternalSigner(chain)) {
      if (core) throw new Error(EXTERNAL_SIGNERS_EDGE_ONLY);
      if (operationalKeys?.length) throw new Error(EXTERNAL_SIGNERS_NO_LOCAL_KEYS);
      if (adapterOperationalPrivateKey(chain) !== undefined) throw new Error(EXTERNAL_ADAPTER_EXPOSES_KEY);
    }
    if (!operationalKeys?.length) {
      const key = adapterOperationalPrivateKey(chain);
      if (key !== undefined) operationalKeys = [key];
    }
    return { chain, operationalKeys };
  }
  // Exactly one source of operational wallets reaches the adapter, if the configuration names one.
  const source = config.chainConfig === undefined ? undefined : operationalSignerSourceOf(config.chainConfig);
  if (config.chainConfig && source) {
    const external = source.signers !== undefined;
    if (external && core) throw new Error(EXTERNAL_SIGNERS_EDGE_ONLY);
    const evmConfigBase = {
      rpcUrl: config.chainConfig.rpcUrl,
      rpcUrls: config.chainConfig.rpcUrls,
      rpcRequestAdmission: config.chainConfig.rpcRequestAdmission,
      walletRpcUrls: config.chainConfig.walletRpcUrls,
      ...source,
      hubAddress: config.chainConfig.hubAddress,
      tokenAddress: config.chainConfig.tokenAddress,
      chainId: config.chainConfig.chainId,
      receiptTimeoutMs: config.chainConfig.receiptTimeoutMs,
      finalityConfirmations: config.chainConfig.finalityConfirmations,
      indexTickMs: config.chainConfig.indexTickMs,
      boundedAuthorityReads: config.chainConfig.boundedAuthorityReads,
      maxFeePerGasWei: config.chainConfig.maxFeePerGasWei,
      approvalPolicy: config.chainConfig.approvalPolicy,
      cgRegistryScanPageSize: config.chainConfig.cgRegistryScanPageSize,
      minPublisherNativeWei: config.chainConfig.minPublisherNativeWei,
      minPublisherTracWei: config.chainConfig.minPublisherTracWei,
      contextGraphRegistryScanCursorStore: config.contextGraphRegistryScanCursorStore,
      localContextGraphAuthorityHistoryStore: config.localContextGraphAuthorityHistoryStore,
      localContextGraphAuthorityIndexStore: config.localContextGraphAuthorityIndexStore,
      // THE one log. Only this adapter is given the store, so only this
      // adapter owns a tick; every other adapter in the process reads the
      // binding it publishes.
      chainEventLogStore: config.chainEventLogStore,
      contextGraphAuthorityIndexBootstrap,
    };
    const chain = config.chainConfig.adminPrivateKey
      ? new EVMChainAdapter({ ...evmConfigBase, adminPrivateKey: config.chainConfig.adminPrivateKey })
      : new EVMChainAdapter({ ...evmConfigBase, allowNoAdminSigner: true });
    return { chain, operationalKeys: external ? undefined : operationalKeys };
  }
  return { chain: new NoChainAdapter(), operationalKeys };
}

/** An injected adapter's local operational key, if it exposes one. */
function adapterOperationalPrivateKey(chain: ChainAdapter): string | undefined {
  const getter = (chain as { getOperationalPrivateKey?: () => unknown }).getOperationalPrivateKey;
  if (typeof getter !== 'function') return undefined;
  try {
    const key = getter.call(chain);
    return typeof key === 'string' && key.length > 0 ? key : undefined;
  } catch {
    // An adapter that signs through an external signer has no key to expose.
    return undefined;
  }
}
