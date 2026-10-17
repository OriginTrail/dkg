/** Index only metadata the runtime can read from this Context Graph's authority. */
export function indexAuthoritativeMetadata(rows, metadataGraph, predicates) {
  const index = new Map();
  for (const row of rows) {
    if (row.g.type !== 'uri' || row.g.value !== metadataGraph || (predicates && !predicates.has(row.p.value))) continue;
    let values = index.get(row.s.value);
    if (!values) index.set(row.s.value, values = []);
    values.push(row);
  }
  return index;
}
