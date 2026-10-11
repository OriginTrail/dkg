import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { ApiClient } from '../src/api-client.js';
import { registerContextGraphCommand } from '../src/commands/context-graph.js';
import {
  contextGraphAccess,
  contextGraphDisplayName,
  formatContextGraphInfo,
  formatContextGraphListTable,
  type ContextGraphListRowView,
} from '../src/context-graph-list-format.js';

const PRIVATE_HASH = '0x' + 'a1'.repeat(32);
const PUBLIC_HASH = '0x' + 'b2'.repeat(32);
const INACTIVE_HASH = '0x' + 'c3'.repeat(32);
const OWNER = '0x64529c023d853371228923b4fda5fb22f929bf51';

function chainRow(
  id: string,
  hash: string,
  facts: Partial<NonNullable<ContextGraphListRowView['onChain']>>,
): ContextGraphListRowView {
  return {
    id: hash,
    uri: `did:dkg:context-graph:${hash}`,
    name: hash,
    isSystem: false,
    subscribed: false,
    synced: false,
    onChainId: id,
    nameKnown: false,
    onChain: {
      id,
      access: 'public',
      publishPolicy: 'open',
      publishAuthority: null,
      owner: OWNER,
      createdAt: '2026-09-04T10:11:12.000Z',
      active: true,
      nameHash: hash,
      observedAtBlock: 51_682_578,
      ...facts,
    },
  };
}

/** What a fresh Base node lists after enumeration: #31/#32 private, #33 public. */
const ROWS: ContextGraphListRowView[] = [
  chainRow('33', PUBLIC_HASH, { access: 'public', publishPolicy: 'curated' }),
  chainRow('31', PRIVATE_HASH, { access: 'private', publishPolicy: 'curated' }),
  chainRow('5', INACTIVE_HASH, { active: false, createdAt: '2026-08-01T00:00:00.000Z' }),
  {
    id: 'agents',
    uri: 'did:dkg:context-graph:agents',
    name: 'Agents',
    isSystem: true,
    subscribed: true,
    synced: true,
  },
  {
    id: 'my-research',
    uri: 'did:dkg:context-graph:my-research',
    name: 'My research',
    isSystem: false,
    subscribed: true,
    synced: true,
    accessPolicy: 'private',
    creator: 'did:dkg:agent:0x1111111111111111111111111111111111111111',
    createdAt: '"2026-09-20T08:00:00Z"',
    onChainId: '32',
    nameKnown: true,
    onChain: {
      id: '32',
      access: 'private',
      publishPolicy: 'curated',
      publishAuthority: OWNER,
      owner: OWNER,
      createdAt: '2026-09-20T08:00:01.000Z',
      active: true,
      nameHash: '0x' + 'd4'.repeat(32),
    },
  },
  {
    id: 'draft-local',
    name: 'Draft',
    isSystem: false,
    subscribed: true,
    synced: false,
  },
];

describe('context graph list formatting', () => {
  it('leads with what a user needs to choose a graph and keeps the full id last', () => {
    const lines = formatContextGraphListTable(ROWS);
    const [header, rule, ...body] = lines;

    expect(header).toMatch(/^ {2}#\s+Access\s+Publish\s+Created\s+Owner\s+State\s+Local\s+Name\s+ID$/);
    expect(rule).toMatch(/^ {2}─+$/);
    // System graphs first, then on-chain ids ascending, then local-only rows.
    expect(body.slice(0, 6).map((line) => line.trim().split(/\s+/)[0])).toEqual(
      ['—', '#5', '#31', '#32', '#33', '—'],
    );
    const row31 = body.find((line) => line.includes('#31'))!;
    expect(row31).toMatch(/#31\s+private\s+curated\s+2026-09-04\s+0x6452…bf51\s+active\s+—\s+—\s+0x(a1){32}$/);
    const row33 = body.find((line) => line.includes('#33'))!;
    expect(row33).toMatch(/#33\s+public\s+curated\s+2026-09-04\s+0x6452…bf51\s+active\s+—\s+—\s+0x(b2){32}$/);
    const row5 = body.find((line) => line.includes('#5 '))!;
    expect(row5).toMatch(/#5\s+public\s+open\s+2026-08-01\s+0x6452…bf51\s+inactive/);
    const own = body.find((line) => line.includes('my-research'))!;
    expect(own).toMatch(/#32\s+private\s+curated\s+2026-09-20\s+0x6452…bf51\s+active\s+synced\s+My research\s+my-research$/);
    const system = body.find((line) => line.includes('agents'))!;
    expect(system).toMatch(/system\s+—\s+—\s+—\s+—\s+synced\s+Agents\s+agents$/);
    const draft = body.find((line) => line.includes('draft-local'))!;
    expect(draft).toMatch(/—\s+—\s+—\s+—\s+—\s+—\s+subscribed\s+Draft\s+draft-local$/);

    expect(lines.slice(-2)).toEqual([
      '  6 context graph(s): 2 public, 2 private',
      '  3 known only by on-chain name hash (Name —). A public one can be subscribed by its ID or its '
        + 'on-chain number (`dkg subscribe <ID>` or `dkg subscribe <n>`); the node then resolves and verifies its name.',
    ]);
  });

  it('prints the empty-state line', () => {
    expect(formatContextGraphListTable([])).toEqual(['No context graphs registered yet.']);
  });

  it('never shows a hash as a name, even from a daemon that predates nameKnown', () => {
    const legacy = { ...chainRow('7', PUBLIC_HASH, {}), nameKnown: undefined };
    expect(contextGraphDisplayName(legacy)).toBeNull();
    // A cleartext id that merely looks like a hash is still a name.
    expect(contextGraphDisplayName({ id: PUBLIC_HASH, name: PUBLIC_HASH, isSystem: false })).toBe(PUBLIC_HASH);
    expect(contextGraphAccess({ id: 'x', name: 'x', isSystem: false, accessPolicy: '"Public"' })).toBe('public');
    expect(contextGraphAccess({ id: 'x', name: 'x', isSystem: false, accessPolicy: 'curated' })).toBe('—');
    expect(contextGraphAccess({
      ...chainRow('7', PUBLIC_HASH, { access: 'unknown' }),
      accessPolicy: 'private',
    })).toBe('private');
  });

  it('shortens long non-address creators', () => {
    const lines = formatContextGraphListTable([{
      id: 'peer-created',
      name: 'Peer created',
      isSystem: false,
      creator: 'did:dkg:agent:12D3KooWJ8nChMe3yU5gL9xPBGyAqzYqf9Xp3dQnJ3c8fW7aZ1bC',
    }]);
    expect(lines[2]).toContain('did:dkg:agen…fW7aZ1bC');
  });

  it('renders info with chain facts, and without them for local graphs', () => {
    const info = formatContextGraphInfo(ROWS.find((row) => row.id === PRIVATE_HASH)!);
    expect(info).toEqual([
      `  ID:             ${PRIVATE_HASH}`,
      `  URI:            did:dkg:context-graph:${PRIVATE_HASH}`,
      '  Name:           — (known only by its on-chain name hash)',
      '  Description:    —',
      '  Type:           user',
      '  Access:         private',
      '  Local:          —',
      '  On-chain id:    31',
      '  Publish policy: curated',
      `  Owner:          ${OWNER}`,
      '  Created:        2026-09-04T10:11:12.000Z',
      '  State:          active',
      `  Name hash:      ${PRIVATE_HASH}`,
    ]);
    expect(formatContextGraphInfo(ROWS.find((row) => row.id === 'my-research')!))
      .toContain(`  Publish policy: curated (authority ${OWNER})`);
    const optedOut = formatContextGraphInfo({ ...chainRow('9', PUBLIC_HASH, { nameHash: null }) });
    expect(optedOut).toContain('  Name hash:      — (opted out)');
    expect(formatContextGraphInfo(ROWS.find((row) => row.id === 'draft-local')!)).toEqual([
      '  ID:             draft-local',
      '  Name:           Draft',
      '  Description:    —',
      '  Type:           user',
      '  Access:         —',
      '  Local:          subscribed',
      '  Creator:        —',
      '  Created:        —',
    ]);
  });
});

function commandProgram(): Command {
  const program = new Command().name('dkg');
  program.exitOverride();
  registerContextGraphCommand(program);
  return program;
}

describe('dkg context-graph list / info', () => {
  const logLines: string[] = [];
  const errorLines: string[] = [];

  beforeEach(() => {
    logLines.length = 0;
    errorLines.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errorLines.push(args.map(String).join(' '));
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({
      listContextGraphs: vi.fn().mockResolvedValue({ contextGraphs: ROWS }),
    } as unknown as ApiClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the readable table', async () => {
    await commandProgram().parseAsync(['node', 'dkg', 'context-graph', 'list']);
    expect(logLines).toEqual(formatContextGraphListTable(ROWS));
  });

  it('prints the raw rows with --json', async () => {
    await commandProgram().parseAsync(['node', 'dkg', 'context-graph', 'list', '--json']);
    expect(JSON.parse(logLines.join('\n'))).toEqual(ROWS);
  });

  it('finds a graph for info by its id or by its on-chain id', async () => {
    await commandProgram().parseAsync(['node', 'dkg', 'context-graph', 'info', '#31']);
    expect(logLines).toEqual(formatContextGraphInfo(ROWS.find((row) => row.id === PRIVATE_HASH)!));

    logLines.length = 0;
    await commandProgram().parseAsync(['node', 'dkg', 'context-graph', 'info', '32']);
    expect(logLines[0]).toBe('  ID:             my-research');

    logLines.length = 0;
    await commandProgram().parseAsync(['node', 'dkg', 'context-graph', 'info', 'draft-local']);
    expect(logLines[0]).toBe('  ID:             draft-local');
  });

  it('exits non-zero for an unknown graph', async () => {
    await expect(commandProgram().parseAsync(['node', 'dkg', 'context-graph', 'info', '#99']))
      .rejects.toThrow('process.exit(1)');
    expect(errorLines[0]).toBe('Context graph "#99" not found.');
    await expect(commandProgram().parseAsync(['node', 'dkg', 'context-graph', 'info', 'nope']))
      .rejects.toThrow('process.exit(1)');
  });

  it('reports a daemon failure', async () => {
    vi.spyOn(ApiClient, 'connect').mockRejectedValue(new Error('daemon not running'));
    await expect(commandProgram().parseAsync(['node', 'dkg', 'context-graph', 'list']))
      .rejects.toThrow('process.exit(1)');
    expect(errorLines).toEqual(['daemon not running']);
    await expect(commandProgram().parseAsync(['node', 'dkg', 'context-graph', 'info', '#31']))
      .rejects.toThrow('process.exit(1)');
  });
});
