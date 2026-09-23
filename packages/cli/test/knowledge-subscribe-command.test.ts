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
