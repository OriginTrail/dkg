import { createHash } from 'node:crypto';

export const GATE1_RAW_SCHEMA_VERSION = 'dkg-rfc64-gate1-public-open-evidence-v1';
export const GATE1_VERDICT_SCHEMA_VERSION = 'dkg-rfc64-gate1-public-open-verdict-v1';
export const GATE1_ADAPTER_PROTOCOL_VERSION = 'dkg-rfc64-gate1-adapter-protocol-v1';
export const GATE1_FIXTURE_ADAPTER_ID = 'deterministic-fixture-adapter-v1';
export const REQUIRED_PRODUCTION_ADAPTER_OPERATIONS = Object.freeze([
  'publishGenesis',
  'publishSuccessor',
  'announce',
  'appliedHeadReadback',
  'exactInventoryReadback',
  'killRestart',
] as const);

export const INSPECTED_PRODUCT_COMMITS = Object.freeze([
  '6c14bd4ad15b79cc889d0308dd1d1cac60467747',
  'ebbfb34f9bd0a0833ee5adb925cba67c527c91a8',
] as const);

const AUTHOR_ADDRESS = '0xdb2430b4e9ac14be6554d3942822be74811a1af9';
const ATTACKER_ADDRESS = '0xae72a48c1a36bd18af168541c53037965d26e4a8';
const CONTENT_DIGEST = '0xb9621d6cd997ab772d2efc3aa2afa2bcdacc46c74359bfb282c058fa46bb431a';
const BUNDLE_DIGEST = '0x14d4274f8eddb559e4a66ea245f697aba41a4263ea049b77e0b3c88adc936c7a';
const CATALOG_ROW_DIGEST = '0x6420e45a533a22aebf4628a123cfed9ee11f033c239af875c07aa05231547638';
const PREDECESSOR_HEAD_DIGEST =
  '0x2ab4b76154241174ba4dc08b4ca38094b6f996518662707bdec599f8de87be71';
const POSITIVE_HEAD_DIGEST =
  '0xe761f8c9ce23a199803881221a8bac6ded18a2f366e0f22a7599adfe76eb8838';
const POSITIVE_INVENTORY_DIGEST =
  '0x0a3f2f203019eb21778e270436da1ea01d70b5c2fce0ed811679cd2ffe82c980';
const REPAIR_HEAD_DIGEST =
  '0x26423bc0d28c8d49b5f7c59bf3e8563c23b55c31ba28d3aa745bc1a885de4761';
const REPAIR_INVENTORY_DIGEST =
  '0xd256bbc0577d7c0bb7f6cb4a2e4d29ff552cacee08f0c5ca0e073d0111e60fc2';
const FORGED_HEAD_DIGEST =
  '0xa0b122ac45e5ddeda48ca2aa54e1c02279af5156d93b63b0120d76a815bee2a7';

export interface Gate1HeadFixture {
  readonly appliedInventoryDigest: string;
  readonly catalogHeadDigest: string;
  readonly catalogVersion: string;
  readonly previousCatalogHeadDigest: string;
}

export interface Gate1TransferFixture {
  readonly activatedQuadCount: number;
  readonly authorAddress: string;
  readonly bundleByteLength: number;
  readonly bundleDigest: string;
  readonly catalogRowDigest: string;
  readonly contentByteLength: number;
  readonly contentDigest: string;
  readonly head: Gate1HeadFixture;
  readonly inventoryRowCount: number;
  readonly kaUal: string;
  readonly swmGraph: string;
}

export interface Gate1ForgedFixture {
  readonly attemptedCatalogHeadDigest: string;
  readonly catalogAuthorAddress: string;
  readonly expectedFailureCode: string;
  readonly recoveredAuthorAddress: string;
}

export const GATE1_FIXTURE = Object.freeze({
  authorPeerId: 'fixture-peer-author-v1',
  receiverPeerId: 'fixture-peer-receiver-v1',
  projectionNQuads:
    '<https://example.org/alice> <https://schema.org/age> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .\n'
    + '<https://example.org/alice> <https://schema.org/name> "Alice" .\n',
  positive: Object.freeze({
    activatedQuadCount: 2,
    authorAddress: AUTHOR_ADDRESS,
    bundleByteLength: 203,
    bundleDigest: BUNDLE_DIGEST,
    catalogRowDigest: CATALOG_ROW_DIGEST,
    contentByteLength: 168,
    contentDigest: CONTENT_DIGEST,
    head: Object.freeze({
      appliedInventoryDigest: POSITIVE_INVENTORY_DIGEST,
      catalogHeadDigest: POSITIVE_HEAD_DIGEST,
      catalogVersion: '1',
      previousCatalogHeadDigest: PREDECESSOR_HEAD_DIGEST,
    }),
    inventoryRowCount: 1,
    kaUal: `did:dkg:otp:20430/${AUTHOR_ADDRESS}/7`,
    swmGraph: `did:dkg:swm:0x1111111111111111111111111111111111111111/gate-1/${AUTHOR_ADDRESS}/7`,
  }) satisfies Gate1TransferFixture,
  repairSuccessor: Object.freeze({
    activatedQuadCount: 2,
    authorAddress: AUTHOR_ADDRESS,
    bundleByteLength: 203,
    bundleDigest: BUNDLE_DIGEST,
    catalogRowDigest: CATALOG_ROW_DIGEST,
    contentByteLength: 168,
    contentDigest: CONTENT_DIGEST,
    head: Object.freeze({
      appliedInventoryDigest: REPAIR_INVENTORY_DIGEST,
      catalogHeadDigest: REPAIR_HEAD_DIGEST,
      catalogVersion: '2',
      previousCatalogHeadDigest: POSITIVE_HEAD_DIGEST,
    }),
    inventoryRowCount: 1,
    kaUal: `did:dkg:otp:20430/${AUTHOR_ADDRESS}/7`,
    swmGraph: `did:dkg:swm:0x1111111111111111111111111111111111111111/gate-1/${AUTHOR_ADDRESS}/7`,
  }) satisfies Gate1TransferFixture,
  forged: Object.freeze({
    attemptedCatalogHeadDigest: FORGED_HEAD_DIGEST,
    catalogAuthorAddress: AUTHOR_ADDRESS,
    expectedFailureCode: 'catalog-native-receiver-transfer',
    recoveredAuthorAddress: ATTACKER_ADDRESS,
  }) satisfies Gate1ForgedFixture,
});

export function expectedAppliedReadBack(fixture: Gate1TransferFixture): Readonly<{
  appliedInventoryDigest: string;
  catalogVersion: string;
  currentCatalogHeadDigest: string;
  inventoryRowCount: number;
}> {
  return Object.freeze({
    appliedInventoryDigest: fixture.head.appliedInventoryDigest,
    catalogVersion: fixture.head.catalogVersion,
    currentCatalogHeadDigest: fixture.head.catalogHeadDigest,
    inventoryRowCount: fixture.inventoryRowCount,
  });
}

export function assertFixtureDerivations(): void {
  const projection = GATE1_FIXTURE.projectionNQuads;
  const bundle = `dkg-rfc64-opaque-bundle-fixture-v1\n${projection}`;
  const row = JSON.stringify({
    assertionCoordinate: 'gate-1-object',
    bundleDigest: BUNDLE_DIGEST,
    contentDigest: CONTENT_DIGEST,
    kaUal: GATE1_FIXTURE.positive.kaUal,
    quadCount: 2,
  });
  const positiveHead = JSON.stringify({
    catalogRowDigest: CATALOG_ROW_DIGEST,
    catalogVersion: '1',
    previousCatalogHeadDigest: PREDECESSOR_HEAD_DIGEST,
    totalRows: '1',
  });
  const repairHead = JSON.stringify({
    catalogRowDigest: CATALOG_ROW_DIGEST,
    catalogVersion: '2',
    previousCatalogHeadDigest: POSITIVE_HEAD_DIGEST,
    totalRows: '1',
  });
  const forgedHead = JSON.stringify({
    catalogAuthorAddress: AUTHOR_ADDRESS,
    catalogRowDigest: CATALOG_ROW_DIGEST,
    recoveredAuthorAddress: ATTACKER_ADDRESS,
  });
  requireDerived(sha256(projection), CONTENT_DIGEST, 'content digest');
  requireDerived(Buffer.byteLength(projection), 168, 'content byte length');
  requireDerived(sha256(bundle), BUNDLE_DIGEST, 'bundle digest');
  requireDerived(Buffer.byteLength(bundle), 203, 'bundle byte length');
  requireDerived(sha256(`${row}\n`), CATALOG_ROW_DIGEST, 'catalog row digest');
  requireDerived(
    sha256('dkg-rfc64-gate1-predecessor-v1\n'),
    PREDECESSOR_HEAD_DIGEST,
    'predecessor head digest',
  );
  requireDerived(sha256(`${positiveHead}\n`), POSITIVE_HEAD_DIGEST, 'positive head digest');
  requireDerived(sha256(`${repairHead}\n`), REPAIR_HEAD_DIGEST, 'repair head digest');
  requireDerived(sha256(`${forgedHead}\n`), FORGED_HEAD_DIGEST, 'forged head digest');
  requireDerived(
    inventoryDigest(POSITIVE_HEAD_DIGEST),
    POSITIVE_INVENTORY_DIGEST,
    'positive inventory digest',
  );
  requireDerived(
    inventoryDigest(REPAIR_HEAD_DIGEST),
    REPAIR_INVENTORY_DIGEST,
    'repair inventory digest',
  );
}

function inventoryDigest(headDigest: string): string {
  return sha256(
    `dkg-rfc64-applied-inventory-v1\n${headDigest}\n${CATALOG_ROW_DIGEST}\n`
      + `${CONTENT_DIGEST}\n2\n`,
  );
}

function sha256(value: string): string {
  return `0x${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function requireDerived(actual: string | number, expected: string | number, label: string): void {
  if (actual !== expected) {
    throw new Error(`RFC-64 Gate 1 fixture ${label} changed: ${actual} != ${expected}`);
  }
}
