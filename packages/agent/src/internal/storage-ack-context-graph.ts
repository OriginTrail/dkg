/**
 * Validate the target chain ID before ACK preflight or collection. The source
 * SWM graph name is separate and need not be numeric. Keep native BigInt parsing
 * so existing numeric spellings remain accepted, but reject zero and negatives
 * before the contract or uint256 encoder would fail with a less useful error.
 */
export function requireStorageACKContextGraphId(
  contextGraphId: string,
  operation: 'publish' | 'update',
): bigint {
  const prefix = operation === 'publish' ? 'V10 ACK collection' : 'V10 UPDATE ACK collection';
  const guidance = operation === 'publish'
    ? ' Register the CG on-chain via ContextGraphs.createContextGraph first.'
    : '';
  let id: bigint;
  try {
    id = BigInt(contextGraphId);
  } catch {
    throw new Error(`${prefix} requires a numeric on-chain context graph id; got '${contextGraphId}'.${guidance}`);
  }
  if (id <= 0n) {
    throw new Error(`${prefix} requires a positive on-chain context graph id; got ${id}.${guidance}`);
  }
  return id;
}
