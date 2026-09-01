/**
 * The four kinds of on-chain Knowledge-Asset root mutation — the NEUTRAL
 * cross-package classification vocabulary (reviews r24/r25): the chain
 * adapter maps event NAMES to these kinds, the publisher's payload carries
 * them, and VM convergence derives its supported/unsupported SUBSETS from
 * this union rather than owning it. A fifth kind lands here first; adopters
 * (delivery, then convergence) pick it up from the one vocabulary. Kept
 * apart from the event-position module deliberately: mutation taxonomy and
 * position representation change for unrelated reasons.
 */
export const KNOWLEDGE_ASSET_ROOT_MUTATION_KINDS_V1 = Object.freeze([
  'lifecycle-update',
  'root-added',
  'roots-replaced',
  'root-removed',
] as const);
export type KnowledgeAssetRootMutationKindV1 = (typeof KNOWLEDGE_ASSET_ROOT_MUTATION_KINDS_V1)[number];
