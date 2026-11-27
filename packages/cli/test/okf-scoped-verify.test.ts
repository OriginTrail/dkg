import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { rm } from 'node:fs/promises';
import { registerOkfCommand } from '../src/commands/okf.js';
import { makeBundle, makeOkfCliHome, startStub } from './okf-test-helpers.js';

afterEach(() => vi.restoreAllMocks());

describe('registered OKF verify HTTP contract', () => {
  it.each([undefined, 'science'])('scopes every count and concept lookup consistently: %s', async (subGraphName) => {
    const stub = await startStub();
    const home = await makeOkfCliHome(stub.port);
    const bundle = await makeBundle();
    const previousHome = process.env.DKG_HOME;
    const previousPort = process.env.DKG_API_PORT;
    process.env.DKG_HOME = home;
    process.env.DKG_API_PORT = String(stub.port);
    stub.setHandler((_req, body) => ({ status: 200, body: { result: {
      type: 'bindings', bindings: JSON.parse(body).sparql.includes('COUNT(*)')
        ? [{ c: '1000' }] : [{ s: 'urn:okf:a' }, { s: 'urn:okf:b' }],
    } } }));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const program = new Command();
      registerOkfCommand(program);
      await program.parseAsync(['okf', 'verify', bundle, '--context-graph-id', 'cg', '--list-missing', '20',
        ...(subGraphName ? ['--sub-graph-name', subGraphName] : [])], { from: 'user' });
      const report = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
      expect(report).toMatchObject({ complete: true, missingConcepts: [] });
      expect(stub.calls.filter((call) => JSON.parse(call.body).sparql.includes('COUNT(*)')).length).toBeGreaterThan(1);
      expect(stub.calls.some((call) => JSON.parse(call.body).sparql.includes('SELECT DISTINCT ?s'))).toBe(true);
      for (const call of stub.calls) {
        const body = JSON.parse(call.body);
        expect(body.contextGraphId).toBe('cg');
        if (subGraphName) {
          expect(body).toMatchObject({ subGraphName, view: 'shared-working-memory' });
          expect(body.includeSharedMemory).toBeUndefined();
        } else {
          expect(body.includeSharedMemory).toBe(true);
          expect(body.view).toBeUndefined();
          expect(body.subGraphName).toBeUndefined();
        }
      }
    } finally {
      if (previousHome === undefined) delete process.env.DKG_HOME; else process.env.DKG_HOME = previousHome;
      if (previousPort === undefined) delete process.env.DKG_API_PORT; else process.env.DKG_API_PORT = previousPort;
      await stub.close();
      await Promise.all([home, bundle].map((dir) => rm(dir, { recursive: true, force: true })));
    }
  });
});
