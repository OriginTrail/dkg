import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(async () => ({ contextGraphs: [] as string[] })),
  saveConfig: vi.fn(async () => undefined),
  resolveContextGraphs: vi.fn((config: { contextGraphs?: string[] }) => config.contextGraphs ?? []),
}));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/config.js')>(),
  loadConfig: configMocks.loadConfig,
  saveConfig: configMocks.saveConfig,
  resolveContextGraphs: configMocks.resolveContextGraphs,
}));

import { ApiClient } from '../src/api-client.js';
import { registerKnowledgeCommands } from '../src/commands/knowledge.js';

function commandProgram(): Command {
  const program = new Command().name('dkg');
  program.exitOverride();
  registerKnowledgeCommands(program);
  return program;
}

describe('knowledge subscribe CLI sync lifetime', () => {
  const logLines: string[] = [];

  beforeEach(() => {
    logLines.length = 0;
    configMocks.loadConfig.mockClear();
    configMocks.saveConfig.mockClear();
    configMocks.resolveContextGraphs.mockClear();
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests process-local on-demand synchronization by default', async () => {
    const subscribeToContextGraph = vi.fn().mockResolvedValue({
      subscribed: 'selected-cg',
      syncMode: 'on-demand',
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ subscribeToContextGraph } as unknown as ApiClient);

    await commandProgram().parseAsync(['node', 'dkg', 'subscribe', 'selected-cg']);

    expect(subscribeToContextGraph).toHaveBeenCalledWith('selected-cg', {
      syncMode: 'on-demand',
      forceCatchup: false,
    });
    expect(configMocks.saveConfig).not.toHaveBeenCalled();
    expect(logLines.join('\n')).toContain('Synchronization mode: on demand');
  });

  it('requests restart-durable synchronization with --save', async () => {
    const subscribeToContextGraph = vi.fn().mockResolvedValue({
      subscribed: 'selected-cg',
      syncMode: 'always-on',
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ subscribeToContextGraph } as unknown as ApiClient);

    await commandProgram().parseAsync(['node', 'dkg', 'subscribe', 'selected-cg', '--save']);

    expect(subscribeToContextGraph).toHaveBeenCalledWith('selected-cg', {
      syncMode: 'always-on',
      forceCatchup: false,
    });
    expect(configMocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphs: ['selected-cg'],
    }));
    expect(logLines.join('\n')).toContain('Synchronization mode: always on');
  });

  it('reports the server-normalized mode when an on-demand request stays always-on', async () => {
    const subscribeToContextGraph = vi.fn().mockResolvedValue({
      subscribed: 'selected-cg',
      syncMode: 'always-on',
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ subscribeToContextGraph } as unknown as ApiClient);

    await commandProgram().parseAsync(['node', 'dkg', 'subscribe', 'selected-cg']);

    expect(subscribeToContextGraph).toHaveBeenCalledWith('selected-cg', {
      syncMode: 'on-demand',
      forceCatchup: false,
    });
    expect(configMocks.saveConfig).not.toHaveBeenCalled();
    expect(logLines.join('\n')).toContain('Synchronization mode: always on');
    expect(logLines.join('\n')).not.toContain('Synchronization mode: on demand');
  });

  it('forces catch-up when --repair is requested', async () => {
    const subscribeToContextGraph = vi.fn().mockResolvedValue({
      subscribed: 'selected-cg',
      syncMode: 'on-demand',
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ subscribeToContextGraph } as unknown as ApiClient);

    await commandProgram().parseAsync(['node', 'dkg', 'subscribe', 'selected-cg', '--repair']);

    expect(subscribeToContextGraph).toHaveBeenCalledWith('selected-cg', {
      syncMode: 'on-demand',
      forceCatchup: true,
    });
  });

  // Base-mainnet Context Graph #33 (2026-09-23): subscribing by the on-chain
  // name hash used to print a success line and then sync nothing, silently.
  const nameHash = '0x69a1d4a3500548577083af0be5c4376dcf171907ab7da012d25dc778ced894e3';

  it('says plainly when the graph is known only by its name hash', async () => {
    const message = 'Context Graph 0x69a1d4a3…94e3 is known only by its on-chain name hash; '
      + 'waiting for a peer to reveal the cleartext id, or subscribe with the cleartext id.';
    const subscribeToContextGraph = vi.fn().mockResolvedValue({
      subscribed: nameHash,
      syncMode: 'always-on',
      catchup: { status: 'queued', includeWorkspace: true, jobId: 'job-1' },
      identity: { state: 'name-hash-only', nameHash, onChainId: '33', message },
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ subscribeToContextGraph } as unknown as ApiClient);

    await commandProgram().parseAsync(['node', 'dkg', 'subscribe', nameHash, '--save']);

    const output = logLines.join('\n');
    expect(output).toContain(`Subscribed to context graph: ${nameHash}`);
    expect(output).toContain(`Note: ${message}`);
    expect(configMocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ contextGraphs: [nameHash] }));
  });

  // Gnosis-mainnet Context Graph #32 (2026-09-23): `dkg subscribe 32 --save`
  // printed "Subscribed to context graph: 32" and saved the number.
  const gnosisHash = '0xf6b06a3e98104aa0d565134e073c157ebc23fa39aad068c62f73d72551fed956';

  it('saves the graph an on-chain id resolved to, never the number, replacing only the spelling typed', async () => {
    configMocks.loadConfig.mockResolvedValueOnce({ contextGraphs: ['32', '#32', 'other-cg'] });
    const onChainMessage = 'On-chain Context Graph #32 is Context Graph 0xf6b06a3e…d956 (its on-chain name hash).';
    const identityMessage = 'Context Graph 0xf6b06a3e…d956 is known only by its on-chain name hash; '
      + 'waiting for a peer to reveal the cleartext id, or subscribe with the cleartext id.';
    const subscribeToContextGraph = vi.fn().mockResolvedValue({
      subscribed: gnosisHash,
      syncMode: 'always-on',
      catchup: { status: 'queued', includeWorkspace: true, jobId: 'job-3' },
      identity: { state: 'name-hash-only', nameHash: gnosisHash, onChainId: '32', message: identityMessage },
      onChainReference: { onChainId: '32', message: onChainMessage },
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ subscribeToContextGraph } as unknown as ApiClient);

    await commandProgram().parseAsync(['node', 'dkg', 'subscribe', '#32', '--save']);

    expect(subscribeToContextGraph).toHaveBeenCalledWith('#32', { syncMode: 'always-on', forceCatchup: false });
    const output = logLines.join('\n');
    expect(output).toContain(`Subscribed to context graph: ${gnosisHash}`);
    expect(output).toContain(`Note: ${onChainMessage}`);
    expect(output).toContain(`Note: ${identityMessage}`);
    expect(output).toContain(`Replaced "#32" in config.contextGraphs with ${gnosisHash}.`);
    // A bare "32" may name a different graph: it stays, with a hint.
    expect(output).toContain(
      'Note: config.contextGraphs also lists "32"; if it was saved for on-chain Context Graph #32, you can remove it.',
    );
    expect(output).toContain(`Saved ${gnosisHash} to config`);
    expect(configMocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphs: ['32', 'other-cg', gnosisHash],
    }));
  });

  it('replaces a saved number typed the same way, and leaves unrelated entries without a note', async () => {
    configMocks.loadConfig.mockResolvedValueOnce({ contextGraphs: ['32', 'other-cg'] });
    const subscribeToContextGraph = vi.fn().mockResolvedValue({
      subscribed: gnosisHash,
      syncMode: 'always-on',
      onChainReference: { onChainId: '32', message: 'On-chain Context Graph #32 is Context Graph 0xf6b06a3e…d956.' },
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ subscribeToContextGraph } as unknown as ApiClient);

    await commandProgram().parseAsync(['node', 'dkg', 'subscribe', '32', '--save']);

    const output = logLines.join('\n');
    expect(output).toContain(`Replaced "32" in config.contextGraphs with ${gnosisHash}.`);
    expect(output).not.toContain('also lists');
    expect(configMocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphs: ['other-cg', gnosisHash],
    }));
  });

  it('saves the verified cleartext id when the node already knew the graph an on-chain id names', async () => {
    const subscribeToContextGraph = vi.fn().mockResolvedValue({
      subscribed: 'gnosis-fun-facts',
      syncMode: 'always-on',
      onChainReference: {
        onChainId: '32',
        message: 'On-chain Context Graph #32 is "gnosis-fun-facts" (verified against its on-chain name hash).',
      },
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ subscribeToContextGraph } as unknown as ApiClient);

    await commandProgram().parseAsync(['node', 'dkg', 'subscribe', '32', '--save']);

    expect(logLines.join('\n')).toContain('Subscribed to context graph: gnosis-fun-facts');
    expect(configMocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphs: ['gnosis-fun-facts'],
    }));
  });

  it('subscribes and saves the verified cleartext id when the daemon resolved the hash', async () => {
    const subscribeToContextGraph = vi.fn().mockResolvedValue({
      subscribed: 'acme-fun-facts',
      syncMode: 'always-on',
      catchup: { status: 'queued', includeWorkspace: true, jobId: 'job-2' },
      identity: {
        state: 'resolved',
        nameHash,
        onChainId: '33',
        contextGraphId: 'acme-fun-facts',
        message: 'Context Graph 0x69a1d4a3…94e3 resolves to "acme-fun-facts" (verified against the on-chain name hash); it syncs under that id.',
      },
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ subscribeToContextGraph } as unknown as ApiClient);

    await commandProgram().parseAsync(['node', 'dkg', 'subscribe', nameHash, '--save']);

    const output = logLines.join('\n');
    expect(output).toContain('Subscribed to context graph: acme-fun-facts');
    expect(output).toContain('resolves to "acme-fun-facts"');
    expect(configMocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphs: ['acme-fun-facts'],
    }));
  });
});
