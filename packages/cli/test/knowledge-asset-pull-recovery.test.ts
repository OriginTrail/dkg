import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { ApiClient } from '../src/api-client.js';
import { registerKnowledgeAssetCommand } from '../src/commands/knowledge-asset.js';
import { handleKnowledgeAssetPullFrom } from '../src/daemon/routes/knowledge-asset-pull-from.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

const pin = {
  kaUal: 'did:dkg:base:84532/0x1111111111111111111111111111111111111111/1',
  assertionVersion: '1',
  merkleRoot: `0x${'ab'.repeat(32)}`,
};
const pinFlags = ['--recover-exact-ual', pin.kaUal, '--recover-exact-version', pin.assertionVersion,
  '--recover-exact-root', pin.merkleRoot];

function commandProgram(): Command {
  const program = new Command().name('dkg').exitOverride();
  registerKnowledgeAssetCommand(program);
  return program;
}

afterEach(() => vi.restoreAllMocks());

describe('pull-from CLI exact recovery contract', () => {
  it.each(['swm', 'vm'])('forwards the complete %s pin and sub-graph and prints returned evidence', async (layer) => {
    const evidence = { recovered: true, draftEvidence: { contextGraphId: 'research', name: 'paper', ...pin } };
    const pull = vi.fn().mockResolvedValue(evidence);
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ knowledgeAssetPullFrom: pull } as unknown as ApiClient);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    await commandProgram().parseAsync(['node', 'dkg', 'ka', 'pull-from', 'paper', '-c', 'research',
      '--layer', layer, '--sub-graph-name', 'papers', '--on-conflict', 'reject', ...pinFlags, '--json']);

    expect(pull).toHaveBeenCalledExactlyOnceWith('research', 'paper', layer,
      { recoverExact: pin, subGraphName: 'papers', onConflict: 'reject' });
    expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual(evidence);
  });

  it('keeps an ordinary pull free of recovery options', async () => {
    const pull = vi.fn().mockResolvedValue({ seededTripleCount: 2 });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ knowledgeAssetPullFrom: pull } as unknown as ApiClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await commandProgram().parseAsync(['node', 'dkg', 'ka', 'pull-from', 'paper', '-c', 'research', '--layer', 'swm']);
    expect(pull).toHaveBeenCalledExactlyOnceWith('research', 'paper', 'swm', {});
  });

  it.each([
    ['--recover-exact-version', '1'],
    ['--recover-exact-root', pin.merkleRoot],
    [...pinFlags, '--recover-exact-root', 'not-a-root'],
    [...pinFlags, '--recover-exact-version', '0'],
    [...pinFlags, '--on-conflict', 'replace'],
  ])('rejects incomplete, malformed or destructive recovery flags before connecting: %j', async (...flags) => {
    const connect = vi.spyOn(ApiClient, 'connect');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('CLI exited'); });

    await expect(commandProgram().parseAsync(['node', 'dkg', 'ka', 'pull-from', 'paper', '-c', 'research',
      '--layer', 'swm', ...flags])).rejects.toThrow('CLI exited');

    expect(connect).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Exact recovery requires'));
  });
});

function routeContext(pullFrom = vi.fn()) {
  const response = { status: 0, body: '' };
  const ctx = {
    agent: { assertion: { pullFrom } },
    res: {
      writeHead(status: number) { response.status = status; },
      end(body: string) { response.body = body; },
    },
  } as unknown as Pick<RequestContext, 'agent' | 'res'>;
  return { ctx, pullFrom, response };
}

describe('named pull-from HTTP validation and success response', () => {
  it.each(['swm', 'vm'])('retains %s recovery evidence and the authenticated actor lane', async (layer) => {
    const evidence = { recovered: true, seededTripleCount: 2, seededPrivateTripleCount: 1,
      draftEvidence: { ...pin, agentAddress: 'authenticated-actor', contextGraphId: 'research', subGraphName: 'papers' } };
    const { ctx, pullFrom, response } = routeContext(vi.fn().mockResolvedValue(evidence));

    await handleKnowledgeAssetPullFrom(ctx, { layer, recoverExact: pin }, 'research', 'paper', 'papers', 'authenticated-actor');

    expect(pullFrom).toHaveBeenCalledExactlyOnceWith('research', 'paper', layer,
      { recoverExact: pin, onConflict: 'reject', subGraphName: 'papers', agentAddress: 'authenticated-actor' });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ wmDraft: 'open', seededFrom: { layer }, ...evidence });
  });

  it('rejects a missing source layer before consulting the publisher', async () => {
    const { ctx, pullFrom, response } = routeContext();
    await handleKnowledgeAssetPullFrom(ctx, { recoverExact: pin }, 'research', 'paper', undefined, undefined);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toContain('layer');
    expect(pullFrom).not.toHaveBeenCalled();
  });

  it.each([null, {}, { ...pin, assertionVersion: 1 }, { ...pin, merkleRoot: '0x1234' }])(
    'refuses malformed recovery evidence with a stable 400 code: %j', async (recoverExact) => {
      const { ctx, pullFrom, response } = routeContext();
      await handleKnowledgeAssetPullFrom(ctx, { layer: 'swm', recoverExact }, 'research', 'paper', undefined, undefined);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body).code).toBe('INVALID_PULL_RECOVERY_OPTIONS');
      expect(pullFrom).not.toHaveBeenCalled();
    },
  );
});
