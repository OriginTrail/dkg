import { isTransientRpcTransportFailureWithoutTransaction } from '@origintrail-official/dkg-chain';

type CatalogFloorAuthoritySite = 'finalized-proof' | 'name-binding' | 'access-policy';
const CODE = 'CATALOG_FLOOR_AUTHORITY_UNAVAILABLE';

/** Preserve a recognized read outage without turning an unavailable proof into authorization. */
export function throwIfCatalogFloorAuthorityUnavailable(cause: unknown, site: CatalogFloorAuthoritySite): void {
  if (!isTransientRpcTransportFailureWithoutTransaction(cause)) return;
  throw Object.assign(new Error(`Catalog floor authority unavailable (${site})`, { cause }), {
    code: CODE,
    site,
  });
}

/** A cause class only; callers must independently prove persisted validated + never dispatched. */
export function isCatalogFloorAuthorityUnavailable(error: unknown): boolean {
  try {
    const candidate = error as {
      code?: unknown; site?: unknown; cause?: unknown;
      txHash?: unknown; transactionHash?: unknown; receipt?: unknown;
    } | null | undefined;
    if (candidate?.code !== CODE) return false;
    // This proof-read marker never carries transaction evidence; refuse contradictory wrappers.
    if (candidate.txHash != null || candidate.transactionHash != null || candidate.receipt != null) return false;
    const site = candidate.site;
    return (site === 'finalized-proof' || site === 'name-binding' || site === 'access-policy')
      && isTransientRpcTransportFailureWithoutTransaction(candidate.cause);
  } catch {
    return false;
  }
}
