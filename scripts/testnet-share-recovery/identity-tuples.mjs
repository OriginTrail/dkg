/** One normalization/comparison contract for exact sets and exported identity errors. */
export function verifyIdentityTuples(expected, catalogs, inventory) {
  const canonical = rows => JSON.stringify(rows.map(row => JSON.stringify(row)).sort());
  const expectedCatalog = expected.map(({name, seal, sealDigest}) => [name, seal.reservedKaId, seal.assertionVersion, sealDigest]);
  const expectedInventory = expected.map(({name, seal, sealDigest}) => [name, seal.kaUal, seal.assertionVersion, sealDigest]);
  const catalog = catalogs.map(row => [row.assertionCoordinate, row.kaId, row.assertionVersion, row.sealDigest]);
  const actualInventory = inventory.map(row => [row.assertion_coordinate, row.ka_ual, BigInt(row.assertion_version_u64be).toString(), row.seal_digest]);
  const expectedByName = rows => new Map(rows.map(row => [row[0], JSON.stringify(row)]));
  const catalogByName = expectedByName(expectedCatalog), inventoryByName = expectedByName(expectedInventory);
  // Missing rows remain visible through exact-set flags and the full-denominator report.
  // This legacy export field reports identity mismatches in rows actually present.
  const identityErrors = [
    ...catalog.filter(row => catalogByName.get(row[0]) !== JSON.stringify(row)).map(row => ({catalog: row[0]})),
    ...actualInventory.filter(row => inventoryByName.get(row[0]) !== JSON.stringify(row)).map(row => ({inventory: row[0]})),
  ];
  const uniqueExpected = new Set(expected.map(row => row.name)).size === expected.length;
  return { expectedCount: expected.length, catalogCount: catalogs.length, inventoryCount: inventory.length,
    uniqueExpected, exactCatalogIdentity: uniqueExpected && canonical(expectedCatalog) === canonical(catalog),
    exactInventoryIdentity: uniqueExpected && canonical(expectedInventory) === canonical(actualInventory), identityErrors };
}
