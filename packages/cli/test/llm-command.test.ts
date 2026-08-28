import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import {
  handleLlmInteractiveCommand,
  registerLlmCommand,
  resolveLlmCommandOptions,
} from '../src/commands/llm.js';

describe('dkg llm options', () => {
  it('resolves a one-shot prompt, endpoint, model, project, and bounded defaults', () => {
    const options = resolveLlmCommandOptions(
      ['Which', 'queries', 'are', 'saved?'],
      { llamaUrl: 'http://127.0.0.1:9090/v1/chat/completions', model: 'qwen', project: 'testing' },
      { DKG_HOME: '/tmp/dkg-llm-test' },
    );
    expect(options.prompt).toBe('Which queries are saved?');
    expect(options.interactive).toBe(false);
    expect(options.llamaUrl).toContain(':9090/');
    expect(options.model).toBe('qwen');
    expect(options.projectId).toBe('testing');
    expect(options.profile).toBe('auto');
    expect(options.allowWrite).toBe(false);
    expect(options.maxToolsPerTurn).toBe(8);
    expect(options.maxToolJsonBytes).toBe(18_000);
    expect(options.dkgHome).toBe('/tmp/dkg-llm-test');
    expect(options.logDir).toBe('/tmp/dkg-llm-test/logs/local-llm');
  });

  it('starts interactive chat by default when the prompt is omitted', () => {
    const options = resolveLlmCommandOptions([], {}, { DKG_HOME: '/tmp/dkg-llm-test' });
    expect(options.prompt).toBeUndefined();
    expect(options.interactive).toBe(true);
  });

  it('requires explicit write opt-in and validates numeric/profile options', () => {
    const write = resolveLlmCommandOptions([], {
      profile: 'write',
      allowWrite: true,
      maxTools: '4',
      maxToolJsonBytes: '9000',
    }, { DKG_HOME: '/tmp/dkg-llm-test' });
    expect(write.profile).toBe('write');
    expect(write.allowWrite).toBe(true);
    expect(write.maxToolsPerTurn).toBe(4);
    expect(write.maxToolJsonBytes).toBe(9_000);
    expect(() => resolveLlmCommandOptions([], { profile: 'anything' }, { DKG_HOME: '/tmp/x' }))
      .toThrow('--profile');
    expect(() => resolveLlmCommandOptions([], { maxToolCalls: '0' }, { DKG_HOME: '/tmp/x' }))
      .toThrow('positive integer');
  });

  it('accepts adapters from DKG_ADAPTERS and explicit extra tool names', () => {
    const options = resolveLlmCommandOptions([], {
      tool: ['partner_lookup', 'partner_lookup'],
      domainProfile: './profiles/partner.json',
    }, {
      DKG_HOME: '/tmp/dkg-llm-test',
      DKG_ADAPTERS: '/tmp/one.js, /tmp/two.js',
    });
    expect(options.adapterPaths).toEqual(['/tmp/one.js', '/tmp/two.js']);
    expect(options.additionalToolNames).toEqual(['partner_lookup']);
    expect(options.domainProfileFile).toMatch(/profiles\/partner\.json$/);
  });

  it('registers the command and its read/write controls in help', () => {
    const program = new Command();
    program.exitOverride();
    registerLlmCommand(program);
    const help = program.commands.find((command) => command.name() === 'llm')!.helpInformation();
    expect(help).toContain('--allow-write');
    expect(help).toContain('--profile');
    expect(help).toContain('--system-context-file');
    expect(help).toContain('--domain-profile');
    expect(help).toContain('--max-tool-json-bytes');
  });
});

describe('dkg llm interactive commands', () => {
  it('handles history, tools, log, clear, and exit without an LLM call', async () => {
    const clearSession = vi.fn(async () => undefined);
    const runtime = {
      clearSession,
      getAvailableToolNames: () => ['dkg_query_catalog_list'],
      getSessionHistory: () => [{
        turn: 1,
        user: 'Which queries exist?',
        assistant: 'One query exists.',
        evidence: [{ name: 'dkg_query_catalog_list', arguments: {}, result: 'one row' }],
      }],
      getSessionInfo: () => ({ turns: 1, maxTurns: 6, maxChars: 8_000 }),
    };
    expect((await handleLlmInteractiveCommand('/history', runtime)).output).toContain('One query exists.');
    expect((await handleLlmInteractiveCommand('/tools', runtime)).output).toContain('dkg_query_catalog_list');
    expect((await handleLlmInteractiveCommand('/log', runtime, '/tmp/trace.log')).output).toContain('/tmp/trace.log');
    expect(await handleLlmInteractiveCommand('/exit', runtime)).toEqual({ handled: true, exit: true });
    expect(await handleLlmInteractiveCommand('normal question', runtime)).toEqual({ handled: false });
    await handleLlmInteractiveCommand('/clear', runtime);
    expect(clearSession).toHaveBeenCalledOnce();
  });
});
