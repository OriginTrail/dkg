import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { ApiClient } from '../src/api-client.js';
import { registerContextGraphCommand } from '../src/commands/context-graph.js';

function commandProgram(): Command {
  const program = new Command().name('dkg');
  program.exitOverride();
  registerContextGraphCommand(program);
  return program;
}

describe('context-graph join-policy CLI', () => {
  const logLines: string[] = [];
  const warningLines: string[] = [];
  const errorLines: string[] = [];

  beforeEach(() => {
    logLines.length = 0;
    warningLines.length = 0;
    errorLines.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warningLines.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errorLines.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows bounded open-enrollment status and its publishing-authority warning', async () => {
    const getContextGraphJoinPolicy = vi.fn().mockResolvedValue({
      contextGraphId: 'owner/private-cg',
      mode: 'open',
      memberCount: 7,
      maxMembers: 25,
      approvalsLastHour: 3,
      maxApprovalsPerHour: 10,
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ getContextGraphJoinPolicy } as unknown as ApiClient);

    await commandProgram().parseAsync([
      'node',
      'dkg',
      'context-graph',
      'join-policy',
      'status',
      'owner/private-cg',
    ]);

    expect(getContextGraphJoinPolicy).toHaveBeenCalledWith('owner/private-cg');
    expect(logLines.join('\n')).toContain('Mode:                    open');
    expect(logLines.join('\n')).toContain('Maximum members:         25');
    expect(logLines.join('\n')).toContain('Maximum approvals/hour:  10');
    expect(warningLines.join('\n')).toMatch(/anyone who knows this Context Graph ID/i);
    expect(warningLines.join('\n')).toMatch(/publishing authority/i);
  });

  it('refuses to enable open enrollment without --yes before connecting to the daemon', async () => {
    const connect = vi.spyOn(ApiClient, 'connect');
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);

    await expect(commandProgram().parseAsync([
      'node',
      'dkg',
      'context-graph',
      'join-policy',
      'open',
      'owner/private-cg',
      '--max-members',
      '25',
    ])).rejects.toThrow('process.exit:1');

    expect(connect).not.toHaveBeenCalled();
    expect(warningLines.join('\n')).toMatch(/request private access/i);
    expect(errorLines.join('\n')).toContain('Re-run with --yes');
  });

  it('enables open enrollment with exact caps, acknowledgement, and a default hourly cap', async () => {
    const setContextGraphJoinPolicy = vi.fn().mockResolvedValue({
      contextGraphId: 'owner/private-cg',
      mode: 'open',
      maxMembers: 25,
      maxApprovalsPerHour: 20,
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ setContextGraphJoinPolicy } as unknown as ApiClient);

    await commandProgram().parseAsync([
      'node',
      'dkg',
      'context-graph',
      'join-policy',
      'open',
      'owner/private-cg',
      '--max-members',
      '25',
      '--yes',
    ]);

    expect(setContextGraphJoinPolicy).toHaveBeenCalledWith('owner/private-cg', {
      mode: 'open',
      maxMembers: 25,
      maxApprovalsPerHour: 20,
      acknowledgeOpenEnrollment: true,
    });
    expect(logLines.join('\n')).toContain('Open enrollment enabled');
    expect(logLines.join('\n')).toContain('Maximum approvals/hour:  20');
    expect(warningLines.join('\n')).toMatch(/may gain publishing authority/i);
  });

  it('forwards an explicit hourly approval cap', async () => {
    const setContextGraphJoinPolicy = vi.fn().mockResolvedValue({
      contextGraphId: 'owner/private-cg',
      mode: 'open',
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ setContextGraphJoinPolicy } as unknown as ApiClient);

    await commandProgram().parseAsync([
      'node',
      'dkg',
      'context-graph',
      'join-policy',
      'open',
      'owner/private-cg',
      '--max-members',
      '25',
      '--max-approvals-per-hour',
      '4',
      '--yes',
    ]);

    expect(setContextGraphJoinPolicy).toHaveBeenCalledWith(
      'owner/private-cg',
      expect.objectContaining({ maxApprovalsPerHour: 4 }),
    );
  });

  it('switches to manual approval without implying that existing members are revoked', async () => {
    const setContextGraphJoinPolicy = vi.fn().mockResolvedValue({
      contextGraphId: 'owner/private-cg',
      mode: 'manual',
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ setContextGraphJoinPolicy } as unknown as ApiClient);

    await commandProgram().parseAsync([
      'node',
      'dkg',
      'context-graph',
      'join-policy',
      'manual',
      'owner/private-cg',
    ]);

    expect(setContextGraphJoinPolicy).toHaveBeenCalledWith('owner/private-cg', { mode: 'manual' });
    expect(logLines.join('\n')).toMatch(/disabling open enrollment does not revoke existing members/i);
  });

  it('reports an automatically approved join as complete', async () => {
    const signJoinRequest = vi.fn().mockResolvedValue({ delegation: { signature: '0xsigned' } });
    const requestJoin = vi.fn().mockResolvedValue({
      ok: true,
      status: 'approved',
      autoApproved: true,
      delivered: 1,
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({
      signJoinRequest,
      requestJoin,
    } as unknown as ApiClient);

    await commandProgram().parseAsync([
      'node',
      'dkg',
      'context-graph',
      'request-join',
      'owner/private-cg',
      '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6',
    ]);

    expect(logLines.join('\n')).toContain('Join approved for "owner/private-cg"');
    expect(logLines.join('\n')).not.toContain('Waiting for curator approval');
  });

  it('keeps the waiting message for a manual-policy join request', async () => {
    const signJoinRequest = vi.fn().mockResolvedValue({ delegation: { signature: '0xsigned' } });
    const requestJoin = vi.fn().mockResolvedValue({
      ok: true,
      status: 'pending',
      delivered: 1,
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({
      signJoinRequest,
      requestJoin,
    } as unknown as ApiClient);

    await commandProgram().parseAsync([
      'node',
      'dkg',
      'context-graph',
      'request-join',
      'owner/private-cg',
      '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6',
    ]);

    expect(logLines.join('\n')).toContain('Waiting for curator approval');
  });
});
