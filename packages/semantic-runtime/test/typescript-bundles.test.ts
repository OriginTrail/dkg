import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeTypeScriptProgramBundle } from '@origintrail-official/dkg-core/typescript-program-bundle';
import { TypeScriptProgramHost } from '../src/typescript-programs.js';

const hosts: TypeScriptProgramHost[] = [], servers: Server[] = [];
const host = (options = {}) => { const value = new TypeScriptProgramHost(options); hosts.push(value); return value; };
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(value => value.stop()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
  })));
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const bundle = (main: string, files: Record<string, string> = {}, imports: Record<string, string> = {}) =>
  encodeTypeScriptProgramBundle({ entry: 'main.ts', files: { 'main.ts': main, ...files }, imports }, hash);
const grant = { children: [], maxCalls: 4, maxConcurrency: 2, timeoutMs: 5000 };
const api = '@origintrail-official/dkg-graph-computer/program';

describe('bundled dependency sandbox', () => {
  it('runs bare, relative, transitive and JSON imports and commits changes in compile identity', async () => {
    const runtime = host();
    const main = 'import {compute} from "math"; export async function run(n) { const {double} = await import("./double.js"); return compute(n) + double(0); }';
    const files = { 'lib/math.ts': 'import data from "./data.json"; import {double} from "../double.js"; export const compute = (n: number) => double(n) + data.offset;',
      'lib/data.json': '{"offset":3}', 'double.js': 'export const double = n => n * 2;' };
    const source = bundle(main, files, { math: 'lib/math.ts' });
    const artifact = await runtime.compile(source);
    expect(JSON.parse(artifact.manifest).sourceHash).toBe(hash(source));
    expect(await runtime.execute(artifact, '[4]', grant, async () => { throw new Error('Unexpected effect'); })).toBe('11');
    const changed = await runtime.compile(bundle(main, { ...files, 'double.js': 'export const double = n => n * 3;' }, { math: 'lib/math.ts' }));
    expect(changed.hash).not.toBe(artifact.hash);
    expect(await runtime.execute(changed, '[4]', grant, async () => null)).toBe('15');
  }, 60000);

  it('blocks transitive host modules, URLs, missing dependencies and access to runtime internals', async () => {
    const runtime = host();
    for (const name of ['node:fs', 'node:net', 'node:process', 'https://example.test/x.js', 'missing-package', 'guest', 'entry', 'pipeline', '../../compiler.mjs']) {
      await expect(runtime.compile(bundle('import {value} from "./lib.js"; export function run() { return value; }',
        { 'lib.js': `import value from ${JSON.stringify(name)}; export {value};` }))).rejects.toThrow('Unsupported Program import');
    }
    const bad = JSON.parse(bundle('export function run() { return 1; }', { 'unused.js': 'export const value = 1;' }));
    bad.files['unused.js'].source += ' ';
    await expect(runtime.compile(JSON.stringify(bad))).rejects.toThrow('checksum');
    await expect(runtime.compile(bundle(`import {takeEffects} from '${api}'; export function run() { return takeEffects(); }`)))
      .rejects.toThrow('No matching export');
    await expect(runtime.compile(bundle('export async function run() { return import("node:fs"); }')))
      .rejects.toThrow('Unsupported Program import');
  }, 60000);

  it('provides no direct network, environment or process capability at initialization or invocation', async () => {
    let requests = 0;
    const server = createServer((_request, response) => { requests++; response.end('unexpected'); }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/blocked`;
    const runtime = host();
    const source = bundle('import {probe} from "./lib.js"; export function run() { return probe(); }', { 'lib.js': `
      export function probe() { return {process: typeof globalThis.process, require: typeof globalThis.require}; }` });
    const artifact = await runtime.compile(source);
    expect(JSON.parse(await runtime.execute(artifact, '[]', grant, async () => null))).toEqual({ process: 'undefined', require: 'undefined' });
    const network = await runtime.compile(bundle('import {probe} from "./lib.js"; export async function run() { return probe(); }',
      { 'lib.js': `export const probe = () => globalThis.fetch(${JSON.stringify(url)});` }));
    // Disabled fetch may trap the component rather than throw a catchable JS error.
    await expect(runtime.execute(network, '[]', grant, async () => null)).rejects.toThrow();
    await expect(runtime.compile(bundle('import {value} from "./lib.js"; export function run() { return value; }',
      { 'lib.js': `export const value = await globalThis.fetch(${JSON.stringify(url)});` }))).rejects.toThrow('TYPESCRIPT_COMPILATION_FAILED');
    expect(requests).toBe(0);
  }, 60000);

  it('keeps library tool calls on the existing bounded effect broker', async () => {
    const runtime = host();
    const artifact = await runtime.compile(bundle('import {read} from "./lib.js"; export async function run() { return [await read(), await read()]; }',
      { 'lib.js': `import {invoke_tool} from '${api}'; export const read = () => invoke_tool('urn:test:read', {value: 1});` }));
    const calls: unknown[] = [];
    expect(await runtime.execute(artifact, '[]', grant, async effect => { calls.push(effect); return 7; })).toBe('[7,7]');
    expect(calls).toEqual([1, 2].map(id => ({ id, kind: 'tool', tool: 'urn:test:read', input: { value: 1 } })));
    let dispatched = 0;
    await expect(runtime.execute(artifact, '[]', { ...grant, maxCalls: 1 }, async () => { dispatched++; return 7; })).rejects.toThrow('BUDGET');
    expect(dispatched).toBe(1);
  }, 60000);

  it('bounds imported initialization and imported allocation with the same timeout and memory limits', async () => {
    const runtime = host({ compileTimeoutMs: 15000 });
    await expect(runtime.compile(bundle('import {value} from "./lib.js"; export function run() { return value; }',
      { 'lib.js': 'while (true) {} export const value = 1;' }))).rejects.toThrow('TIMEOUT');
    await expect(runtime.compile(bundle('import {value} from "./lib.js"; export function run() { return value; }',
      { 'lib.js': 'export const value = new Uint8Array(70 * 1024 * 1024);' }))).rejects.toThrow('COMPILATION_FAILED');
    const artifact = await runtime.compile(bundle('import {allocate} from "./lib.js"; export function run() { return allocate(); }',
      { 'lib.js': 'export const allocate = () => new Uint8Array(70 * 1024 * 1024).length;' }));
    await expect(runtime.execute(artifact, '[]', grant, async () => null)).rejects.toThrow();
    const good = await runtime.compile('export function run() { return 2; }');
    expect(await runtime.execute(good, '[]', grant, async () => null)).toBe('2');
  }, 60000);
});
