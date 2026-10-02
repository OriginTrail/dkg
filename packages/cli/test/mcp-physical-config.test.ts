import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectMcpClientTargets, type ClientTarget } from '../src/mcp-client-registry.js';
import { readRegisteredServerKeys, readRegistration, removeRegistration, writeRegistration } from '../src/mcp-client-config.js';
import { mcpConfigPersistenceStrategy } from '../src/mcp-config-metadata.js';
import { detectMcpRuntime } from '../src/mcp-runtime.js';

vi.mock('../src/mcp-runtime.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/mcp-runtime.js')>();
  return { ...actual, detectMcpRuntime: vi.fn(actual.detectMcpRuntime) };
});

vi.mock('../src/mcp-config-metadata.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/mcp-config-metadata.js')>();
  return { ...actual, mcpConfigPersistenceStrategy: vi.fn(actual.mcpConfigPersistenceStrategy) };
});
const actualMetadata = await vi.importActual<typeof import('../src/mcp-config-metadata.js')>('../src/mcp-config-metadata.js');
const desired = { command: 'node', args: ['dkg.js'], env: { DKG_HOME: '/fixture' } };
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dkg-mcp-physical-'));
  vi.mocked(mcpConfigPersistenceStrategy).mockImplementation(actualMetadata.mcpConfigPersistenceStrategy);
});
afterEach(() => { vi.clearAllMocks(); rmSync(directory, { recursive: true, force: true }); });

function fixture(aliasFirst: boolean) {
  const original = join(directory, 'original.json');
  const replacement = join(directory, 'replacement.json');
  const alias = join(directory, 'alias.json');
  const source = '{"mcpServers":{"dkg":{"command":"old"},"other":{"command":"keep"}}}\n';
  writeFileSync(original, source);
  writeFileSync(replacement, source);
  symlinkSync(original, alias);
  const target: ClientTarget = { id: 'cursor', name: 'Cursor', location: 'native', format: 'json', serverContainer: 'mcpServers', configPath: original, displayPath: original };
  const windows: ClientTarget = { ...target, location: 'windows-wsl', configPath: alias, displayPath: alias };
  const clients = aliasFirst ? [windows, target] : [target, windows];
  const selections = selectMcpClientTargets(clients);
  expect(selections).toHaveLength(1);
  const { file, aliases } = selections[0]!;
  expect(file.destination).toBe(realpathSync(original));
  expect(aliases).toEqual(clients);
  expect(file).not.toHaveProperty('location');
  const retarget = () => { unlinkSync(alias); symlinkSync(replacement, alias); };
  const assertUnchanged = () => {
    expect(readFileSync(original, 'utf8')).toBe(source);
    expect(readFileSync(replacement, 'utf8')).toBe(source);
    expect(readdirSync(directory).sort()).toEqual(['alias.json', 'original.json', 'replacement.json']);
  };
  return { file, retarget, assertUnchanged };
}

it.each([false, true].flatMap(aliasFirst => ['write', 'remove'].map(operation => ({ aliasFirst, operation }))))(
  'rejects $operation after confirmation-time retargeting (alias first: $aliasFirst)', ({ aliasFirst, operation }) => {
    const { file, retarget, assertUnchanged } = fixture(aliasFirst);
    expect(readRegistration(file).kind).toBe('entry');
    retarget();
    const mutate = () => operation === 'write' ? writeRegistration(file, desired) : removeRegistration(file);
    expect(mutate).toThrow('changed since inspection');
    assertUnchanged();
  },
);

it.each([false, true])('revalidates every selected alias before publication (alias first: %s)', aliasFirst => {
  const { file, retarget, assertUnchanged } = fixture(aliasFirst);
  const native = actualMetadata.mcpConfigPersistenceStrategy(file.destination);
  vi.mocked(mcpConfigPersistenceStrategy).mockReturnValue({
    ...native,
    prepare(replacement) { native.prepare(replacement); retarget(); },
  });
  expect(() => writeRegistration(file, desired)).toThrow('changed since inspection');
  assertUnchanged();
});

it('rejects a source snapshot owned by another physical config', () => {
  const { file, assertUnchanged } = fixture(false);
  const source = file.readSource();
  expect(() => file.write('{}', { ...source, destination: join(directory, 'replacement.json') })).toThrow('different destination');
  assertUnchanged();
});

it('rejects snapshots exchanged between owners of the same destination', () => {
  const original = join(directory, 'shared.json');
  const aliasA = join(directory, 'alias-a.json');
  const aliasB = join(directory, 'alias-b.json');
  writeFileSync(original, '{}\n');
  symlinkSync(original, aliasA);
  symlinkSync(original, aliasB);
  const base: ClientTarget = {
    id: 'cursor', name: 'Cursor', location: 'native', format: 'json',
    serverContainer: 'mcpServers', configPath: aliasA, displayPath: aliasA,
  };
  const first = selectMcpClientTargets([base])[0]!.file;
  const second = selectMcpClientTargets([{
    ...base,
    configPath: aliasB,
    displayPath: aliasB,
  }])[0]!.file;

  const firstSource = first.readSource();
  expect(first.destination).toBe(second.destination);
  expect(() => second.write('{"changed":true}\n', firstSource))
    .toThrow('different physical config owner');
  expect(readFileSync(original, 'utf8')).toBe('{}\n');
});

it('constructs and reads physical configs without detecting process runtime', () => {
  const { file } = fixture(false);
  expect(readRegistration(file).kind).toBe('entry');
  expect(readRegisteredServerKeys(file).ok).toBe(true);
  expect(detectMcpRuntime).not.toHaveBeenCalled();
});

it('detects process runtime when persisting a physical config', () => {
  const { file } = fixture(false);
  vi.mocked(detectMcpRuntime).mockClear();
  writeRegistration(file, desired);
  expect(detectMcpRuntime).toHaveBeenCalledTimes(1);
  expect(readRegistration(file)).toMatchObject({ kind: 'entry', registration: { command: desired.command } });
});
