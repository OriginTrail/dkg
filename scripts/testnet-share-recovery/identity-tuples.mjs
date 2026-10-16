/** Compare exact multisets: duplicate, missing and extra rows all fail. */
export function verifyIdentityTuples(expected, catalogs, inventory) {
  const canonical = rows => JSON.stringify(rows.map(row => JSON.stringify(row)).sort());
  const expectedCatalog = expected.map(({name, seal, sealDigest}) => [name, seal.reservedKaId, seal.assertionVersion, sealDigest]);
  const expectedInventory = expected.map(({name, seal, sealDigest}) => [name, seal.kaUal, seal.assertionVersion, sealDigest]);
  const catalog = catalogs.map(row => [row.assertionCoordinate, row.kaId, row.assertionVersion, row.sealDigest]);
  const actualInventory = inventory.map(row => [row.assertion_coordinate, row.ka_ual, BigInt(row.assertion_version_u64be).toString(), row.seal_digest]);
  const uniqueExpected = new Set(expected.map(row => row.name)).size === expected.length;
  return { expectedCount: expected.length, catalogCount: catalogs.length, inventoryCount: inventory.length,
    uniqueExpected, exactCatalogIdentity: uniqueExpected && canonical(expectedCatalog) === canonical(catalog),
    exactInventoryIdentity: uniqueExpected && canonical(expectedInventory) === canonical(actualInventory) };
}
