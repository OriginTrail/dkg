import type {
  AssetRowV1,
  CatalogScopeV1,
} from './src/schema.ts';

export const GATE2_RAW_SCHEMA_VERSION =
  'dkg-rfc64-gate2-multi-asset-evidence-v1' as const;
export const GATE2_VERDICT_SCHEMA_VERSION =
  'dkg-rfc64-gate2-multi-asset-verdict-v1' as const;
export const GATE2_ADAPTER_PROTOCOL_VERSION =
  'dkg-rfc64-gate2-adapter-protocol-v1' as const;
export const GATE2_REAL_DKG_AGENT_ADAPTER_ID = 'real-dkg-agent-gate2-v1' as const;
export const GATE2_AGENT_EVENT_PREFIX = 'RFC64_GATE2_ADAPTER_EVENT ' as const;

export const REQUIRED_PRODUCTION_ADAPTER_OPERATIONS = Object.freeze([
  'publishGenesis',
  'publishExactSetSuccessor',
  'announce',
  'appliedHeadReadback',
  'exactInventoryReadback',
  'terminalFailureReadback',
  'killRestart',
] as const);

export interface Gate2AppliedHeadReadBack {
  readonly appliedInventoryDigest: string;
  readonly catalogVersion: string;
  readonly currentCatalogHeadDigest: string;
  readonly inventoryRowCount: number;
}

export interface Gate2AuthoredInventory {
  readonly catalogScope: CatalogScopeV1;
  readonly declaredCatalogScopeDigest: string;
  readonly catalogHeadDigest: string;
  readonly catalogHeadTotalRows: string;
  readonly signedBucketRowCount: string;
  readonly signedRows: readonly AssetRowV1[];
}

export interface Gate2ReceivedInventory {
  readonly catalogHeadDigest: string;
  readonly declaredInventoryDigest: string;
  readonly inventoryRowCount: number;
  readonly activatedRows: readonly AssetRowV1[];
}

export interface Gate2SemanticReadBack {
  readonly activatedQuadCount: number;
  readonly projectionNQuads: string;
  readonly swmGraph: string;
}

export function appliedReadBackFromInventories(
  authored: Gate2AuthoredInventory,
  received: Gate2ReceivedInventory,
  catalogVersion: string,
): Readonly<Gate2AppliedHeadReadBack> {
  return Object.freeze({
    appliedInventoryDigest: received.declaredInventoryDigest,
    catalogVersion,
    currentCatalogHeadDigest: authored.catalogHeadDigest,
    inventoryRowCount: received.inventoryRowCount,
  });
}
