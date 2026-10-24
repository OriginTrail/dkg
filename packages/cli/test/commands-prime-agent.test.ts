import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerPrimeAgentCommand } from '../src/commands/prime-agent.js';

describe('dkg prime-agent command registration', () => {
  it('exposes the setup and recovery lifecycle verbs', () => {
    const program = new Command();
    program.exitOverride();
    registerPrimeAgentCommand(program);

    const primeAgent = program.commands.find((command) => command.name() === 'prime-agent');
    expect(primeAgent).toBeDefined();
    expect(primeAgent!.commands.map((command) => command.name())).toEqual([
      'setup',
      'status',
      'verify',
      'doctor',
      'disconnect',
      'reconnect',
      'uninstall',
    ]);
  });
});
