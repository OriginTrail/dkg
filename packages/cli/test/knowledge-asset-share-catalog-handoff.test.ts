/**
 * A synchronous share that committed to shared memory while its recovery job
 * still owes the catalog handoff is answered as shared with a pending
 * catalogHandoff. The share commands print the reason, the job and how to
 * follow it, and keep the publish guidance of a committed share.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { ApiClient } from '../src/api-client.js';
import { registerKnowledgeAssetCommand } from '../src/commands/knowledge-asset.js';

const HANDOFF = {
  state: 'pending' as const,
  reason: 'inactive-lane',
  recoveryJobId: 'share-job-7',
  recoveryStatusUrl: '/api/knowledge-assets/swm/share-jobs/share-job-7',
};
const HANDOFF_LINES = [
  '  Catalog:        handoff pending (inactive-lane)',
  '  Recovery job:   share-job-7',
  '  Follow:         dkg ka share-job share-job-7',
];
const TRIPLES = JSON.stringify([{ subject: 'urn:asset', predicate: 'http://schema.org/name', object: '"Asset"' }]);

function commandProgram(): Command {
  const program = new Command().name('dkg');
  program.exitOverride();
  registerKnowledgeAssetCommand(program);
  return program;
}

describe('knowledge-asset share commands with a pending catalog handoff', () => {
  const logLines: string[] = [];

  beforeEach(() => {
    logLines.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the recovery job and keeps the publish guidance after a synchronous share', async () => {
    const knowledgeAssetShare = vi.fn().mockResolvedValue({
      swmShared: true, promotedCount: 2, sealed: true, publishReady: true, shareOperationId: 'share-op-1', catalogHandoff: HANDOFF,
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ knowledgeAssetShare } as unknown as ApiClient);

    await commandProgram().parseAsync(['node', 'dkg', 'ka', 'share', 'paper', '-c', 'research']);

    expect(logLines).toEqual([
      'Knowledge asset shared to SWM:',
      '  Name:           paper',
      '  Context graph:  research',
      '  Triples:        2',
      '  Sealed:         true',
      '  Publish ready:  true',
      '  Share op:       share-op-1',
      ...HANDOFF_LINES,
      '  Next:           dkg ka publish-async paper --context-graph-id research',
    ]);
  });

  it('names the recovery job after a one-shot create and share', async () => {
    const createKnowledgeAsset = vi.fn().mockResolvedValue({
      name: 'paper', status: 'swm-shared', swmShared: true, promotedCount: 1, publishReady: true,
      shareOperationId: 'share-op-2', catalogHandoff: HANDOFF,
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ createKnowledgeAsset } as unknown as ApiClient);

    await commandProgram().parseAsync(['node', 'dkg', 'ka', 'create', 'paper', '-c', 'research', '--triples', TRIPLES, '--share']);

    expect(createKnowledgeAsset).toHaveBeenCalledWith('research', 'paper', expect.objectContaining({ alsoShareSwm: true }));
    expect(logLines).toEqual([
      'Knowledge asset create complete:',
      '  Name:           paper',
      '  Context graph:  research',
      '  Written:        1',
      '  Status:         swm-shared',
      '  Share op:       share-op-2',
      ...HANDOFF_LINES,
    ]);
  });

  it('prints no handoff lines for a share whose catalog handoff completed', async () => {
    const knowledgeAssetShare = vi.fn().mockResolvedValue({
      swmShared: true, promotedCount: 2, sealed: true, publishReady: true, shareOperationId: 'share-op-3',
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ knowledgeAssetShare } as unknown as ApiClient);

    await commandProgram().parseAsync(['node', 'dkg', 'ka', 'share', 'paper', '-c', 'research']);

    expect(logLines.join('\n')).not.toMatch(/Catalog:|Recovery job:|share-job/);
    expect(logLines).toContain('  Next:           dkg ka publish-async paper --context-graph-id research');
  });
});
