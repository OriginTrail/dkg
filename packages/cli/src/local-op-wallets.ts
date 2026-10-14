import { resolveChainSignerConfig } from '@origintrail-official/dkg-chain';
import type { OpWalletsConfig } from '@origintrail-official/dkg-agent';
import { DkgHomeFiles } from './config.js';

/** True when the node in `dataDir` delegates EVM signing to an external signer (`chain.signer`). */
export async function usesExternalSigner(dataDir: string): Promise<boolean> {
  const config = await new DkgHomeFiles(dataDir).loadConfig();
  return resolveChainSignerConfig(config.chain?.signer) !== undefined;
}

/**
 * Create or load the node's local operational wallets (`wallets.json`), unless
 * the node signs through an external signer: then no key file is created and
 * undefined is returned.
 */
export async function loadLocalOpWalletsUnlessExternal(dataDir: string): Promise<OpWalletsConfig | undefined> {
  if (await usesExternalSigner(dataDir)) return undefined;
  const { loadOpWallets } = await import('@origintrail-official/dkg-agent');
  return loadOpWallets(dataDir);
}
