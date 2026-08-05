export const GATE1_RAW_SCHEMA_VERSION = 'dkg-rfc64-gate1-public-open-evidence-v1';
export const GATE1_VERDICT_SCHEMA_VERSION = 'dkg-rfc64-gate1-public-open-verdict-v1';
export const GATE1_ADAPTER_PROTOCOL_VERSION = 'dkg-rfc64-gate1-adapter-protocol-v1';
export const GATE1_REAL_DKG_AGENT_ADAPTER_ID = 'real-dkg-agent-v1';
export const GATE1_AGENT_EVENT_PREFIX = 'RFC64_GATE1_ADAPTER_EVENT ';

/**
 * This is a frozen harness boundary. Product method names may differ, but the
 * process adapter must expose exactly these operations to the orchestrator.
 */
export const REQUIRED_PRODUCTION_ADAPTER_OPERATIONS = Object.freeze([
  'publishGenesis',
  'publishSuccessor',
  'announce',
  'appliedHeadReadback',
  'exactInventoryReadback',
  'killRestart',
] as const);

export type Gate1ProductionAdapterOperation =
  (typeof REQUIRED_PRODUCTION_ADAPTER_OPERATIONS)[number];

export interface Gate1AppliedHeadReadBack {
  readonly appliedInventoryDigest: string;
  readonly catalogVersion: string;
  readonly currentCatalogHeadDigest: string;
  readonly inventoryRowCount: number;
}

export interface Gate1SemanticReadBack {
  readonly activatedQuadCount: number;
  readonly catalogHeadDigest: string;
  readonly catalogRowDigest: string;
  readonly contentDigest: string;
  readonly kaUal: string;
  readonly swmGraph: string;
}

export interface Gate1HeadEvidence {
  readonly appliedInventoryDigest: string;
  readonly catalogHeadDigest: string;
  readonly catalogVersion: string;
  readonly previousCatalogHeadDigest: string;
}

export interface Gate1TransferEvidence {
  readonly activatedQuadCount: number;
  readonly authorAddress: string;
  readonly bundleByteLength: number;
  readonly bundleDigest: string;
  readonly catalogRowDigest: string;
  readonly contentByteLength: number;
  readonly contentDigest: string;
  readonly head: Gate1HeadEvidence;
  readonly inventoryRowCount: number;
  readonly kaUal: string;
  readonly swmGraph: string;
}

export interface Gate1ForgedEvidence {
  readonly attemptedCatalogHeadDigest: string;
  readonly catalogAuthorAddress: string;
  readonly expectedFailureCode: string;
  readonly recoveredAuthorAddress: string;
}

export function appliedReadBackFromTransfer(
  transfer: Gate1TransferEvidence,
): Readonly<Gate1AppliedHeadReadBack> {
  return Object.freeze({
    appliedInventoryDigest: transfer.head.appliedInventoryDigest,
    catalogVersion: transfer.head.catalogVersion,
    currentCatalogHeadDigest: transfer.head.catalogHeadDigest,
    inventoryRowCount: transfer.inventoryRowCount,
  });
}

export function semanticReadBackFromTransfer(
  transfer: Gate1TransferEvidence,
): Readonly<Gate1SemanticReadBack> {
  return Object.freeze({
    activatedQuadCount: transfer.activatedQuadCount,
    catalogHeadDigest: transfer.head.catalogHeadDigest,
    catalogRowDigest: transfer.catalogRowDigest,
    contentDigest: transfer.contentDigest,
    kaUal: transfer.kaUal,
    swmGraph: transfer.swmGraph,
  });
}
