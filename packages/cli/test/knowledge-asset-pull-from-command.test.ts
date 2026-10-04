import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { ApiClient } from '../src/api-client.js';
import { registerKnowledgeAssetCommand } from '../src/commands/knowledge-asset.js';

async function pullFrom(layer: string): Promise<void> {
  const program = new Command().exitOverride();
  registerKnowledgeAssetCommand(program);
  await program.parseAsync(['ka', 'pull-from', 'paper', '-c', 'research',
    '--layer', layer, '--sub-graph-name', 'notes', '--on-conflict', 'replace', '--json'], { from: 'user' });
}

describe('KA pull-from source layer command', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['wm', 'swm', 'vm'])('forwards the %s source and draft conflict options', async layer => {
    const request = vi.fn().mockResolvedValue({ wmDraft: 'open', seededFrom: { layer } });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ knowledgeAssetPullFrom: request } as unknown as ApiClient);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    await pullFrom(layer);

    expect(request).toHaveBeenCalledExactlyOnceWith('research', 'paper', layer,
      { subGraphName: 'notes', onConflict: 'replace' });
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({ wmDraft: 'open', seededFrom: { layer } });
  });

  it('rejects an invalid source before connecting to the daemon', async () => {
    const connect = vi.spyOn(ApiClient, 'connect');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('CLI exit'); });

    await expect(pullFrom('archive')).rejects.toThrow('CLI exit');

    expect(error).toHaveBeenCalledExactlyOnceWith('--layer must be wm, swm or vm');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(connect).not.toHaveBeenCalled();
  });
});
