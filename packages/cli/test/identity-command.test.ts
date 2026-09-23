import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { ApiClient } from '../src/api-client.js';
import { registerIdentityCommand } from '../src/commands/identity.js';
import {
  formatProfileNodeIdStatus,
  type ProfileNodeIdStatusWire,
  type ProfileNodeIdSyncWire,
} from '../src/profile-node-id-wire.js';

const PEER_ID = '12D3KooWFWm8sg6dkitmdBd5Uxaqp3CDRL27mFcM7vEHK92Xapyy';
const OTHER_PEER_ID = '12D3KooWMasqzRrim48ZJM64UyTfHufDTmSG3n3jqwsS5phz8m91';
const EXPECTED = `0x${Buffer.from(PEER_ID, 'utf8').toString('hex')}`;
const LEGACY = '0x' + '7c'.repeat(32);
const PROFILE = '0x370943487c766633Da68DB4048E57674a7a6c076';

const LEGACY_STATUS: ProfileNodeIdStatusWire = {
  identityId: '63',
  peerId: PEER_ID,
  expectedNodeId: EXPECTED,
  onChainNodeId: LEGACY,
  onChainPeerId: null,
  state: 'legacy',
  expectedNodeIdTaken: false,
  expectedNodeIdHolder: null,
  profile: { address: PROFILE, version: '10.0.2', updateNodeIdSupported: false, requiredVersion: '10.1.0' },
};

describe('formatProfileNodeIdStatus', () => {
  it('renders a legacy nodeId on an older Profile', () => {
    expect(formatProfileNodeIdStatus(LEGACY_STATUS)).toEqual([
      '  Identity:          63',
      `  Peer id:           ${PEER_ID}`,
      `  Expected nodeId:   ${EXPECTED}`,
      `  On-chain nodeId:   ${LEGACY}`,
      '  State:             not a peer id (legacy random nodeId); run "dkg identity sync-node-id"',
      `  Profile contract:  v10.0.2 at ${PROFILE}, cannot update nodeIds (needs Profile >= 10.1.0)`,
    ]);
  });

  it('shows the on-chain peer id, a conflict, and a supporting Profile', () => {
    const lines = formatProfileNodeIdStatus({
      ...LEGACY_STATUS,
      onChainNodeId: `0x${Buffer.from(OTHER_PEER_ID, 'utf8').toString('hex')}`,
      onChainPeerId: OTHER_PEER_ID,
      state: 'other-peer',
      expectedNodeIdTaken: true,
      expectedNodeIdHolder: '61',
      profile: { ...LEGACY_STATUS.profile, version: '10.1.0', updateNodeIdSupported: true },
    });
    expect(lines).toContain(`  On-chain peer id:  ${OTHER_PEER_ID}`);
    expect(lines).toContain('  State:             names a different peer id; run "dkg identity sync-node-id" if this node replaced it');
    expect(lines).toContain("  Conflict:          this node's peer id is already the nodeId of identity 61");
    expect(lines.at(-1)).toBe(`  Profile contract:  v10.1.0 at ${PROFILE}, can update nodeIds`);
  });

  it('renders no profile, in sync, and an unknown holder or version', () => {
    expect(formatProfileNodeIdStatus({
      ...LEGACY_STATUS, identityId: '0', onChainNodeId: '0x', state: 'no-profile', expectedNodeIdTaken: null,
    }).slice(0, 4)).toContain('  On-chain nodeId:   —');
    expect(formatProfileNodeIdStatus({ ...LEGACY_STATUS, identityId: '0', state: 'no-profile' })[0])
      .toBe('  Identity:          — (no on-chain profile)');
    expect(formatProfileNodeIdStatus({ ...LEGACY_STATUS, onChainPeerId: PEER_ID, state: 'in-sync' }))
      .toContain("  State:             in sync: the on-chain nodeId is this node's peer id");
    const unknown = formatProfileNodeIdStatus({
      ...LEGACY_STATUS,
      expectedNodeIdTaken: true,
      profile: { ...LEGACY_STATUS.profile, version: null },
    });
    expect(unknown).toContain("  Conflict:          this node's peer id is already the nodeId of another identity");
    expect(unknown.at(-1)).toContain('unknown version at');
  });
});

function commandProgram(): Command {
  const program = new Command().name('dkg');
  program.exitOverride();
  registerIdentityCommand(program);
  return program;
}

describe('dkg identity node-id / sync-node-id', () => {
  const logLines: string[] = [];
  const errorLines: string[] = [];
  const syncResult = (overrides: Partial<ProfileNodeIdSyncWire> = {}): ProfileNodeIdSyncWire => ({
    outcome: 'updated',
    message: `Profile nodeId of identity 63 now names this node's peer id ${PEER_ID} (tx 0xabc)`,
    status: { ...LEGACY_STATUS, onChainNodeId: EXPECTED, onChainPeerId: PEER_ID, state: 'in-sync' },
    txHash: '0xabc',
    blockNumber: 12,
    signer: '0x' + '2'.repeat(40),
    ...overrides,
  });
  let client: { getProfileNodeIdStatus: ReturnType<typeof vi.fn>; syncProfileNodeId: ReturnType<typeof vi.fn> };

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
    client = {
      getProfileNodeIdStatus: vi.fn().mockResolvedValue(LEGACY_STATUS),
      syncProfileNodeId: vi.fn().mockResolvedValue(syncResult()),
    };
    vi.spyOn(ApiClient, 'connect').mockResolvedValue(client as unknown as ApiClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('node-id prints the status, or the raw JSON with --json', async () => {
    await commandProgram().parseAsync(['node', 'dkg', 'identity', 'node-id']);
    expect(logLines).toEqual(formatProfileNodeIdStatus(LEGACY_STATUS));

    logLines.length = 0;
    await commandProgram().parseAsync(['node', 'dkg', 'identity', 'node-id', '--json']);
    expect(JSON.parse(logLines.join('\n'))).toEqual(LEGACY_STATUS);
  });

  it('sync-node-id prints the outcome and the transaction', async () => {
    await commandProgram().parseAsync(['node', 'dkg', 'identity', 'sync-node-id']);
    expect(client.syncProfileNodeId).toHaveBeenCalledTimes(1);
    expect(logLines).toEqual([
      `Profile nodeId of identity 63 now names this node's peer id ${PEER_ID} (tx 0xabc)`,
      `  tx: 0xabc (signed by 0x${'2'.repeat(40)})`,
    ]);
  });

  it('sync-node-id succeeds quietly when already in sync, and prints raw JSON with --json', async () => {
    client.syncProfileNodeId.mockResolvedValue(syncResult({ outcome: 'in-sync', message: 'already', txHash: null, signer: null }));
    await commandProgram().parseAsync(['node', 'dkg', 'identity', 'sync-node-id']);
    expect(logLines).toEqual(['already']);

    logLines.length = 0;
    await commandProgram().parseAsync(['node', 'dkg', 'identity', 'sync-node-id', '--json']);
    expect(JSON.parse(logLines.join('\n'))).toMatchObject({ outcome: 'in-sync' });
  });

  it('sync-node-id exits 1 when the nodeId could not be synced', async () => {
    client.syncProfileNodeId.mockResolvedValue(syncResult({
      outcome: 'unsupported',
      message: 'The deployed Profile contract (v10.0.2 at 0x…) cannot update nodeIds; it needs Profile >= 10.1.0',
      txHash: null,
      signer: null,
    }));
    await expect(commandProgram().parseAsync(['node', 'dkg', 'identity', 'sync-node-id']))
      .rejects.toThrow('process.exit(1)');
    expect(logLines).toEqual(['The deployed Profile contract (v10.0.2 at 0x…) cannot update nodeIds; it needs Profile >= 10.1.0']);
  });

  it('reports a daemon failure for both subcommands', async () => {
    vi.spyOn(ApiClient, 'connect').mockRejectedValue(new Error('daemon not running'));
    await expect(commandProgram().parseAsync(['node', 'dkg', 'identity', 'node-id'])).rejects.toThrow('process.exit(1)');
    await expect(commandProgram().parseAsync(['node', 'dkg', 'identity', 'sync-node-id'])).rejects.toThrow('process.exit(1)');
    expect(errorLines).toEqual(['daemon not running', 'daemon not running']);
  });
});
