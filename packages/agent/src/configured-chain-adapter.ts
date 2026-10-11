import {
  EVMChainAdapter,
  NoChainAdapter,
  type ChainAdapter,
  type EVMAdapterConfig,
  type OperationalSignerSource,
} from '@origintrail-official/dkg-chain';
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

/**
 * The agent's chain adapter: the injected one, an EVM adapter over the
 * configured operational keys or external signers, or the no-chain adapter.
 * `operationalKeys` are the local keys only; with external signers it is
 * undefined, and nothing on this node holds an operational private key.
 */
export function constructConfiguredChainAdapter(
  config: ChainAdapterConstructionConfig,
  contextGraphAuthorityIndexBootstrap?: EVMAdapterConfig['contextGraphAuthorityIndexBootstrap'],
): Readonly<{ chain: ChainAdapter; operationalKeys: string[] | undefined }> {
  const core = (config.nodeRole ?? 'edge') === 'core';
  let operationalKeys = config.chainConfig?.operationalKeys;
  if (config.chainAdapter) {
    const chain = config.chainAdapter;
    // A supplied adapter whose wallets sign externally is held to the same rule as configured signers.
    if (core && signsThroughExternalSigner(config, chain)) throw new Error(EXTERNAL_SIGNERS_EDGE_ONLY);
    if (!operationalKeys?.length) {
      const key = adapterOperationalPrivateKey(chain);
      if (key !== undefined) operationalKeys = [key];
    }
    return { chain, operationalKeys };
  }
  const signers = config.chainConfig?.signers ?? [];
  if (config.chainConfig && signers.length > 0) {
    if (operationalKeys?.length) {
      throw new Error('DKGAgentConfig.chainConfig: configure either operationalKeys or signers, not both');
    }
    if (core) throw new Error(EXTERNAL_SIGNERS_EDGE_ONLY);
  }
  if (config.chainConfig && (operationalKeys?.length || signers.length > 0)) {
    // Exactly one source of operational wallets reaches the adapter.
    const source: OperationalSignerSource = signers.length > 0
      ? { signers }
      : { privateKey: operationalKeys![0], additionalKeys: operationalKeys!.slice(1) };
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
    return { chain, operationalKeys: signers.length > 0 ? undefined : operationalKeys };
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
