import type { ContextGraphMembership, ContextGraphName } from '@origintrail-official/dkg-core';

export interface ProjectRow extends ContextGraphMembership, ContextGraphName {
  description?: string;
  role?: string;
  layer?: string;
  isSystem?: boolean;
  [key: string]: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Normalize untrusted transport fields once, before membership and name policies run. */
export function normalizeProjectRows(value: unknown): ProjectRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): ProjectRow[] => {
    if (!record(candidate) || typeof candidate.id !== 'string') return [];
    const row = { ...candidate } as ProjectRow;
    for (const field of ['name', 'curator', 'description', 'role', 'layer'] as const) {
      if (typeof row[field] !== 'string') delete row[field];
    }
    for (const field of ['callerInvolved', 'nameKnown', 'isSystem'] as const) {
      if (typeof row[field] !== 'boolean') delete row[field];
    }
    if (!record(candidate.onChain)) delete row.onChain;
    else {
      const { nameHash, ...chainFields } = candidate.onChain;
      row.onChain = { ...chainFields, ...(typeof nameHash === 'string' || nameHash === null ? { nameHash } : {}) };
    }
    return [row];
  });
}
