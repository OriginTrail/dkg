import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

// `file` stands in for the on-disk config that each patch is applied to.
const configMocks = vi.hoisted(() => ({
  file: {} as Record<string, unknown>,
  updateConfigFile: vi.fn(),
}));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/config.js')>(),
  updateConfigFile: configMocks.updateConfigFile,
}));

import { ApiClient } from '../src/api-client.js';
import { registerContextGraphCommand } from '../src/commands/context-graph.js';

const ID = '0x64529c023d853371228923b4fda5fb22f929bf51/research';

function commandProgram(): Command {
  const program = new Command().name('dkg');
  program.exitOverride();
  registerContextGraphCommand(program);
  return program;
}

describe('dkg context-graph create --save', () => {
  beforeEach(() => {
    configMocks.file = { name: 'node', contextGraphs: ['existing'] };
    configMocks.updateConfigFile.mockReset();
    configMocks.updateConfigFile.mockImplementation(async (patch: (config: Record<string, unknown>) => void) => {
      patch(configMocks.file);
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({
      createContextGraph: vi.fn().mockResolvedValue({ created: ID, uri: `did:dkg:context-graph:${ID}` }),
    } as unknown as ApiClient);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds the graph to the config file once and keeps the rest of the file', async () => {
    await commandProgram().parseAsync(['node', 'dkg', 'context-graph', 'create', ID, '--save']);
    await commandProgram().parseAsync(['node', 'dkg', 'context-graph', 'create', ID, '--save']);

    expect(configMocks.updateConfigFile).toHaveBeenCalledTimes(2);
    expect(configMocks.file).toEqual({ name: 'node', contextGraphs: ['existing', ID] });
  });

  it('leaves the config file alone without --save', async () => {
    await commandProgram().parseAsync(['node', 'dkg', 'context-graph', 'create', ID]);

    expect(configMocks.updateConfigFile).not.toHaveBeenCalled();
  });
});
