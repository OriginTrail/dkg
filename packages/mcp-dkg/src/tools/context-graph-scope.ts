import type { ProjectRow } from '../client.js';

export function contextGraphBelongsToCaller(row: ProjectRow): boolean {
  if (row.isSystem === true) return false;
  if (row.callerInvolved === true) return true;
  if (row.callerInvolved === false) return false;
  const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : '';
  if (['curator', 'creator', 'owner', 'participant', 'member'].includes(role)) return true;
  // Older daemons did not include callerInvolved. Preserve compatibility by
  // leaving those unscoped rows visible instead of hiding everything.
  return true;
}

export function filterContextGraphsForScope(
  rows: ProjectRow[],
  scope: 'mine' | 'all',
): ProjectRow[] {
  return scope === 'all' ? rows : rows.filter(contextGraphBelongsToCaller);
}
