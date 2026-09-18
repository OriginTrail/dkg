import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { startLiveDaemon, stopLiveDaemon, postJson, getJson, type LiveDaemon } from './helpers/live-daemon.js';

const execFileAsync = promisify(execFile);
const CLI_ENTRY = resolve(import.meta.dirname, '../dist/cli.js');
const CG = 'jsonld-write-lifecycle';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
let daemon: LiveDaemon | undefined;

async function runCli(args: string[]) {
  if (!daemon) throw new Error('daemon is not ready');
  return execFileAsync(process.execPath, [CLI_ENTRY, ...args], {
    env: { ...process.env, DKG_HOME: daemon.home, DKG_API_PORT: String(daemon.apiPort), DKG_AUTH_TOKEN: daemon.token ?? '' },
    timeout: 120_000,
  });
}

beforeAll(async () => {
  daemon = await startLiveDaemon({ authEnabled: true });
  const created = await postJson(daemon, '/api/context-graph/create', { id: CG, name: CG, accessPolicy: 1 });
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
  const registered = await postJson(daemon, '/api/context-graph/register', { id: CG, accessPolicy: 1 });
  expect(registered.status, JSON.stringify(registered.body)).toBe(200);
}, 120_000);

afterAll(async () => { await stopLiveDaemon(daemon); });

type Quad = { subject: string; predicate: string; object: string; graph: string };
function assertLinks(quads: Quad[], kind: 'list' | 'nested') {
  const root = quads.find((q) => q.subject === `urn:${kind}` && q.predicate === `https://example.org/${kind === 'list' ? 'items' : 'child'}`);
  expect(root).toBeDefined();
  if (kind === 'nested') {
    expect(quads).toContainEqual(expect.objectContaining({ subject: root!.object, predicate: 'https://example.org/name', object: '"nested"' }));
  } else {
    const first = quads.find((q) => q.subject === root!.object && q.predicate === `${RDF}first`);
    const rest = quads.find((q) => q.subject === root!.object && q.predicate === `${RDF}rest`);
    expect(first?.object).toBe('urn:first');
    expect(rest).toBeDefined();
    expect(quads).toContainEqual(expect.objectContaining({ subject: rest!.object, predicate: `${RDF}first`, object: 'urn:second' }));
    expect(quads).toContainEqual(expect.objectContaining({ subject: rest!.object, predicate: `${RDF}rest`, object: `${RDF}nil` }));
  }
}

describe('JSON-LD CLI writes through the real daemon', () => {
  it.each(['list', 'nested'] as const)('writes and finalizes linked %s RDF without losing blank-node edges', async (kind) => {
    const document = kind === 'list'
      ? { '@id': 'urn:list', 'https://example.org/items': { '@list': [{ '@id': 'urn:first' }, { '@id': 'urn:second' }] } }
      : { '@id': 'urn:nested', 'https://example.org/child': { 'https://example.org/name': 'nested' } };
    const path = join(daemon!.home, `${kind}.jsonld`);
    await writeFile(path, JSON.stringify(document));
    await runCli(['ka', 'create', kind, '-c', CG, '--no-finalize']);
    await runCli(['ka', 'write', kind, '-c', CG, '-f', path]);
    const before = await getJson(daemon!, `/api/knowledge-assets/${kind}/wm/quads?contextGraphId=${CG}`);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    const beforeQuads = before.body.quads as Quad[];
    expect(beforeQuads.some((q) => q.object.startsWith('_:'))).toBe(true);
    assertLinks(beforeQuads, kind);
    await runCli(['ka', 'finalize', kind, '-c', CG]);
    const after = await getJson(daemon!, `/api/knowledge-assets/${kind}/wm/quads?contextGraphId=${CG}`);
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    const afterQuads = after.body.quads as Quad[];
    expect(afterQuads.some((q) => q.subject.startsWith('_:') || q.object.startsWith('_:'))).toBe(false);
    assertLinks(afterQuads, kind);
  });
});
