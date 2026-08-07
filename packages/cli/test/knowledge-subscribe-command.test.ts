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
    });
    expect(configMocks.saveConfig).not.toHaveBeenCalled();
    expect(logLines.join('\n')).toContain('Synchronization mode: always on');
    expect(logLines.join('\n')).not.toContain('Synchronization mode: on demand');
  });
});
