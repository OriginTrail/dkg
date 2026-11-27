import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
let fixture: string;

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'dkg-cli-import-boundary-'));
  await writeFile(join(fixture, 'reject-daemon.mjs'), String.raw`
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (/\/cli\/(?:src|dist)\/daemon\/(?:lifecycle|handle-request)\.[jt]s$/.test(new URL(resolved.url).pathname)) {
    throw new Error('Client command eagerly loaded the daemon: ' + resolved.url);
  }
  return resolved;
}
`);
  await writeFile(join(fixture, 'register.mjs'), `
import { register } from 'node:module';
register('./reject-daemon.mjs', import.meta.url);
`);
});

afterAll(async () => {
  await rm(fixture, { recursive: true, force: true });
});

it.each(['ka', 'sync'])('%s keeps daemon startup out of a client command', async (command) => {
  const { stdout } = await exec(process.execPath, [
    '--import', pathToFileURL(join(root, 'node_modules/tsx/dist/loader.mjs')).href,
    '--import', pathToFileURL(join(fixture, 'register.mjs')).href,
    join(root, 'packages/cli/src/cli.ts'), command, '--help',
  ], { timeout: 60_000 });
  expect(stdout).toContain('Usage:');
  expect(stdout).toContain(command === 'ka' ? 'knowledge-asset' : 'sync');
});
