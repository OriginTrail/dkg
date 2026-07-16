export interface ContextGraphTableRow {
  id: string;
  name: string;
  creator?: string;
  isSystem?: boolean;
}

export const CONTEXT_GRAPH_ID_MAX_WIDTH = 48;
export const CONTEXT_GRAPH_NAME_MAX_WIDTH = 40;

function normalizeCell(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim() || '—';
}

export function truncateTableCell(value: unknown, maxWidth: number): string {
  const normalized = normalizeCell(value);
  if (normalized.length <= maxWidth) return normalized;
  return `${normalized.slice(0, Math.max(0, maxWidth - 1))}…`;
}

function formatCreator(value: unknown): string {
  const creator = normalizeCell(value);
  return creator.length > 24
    ? `${creator.slice(0, 12)}...${creator.slice(-8)}`
    : creator;
}

/** Render a bounded terminal table even when remote metadata contains huge cells. */
export function formatContextGraphTable(contextGraphs: ContextGraphTableRow[]): string[] {
  const rows = contextGraphs.map((contextGraph) => ({
    id: truncateTableCell(contextGraph.id, CONTEXT_GRAPH_ID_MAX_WIDTH),
    name: truncateTableCell(contextGraph.name, CONTEXT_GRAPH_NAME_MAX_WIDTH),
    type: contextGraph.isSystem ? 'system' : 'user',
    creator: formatCreator(contextGraph.creator),
  }));
  const idWidth = Math.max(4, ...rows.map((row) => row.id.length));
  const nameWidth = Math.max(4, ...rows.map((row) => row.name.length));
  const header = `  ${'ID'.padEnd(idWidth)}   ${'Name'.padEnd(nameWidth)}   Type       Creator`;

  return [
    header,
    `  ${'─'.repeat(header.length - 2)}`,
    ...rows.map((row) =>
      `  ${row.id.padEnd(idWidth)}   ${row.name.padEnd(nameWidth)}   ${row.type.padEnd(9)}  ${row.creator}`),
    '',
    `  ${contextGraphs.length} context graph(s)`,
  ];
}
