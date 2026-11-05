import type { ContextGraphMembership } from '@origintrail-official/dkg-core';

export interface ProjectRow extends ContextGraphMembership {
  id: string;
  name?: string;
  nameKnown?: boolean;
  onChain?: { nameHash?: string | null };
  description?: string;
  role?: string;
  layer?: string;
  isSystem?: boolean;
  [key: string]: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Normalize untrusted transport fields once, before membership and name selection. */
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

/** MCP trusts explicit name provenance; legacy placeholders match the exact ID. */
export function contextGraphDisplayName(row: ProjectRow): string | null {
  if (row.nameKnown === false || row.name === undefined || !row.name.trim()) return null;
  if (row.nameKnown === true) return row.name;
  if (/^0x[0-9a-f]{64}$/i.test(row.name) && row.name === row.id) return null;
  return row.name;
}
