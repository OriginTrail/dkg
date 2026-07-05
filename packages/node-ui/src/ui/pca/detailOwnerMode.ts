/**
 * The PCA detail-view owner-signing model. Lives in the PCA domain layer (not the
 * page) so the extracted section components can share the contract without importing
 * the composing page. This is the DETAIL-scoped resolver only; the cross-consumer
 * owner-access model (overview / cards / approve / submitter) is tracked separately
 * under #1375.
 */

/** Case-insensitive address equality. */
export const eqAddress = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export type DetailOwnerMode = 'daemon' | 'wallet' | 'external' | 'unknown';

/**
 * Resolve the owner-signing mode for a PCA in the detail view (inv-17 precedence):
 * `daemon` if the owner is this node's primary operational wallet (wins even when
 * that same address is the connected wallet); `wallet` if a different connected
 * wallet owns it; otherwise `external`.
 */
export function detailOwnerMode(
  owner: string,
  primaryWallet?: string,
  connectedWallet?: string | null,
): DetailOwnerMode {
  if (eqAddress(owner, primaryWallet)) return 'daemon';
  if (connectedWallet && eqAddress(owner, connectedWallet) && !eqAddress(owner, primaryWallet)) return 'wallet';
  return 'external';
}
