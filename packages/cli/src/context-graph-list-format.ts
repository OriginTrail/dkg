/**
 * Terminal rendering for `dkg context-graph list` and `dkg context-graph info`.
 *
 * A row the node discovered on chain may be known only by its on-chain name
 * hash (`nameKnown === false`); its `id` and `name` are then the bare 32-byte
 * hash. The table leads with what a user needs to choose a graph (on-chain id,
 * access, publish policy, creation date, owner, on-chain state) and keeps the
 * full id last, because that id is the handle `dkg subscribe <id>` takes.
 */

/** Chain-public facts the daemon attaches to a list row (`row.onChain`). */
export interface ContextGraphListOnChainView {
  id: string;
  access: 'public' | 'private' | 'unknown';
  publishPolicy: 'curated' | 'open' | 'unknown' | null;
  publishAuthority?: string | null;
  owner: string | null;
  createdAt: string | null;
  active: boolean | null;
  nameHash: string | null;
  observedAtBlock?: number;
}

/** The `/api/context-graph/list` row fields this renderer reads. */
export interface ContextGraphListRowView {
  id: string;
  uri?: string;
  name: string;
  description?: string;
  creator?: string;
  createdAt?: string;
  isSystem: boolean;
  subscribed?: boolean;
  synced?: boolean;
  accessPolicy?: string;
  onChainId?: string;
  nameKnown?: boolean;
  onChain?: ContextGraphListOnChainView;
}

const NONE = '—';

/** The cleartext name, or null when the node knows the graph only by hash. */
export function contextGraphDisplayName(row: ContextGraphListRowView): string | null {
  if (row.nameKnown === false) return null;
  const hashShaped = /^0x[0-9a-f]{64}$/i.test(row.name);
  // Older daemons omit `nameKnown`; a name equal to its own on-chain hash was
  // never a cleartext name either.
  if (hashShaped && row.onChain?.nameHash && row.name.toLowerCase() === row.onChain.nameHash) {
    return null;
  }
  return row.name;
}

export function contextGraphAccess(row: ContextGraphListRowView): string {
  if (row.onChain && row.onChain.access !== 'unknown') return row.onChain.access;
  const local = row.accessPolicy?.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (local === 'public' || local === 'private') return local;
  return row.isSystem ? 'system' : NONE;
}

function onChainId(row: ContextGraphListRowView): string | undefined {
  return row.onChain?.id ?? row.onChainId;
}

function shortAddress(value: string | null | undefined): string {
  if (!value) return NONE;
  const address = /0x[0-9a-fA-F]{40}/.exec(value)?.[0];
  if (address) return `${address.slice(0, 6)}…${address.slice(-4)}`;
  return value.length > 24 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
}

function day(value: string | null | undefined): string {
  if (!value) return NONE;
  const iso = /^\d{4}-\d{2}-\d{2}/.exec(value.replace(/^"|"$/g, ''));
  return iso ? iso[0] : NONE;
}

function onChainState(row: ContextGraphListRowView): string {
  const active = row.onChain?.active;
  if (active === true) return 'active';
  if (active === false) return 'inactive';
  return NONE;
}

function localState(row: ContextGraphListRowView): string {
  if (row.synced) return 'synced';
  if (row.subscribed) return 'subscribed';
  return NONE;
}

function compareRows(a: ContextGraphListRowView, b: ContextGraphListRowView): number {
  if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
  const ai = onChainId(a);
  const bi = onChainId(b);
  if (ai !== undefined && bi !== undefined) {
    const x = BigInt(ai);
    const y = BigInt(bi);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (ai !== undefined) return -1;
  if (bi !== undefined) return 1;
  return a.id.localeCompare(b.id);
}

/** Render the list table as lines, system graphs first, then by on-chain id. */
export function formatContextGraphListTable(rows: readonly ContextGraphListRowView[]): string[] {
  if (rows.length === 0) return ['No context graphs registered yet.'];
  const sorted = [...rows].sort(compareRows);
  const cells = sorted.map((row) => {
    const id = onChainId(row);
    return [
      id === undefined ? NONE : `#${id}`,
      contextGraphAccess(row),
      row.onChain?.publishPolicy ?? NONE,
      day(row.onChain?.createdAt ?? row.createdAt),
      shortAddress(row.onChain?.owner ?? row.creator),
      onChainState(row),
      localState(row),
      contextGraphDisplayName(row) ?? NONE,
      row.id,
    ];
  });
  const header = ['#', 'Access', 'Publish', 'Created', 'Owner', 'State', 'Local', 'Name', 'ID'];
  // The ID column is last and unpadded: it holds the full subscribe handle.
  const widths = header.slice(0, -1).map((title, column) => Math.max(
    title.length,
    ...cells.map((line) => line[column]!.length),
  ));
  const render = (line: string[]) => '  ' + line
    .map((cell, column) => (column < widths.length ? cell.padEnd(widths[column]!) : cell))
    .join('  ');
  const headerLine = render(header);
  const lines = [headerLine, '  ' + '─'.repeat(headerLine.length - 2), ...cells.map(render)];

  const counts = { public: 0, private: 0 };
  let hashOnly = 0;
  for (const row of sorted) {
    const access = contextGraphAccess(row);
    if (access === 'public') counts.public += 1;
    if (access === 'private') counts.private += 1;
    if (contextGraphDisplayName(row) === null) hashOnly += 1;
  }
  lines.push('');
  lines.push(
    `  ${rows.length} context graph(s): ${counts.public} public, ${counts.private} private`,
  );
  if (hashOnly > 0) {
    lines.push(
      `  ${hashOnly} known only by on-chain name hash (Name ${NONE}). A public one can be `
      + 'subscribed by its ID (`dkg subscribe <ID>`); the node then resolves and verifies its name.',
    );
  }
  return lines;
}

/** Render `dkg context-graph info` as lines. */
export function formatContextGraphInfo(row: ContextGraphListRowView): string[] {
  const name = contextGraphDisplayName(row);
  const chain = row.onChain;
  const lines = [
    `  ID:             ${row.id}`,
    ...(row.uri ? [`  URI:            ${row.uri}`] : []),
    `  Name:           ${name ?? `${NONE} (known only by its on-chain name hash)`}`,
    `  Description:    ${row.description ?? NONE}`,
    `  Type:           ${row.isSystem ? 'system' : 'user'}`,
    `  Access:         ${contextGraphAccess(row)}`,
    `  Local:          ${localState(row)}`,
  ];
  const id = onChainId(row);
  if (id !== undefined || chain) {
    lines.push(`  On-chain id:    ${id ?? NONE}`);
  }
  if (chain) {
    lines.push(
      `  Publish policy: ${chain.publishPolicy ?? NONE}`
        + (chain.publishAuthority ? ` (authority ${chain.publishAuthority})` : ''),
      `  Owner:          ${chain.owner ?? NONE}`,
      `  Created:        ${chain.createdAt ?? NONE}`,
      `  State:          ${onChainState(row)}`,
      `  Name hash:      ${chain.nameHash ?? `${NONE} (opted out)`}`,
    );
  } else {
    lines.push(
      `  Creator:        ${row.creator ?? NONE}`,
      `  Created:        ${row.createdAt ?? NONE}`,
    );
  }
  return lines;
}
