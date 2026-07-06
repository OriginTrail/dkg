// The sync display FACE of the PCA owner-access model (#1375). Kept in its own file so the
// classifier (`./ownerAccess.ts`) stays PURE — no React / wallet-store dependency. It reads the
// connected wallet + wrong-network from the wallet store and runs the pure core against
// already-loaded owner/primaryWallet props. Use in render paths (detail view, overview, cards).
//
// The async, deliberately re-fetching face stays in
// `ownerActions.resolveOwnerActionSubmitterForAccount` — do NOT force it onto React state.
import { isWrongNetwork, useWalletStore } from '../stores/wallet.js';
import { resolvePcaOwnerAccess, type PcaOwnerAccess, type PcaPrimaryWalletState } from './ownerAccess.js';

export function usePcaOwnerAccess(input: {
  owner?: string | null;
  primaryWallet?: string | null;
  primaryWalletState?: PcaPrimaryWalletState;
}): PcaOwnerAccess {
  const connectedWallet = useWalletStore((s) => s.address);
  const walletWrongNetwork = useWalletStore((s) => isWrongNetwork(s));
  return resolvePcaOwnerAccess({
    owner: input.owner,
    primaryWallet: input.primaryWallet,
    connectedWallet,
    walletWrongNetwork,
    primaryWalletState: input.primaryWalletState,
  });
}
