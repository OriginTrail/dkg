/** Name provenance returned by context-graph discovery; safe for browser consumers. */
export interface ContextGraphName {
  id: string;
  name?: string;
  nameKnown?: boolean;
  onChain?: { nameHash?: string | null };
}

/** Explicit compatibility choices retain each client's existing daemon contract. */
export interface ContextGraphNamePolicy {
  legacyHashSource: 'id' | 'on-chain';
  knownNameIsAuthoritative: boolean;
  blankNameIsUnresolved: boolean;
}

/** Select cleartext without coupling shared provenance rules to presentation labels. */
export function selectContextGraphName(row: ContextGraphName, policy: ContextGraphNamePolicy): string | null {
  if (row.nameKnown === false || row.name === undefined) return null;
  if (policy.blankNameIsUnresolved && !row.name.trim()) return null;
  if (policy.knownNameIsAuthoritative && row.nameKnown === true) return row.name;
  const placeholder = policy.legacyHashSource === 'id' ? row.id : row.onChain?.nameHash;
  const comparableName = policy.legacyHashSource === 'id' ? row.name : row.name.toLowerCase();
  if (/^0x[0-9a-f]{64}$/i.test(row.name) && comparableName === placeholder) return null;
  return row.name;
}
