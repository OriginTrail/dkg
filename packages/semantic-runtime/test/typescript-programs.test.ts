import { afterEach, describe, expect, it } from 'vitest';
import { TypeScriptProgramHost } from '../src/typescript-programs.js';

const hosts = new Set<TypeScriptProgramHost>();
const host = (options = {}) => { const value = new TypeScriptProgramHost(options); hosts.add(value); return value; };
afterEach(async () => { await Promise.all([...hosts].map(value => value.stop())); hosts.clear(); });
const grant = { children: [], maxCalls: 16, maxConcurrency: 4, timeoutMs: 5000 };
const api = '@origintrail-official/dkg-graph-computer/program';

describe('stored TypeScript Program runtime', () => {
  it('runs real Wasm callbacks with bounded concurrent host calls and ordered reduction', async () => {
    const runtime = host();
    const artifact = await runtime.compile(`import { pipe, map, reduce, invoke_program } from '${api}';
      export async function run(rows: unknown[]) {
        return pipe(rows, map(row => invoke_program('urn:test:double', [row]), {concurrency: 4}),
          reduce((values, value) => [...values, value], []));
      }`);
    let active = 0, peak = 0;
    const output = await runtime.execute(artifact, '[[1,2,3,4,5,6]]', grant, async effect => {
      if (effect.kind !== 'program') throw new Error('Expected child call');
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, (7 - Number(effect.args[0])) * 5));
      active--;
      return Number(effect.args[0]) * 2;
    });
    expect(JSON.parse(output)).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(4);
    expect(active).toBe(0);
  }, 60000);

  it('pipes direct tools and child Programs through one bounded host channel', async () => {
    const runtime = host();
    const artifact = await runtime.compile(`import { invoke_tool, invoke_program } from '${api}';
      export async function run() {
        const rows = await invoke_tool('urn:tool:read', {sparql: 'SELECT'});
        return invoke_program('urn:program:double', [rows[0]]);
      }`);
    const calls: unknown[] = [];
    expect(await runtime.execute(artifact, '[]', grant, async effect => {
      calls.push(effect);
      return effect.kind === 'tool' ? [6] : Number(effect.args[0]) * 2;
    })).toBe('12');
    expect(calls).toEqual([
      {id: 1, kind: 'tool', tool: 'urn:tool:read', input: {sparql: 'SELECT'}},
      {id: 2, kind: 'program', program: 'urn:program:double', args: [6]},
    ]);
    let dispatched = 0;
    await expect(runtime.execute(artifact, '[]', {...grant, maxCalls: 1}, async () => { dispatched++; return [6]; }))
      .rejects.toThrow('BUDGET');
    expect(dispatched).toBe(1);
  }, 60000);

  it('rejects imports outside the guest API during compilation', async () => {
    await expect(host().compile('import fs from "node:fs"; export function run() { return fs.readFileSync("/etc/passwd"); }'))
      .rejects.toThrow('Only the Graph Computer');
  });

  it('terminates an infinite guest loop and can still execute another Program', async () => {
    const runtime = host();
    const loop = await runtime.compile('export function run() { while (true) {} }');
    await expect(runtime.execute(loop, '[]', { ...grant, timeoutMs: 200 }, async () => null)).rejects.toThrow('TIMEOUT');
    const good = await runtime.compile('export function run(value) { return value; }');
    expect(await runtime.execute(good, '[42]', grant, async () => null)).toBe('42');
  }, 60000);

  it('enforces the host concurrency budget independently of the helper', async () => {
    const runtime = host();
    const artifact = await runtime.compile(`import { invoke_program } from '${api}';
      export async function run() { return Promise.all([1,2,3].map(n => invoke_program('urn:test', [n]))); }`);
    let dispatched = 0;
    await expect(runtime.execute(artifact, '[]', { ...grant, maxConcurrency: 2 }, async () => { dispatched++; return 1; }))
      .rejects.toThrow('BUDGET');
    expect(dispatched).toBe(0);
  }, 60000);

  it('caps guest linear memory independently of the V8 heap', async () => {
    const runtime = host();
    const artifact = await runtime.compile('export function run() { return new Uint8Array(70 * 1024 * 1024).length; }');
    await expect(runtime.execute(artifact, '[]', grant, async () => null)).rejects.toThrow();
  }, 60000);

  it('rejects non-JSON results rather than silently turning NaN into null', async () => {
    const runtime = host();
    const artifact = await runtime.compile('export function run() { return NaN; }');
    await expect(runtime.execute(artifact, '[]', grant, async () => null)).rejects.toThrow();
  }, 60000);

  it('bounds build-time initialization and releases the failed compilation slot', async () => {
    const runtime = host({ compileTimeoutMs: 5000 });
    await expect(runtime.compile('while (true) {} export function run() { return 1; }')).rejects.toThrow('TIMEOUT');
    const artifact = await runtime.compile('export function run() { return 2; }');
    expect(await runtime.execute(artifact, '[]', grant, async () => null)).toBe('2');
  }, 60000);

  it('caps guest memory during module initialization before creating a snapshot', async () => {
    const runtime = host();
    await expect(runtime.compile('const data = new Uint8Array(70 * 1024 * 1024); export function run() { return data.length; }'))
      .rejects.toThrow('TYPESCRIPT_COMPILATION_FAILED');
  }, 60000);
});
