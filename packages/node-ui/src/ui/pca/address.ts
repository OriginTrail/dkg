/**
 * Case-insensitive EVM address equality — the single shared implementation.
 *
 * Every PCA owner-access comparison funnels through this: the owner-mode resolvers
 * (detailOwnerMode / ownerActions / ConvictionOverview / usePcaOverview), the wallet
 * submitter's per-prompt liveness guards, and the wallet-binding probe. Kept as a pure
 * leaf module (no imports) so it can be shared without pulling in the owner-access model.
 */
export const eqAddress = (a?: string | null, b?: string | null): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
