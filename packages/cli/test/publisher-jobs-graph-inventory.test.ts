// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { createMixedPublisherInventory } from '../../publisher/test/_helpers/publisher-inventory.js';
import * as configModule from '../src/config.js';
import { ApiClient } from '../src/api-client.js';
import { registerPublisherCommand } from '../src/commands/publisher.js';
import { handlePublisherRoutes } from '../src/daemon/routes/publisher.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const CG = 'private-target';
const CALLER = '0x2222222222222222222222222222222222222222';
const SCOPED = ['own-a', 'own-z'];
const UNSCOPED = ['legacy', 'other', 'own-a', 'own-z'];

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.doUnmock('../src/publisher-runner.js'); });

async function inventoryRoute(operator: boolean) {
  const inventory = await createMixedPublisherInventory(CG);
  const list = vi.spyOn(inventory.publisher, 'list');
  const authority = vi.fn<DKGAgent['resolveContextGraphReadAuthority']>(async () => ({
    outcome: 'allowed', grantScope: 'caller', source: 'registered-chain',
    reason: 'chain-participant', metadataBootstrap: 'eligible',
  }));
  const req = Object.assign(new EventEmitter(), { method: 'GET', headers: {}, aborted: false });
  const res = Object.assign(new EventEmitter(), { statusCode: 0, body: '', destroyed: false, writableEnded: false,
    writeHead(status: number) { this.statusCode = status; }, setHeader() {},
    end(body = '') { this.body = body; this.writableEnded = true; },
  });
  const url = new URL('http://localhost/api/publisher/jobs');
  const ctx = { req, res, url, path: url.pathname, publisherControl: inventory.publisher,
    agent: { resolveContextGraphReadAuthority: authority }, requestAgentAddress: CALLER,
    authentication: requestAuthentication(operator ? { kind: 'nodeOperator' } : { kind: 'agent', agentAddress: CALLER }),
  } as unknown as RequestContext;
  return { ...inventory, list, authority, ctx, res };
}

describe('native publisher inventory through HTTP and stopped-daemon adapters', () => {
  it.each([false, true])('uses the canonical list through command, client and HTTP (operator=%s)', async operator => {
    const h = await inventoryRoute(operator);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      Object.assign(h.ctx, { url, path: url.pathname });
      await handlePublisherRoutes(h.ctx);
      return new Response(h.res.body, { status: h.res.statusCode });
    }));
    vi.spyOn(ApiClient, 'connect').mockResolvedValue(new ApiClient(8899, 'bearer-token'));
    const program = new Command().exitOverride();
    registerPublisherCommand(program);
    try {
      await program.parseAsync(['publisher', 'jobs', '--status', 'accepted',
        ...(operator ? [] : ['--context-graph', `did:dkg:context-graph:${CG}`])], { from: 'user' });
      expect(h.res.statusCode).toBe(200);
      expect(h.list).toHaveBeenCalledExactlyOnceWith(operator
        ? { status: 'accepted' } : { status: 'accepted', contextGraphId: CG });
      expect(JSON.parse(String(output.mock.calls[0][0])).map((job: { jobId: string }) => job.jobId))
        .toEqual(operator ? UNSCOPED : SCOPED);
      if (operator) expect(h.authority).not.toHaveBeenCalled();
      else expect(h.authority).toHaveBeenCalledExactlyOnceWith(CG,
        expect.objectContaining({ callerAgentAddress: CALLER }));
    } finally { await h.store.close(); }
  });

  it('normalizes an explicit operator graph through HTTP without widening the inventory', async () => {
    const h = await inventoryRoute(true);
    const url = new URL(`http://localhost/api/publisher/jobs?status=accepted&contextGraphId=did:dkg:context-graph:${CG}`);
    Object.assign(h.ctx, { url, path: url.pathname });
    try {
      await handlePublisherRoutes(h.ctx);
      expect(h.res.statusCode).toBe(200);
      expect(h.list).toHaveBeenCalledExactlyOnceWith({ status: 'accepted', contextGraphId: CG });
      expect(JSON.parse(h.res.body).jobs.map((job: { jobId: string }) => job.jobId)).toEqual(SCOPED);
      expect(h.authority).not.toHaveBeenCalled();
    } finally { await h.store.close(); }
  });

  it.each([false, true])('passes the optional graph to the same native stopped-daemon publisher (scoped=%s)', async scoped => {
    const { store, publisher } = await createMixedPublisherInventory(CG);
    const list = vi.spyOn(publisher, 'list');
    const stop = vi.fn(() => store.close());
    vi.spyOn(ApiClient, 'connect').mockRejectedValue(new Error('Daemon is not running'));
    vi.spyOn(configModule, 'loadConfig').mockResolvedValue({} as never);
    vi.doMock('../src/publisher-runner.js', () => ({ createPublisherInspector: async () => ({ publisher, stop }) }));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command().exitOverride();
    registerPublisherCommand(program);
    try {
      await program.parseAsync(['publisher', 'jobs', '--status', 'accepted',
        ...(scoped ? ['--context-graph', `did:dkg:context-graph:${CG}`] : [])], { from: 'user' });
      expect(list).toHaveBeenCalledExactlyOnceWith(scoped
        ? { status: 'accepted', contextGraphId: CG } : { status: 'accepted' });
      expect(JSON.parse(String(output.mock.calls[0][0])).map((job: { jobId: string }) => job.jobId))
        .toEqual(scoped ? SCOPED : UNSCOPED);
      expect(stop).toHaveBeenCalledOnce();
    } finally { await store.close(); }
  });
});
