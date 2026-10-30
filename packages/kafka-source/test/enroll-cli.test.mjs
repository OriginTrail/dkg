import { test, expect, vi, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, stat, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { descriptorHash } from '@origintrail-official/kafka-plugin/registry';
import { main, runEnrollment } from '../src/enroll-cli.mjs';

const owner = '0x' + 'a'.repeat(40);
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; delete process.env.DKG_TEST_REGISTRY_TOKEN; });

test('direct and symlinked executable entrypoints run while module imports stay passive', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-enroll-entrypoint-'));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const entrypoint = fileURLToPath(new URL('../src/enroll-cli.mjs', import.meta.url));
  const binary = join(directory, 'dkg-kafka-enroll');
  await symlink(entrypoint, binary);
  const execute = promisify(execFile);
  for (const path of [entrypoint, binary]) {
    const help = await execute(process.execPath, [path, '--help'], { timeout: 10_000 });
    expect(help.stdout).toContain('dkg-kafka-enroll --registry-url URL');
    expect(help.stderr).toBe('');
    await expect(execute(process.execPath, [path], { timeout: 10_000 })).rejects.toMatchObject({
      code: 1, stdout: '', stderr: 'KAFKA_REGISTRY_CLI_ARGUMENTS_REQUIRED\n',
    });
  }
  const importer = join(directory, 'importer.mjs');
  await writeFile(importer, `await import(${JSON.stringify(pathToFileURL(binary).href)});\nconsole.log('import-complete');\n`);
  const imported = await execute(process.execPath, [importer], { timeout: 10_000 });
  expect(imported).toMatchObject({ stdout: 'import-complete\n', stderr: '' });
}, 20_000);

test('CLI resolves an authenticated snapshot into a private file and refuses overwrite', async t => {
  const descriptor = { name: 'Application events', kafkaBootstrapUrl: 'kafka://broker.example:9094',
    kafkaTopicName: 'application.events', dataFormat: 'JSON', clusterId: 'example-cluster' };
  const snapshot = { version: 1, ual: 'urn:registry:entry', contextGraphId: 'catalog',
    publisherIri: 'urn:publisher:alpha', descriptor, descriptorHash: descriptorHash(descriptor) };
  let reads = 0;
  const server = createServer((req, res) => {
    reads++;
    expect(req.headers.authorization).toBe('Bearer private-registry-token');
    expect(decodeURIComponent(req.url)).toContain('/urn:registry:entry?includeRegistry=true');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ '@id': snapshot.ual, registry: snapshot }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.onTestFinished(() => new Promise(resolve => server.close(resolve)));
  const directory = await mkdtemp(join(tmpdir(), 'dkg-registry-enroll-test-'));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const options = join(directory, 'options.json');
  const out = join(directory, 'source.private.json');
  await writeFile(options, JSON.stringify({ id: 'selected', groupId: 'operator-group', agentAddress: owner,
    contextGraphId: owner + '/private-events', fromBeginning: false }));
  process.env.DKG_TEST_REGISTRY_TOKEN = 'private-registry-token';
  const args = ['--registry-url', `http://127.0.0.1:${server.address().port}/api/kafka/streams`, '--ual', snapshot.ual,
    '--registry-context-graph', 'catalog', '--registry-token-env', 'DKG_TEST_REGISTRY_TOKEN',
    '--expected-hash', snapshot.descriptorHash, '--expected-publisher', snapshot.publisherIri, '--options', options, '--out', out];
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await main(args);
  expect(process.exitCode).toBeUndefined();
  const content = await readFile(out, 'utf8');
  expect(content).not.toContain('private-registry-token');
  expect(JSON.parse(content).registryRef).toEqual(snapshot);
  expect((await stat(out)).mode & 0o777).toBe(0o600);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await main(args);
  expect(process.exitCode).toBe(1);
  expect(error).toHaveBeenCalledWith('KAFKA_REGISTRY_ENROLLMENT_FAILED');
  expect(await readFile(out, 'utf8')).toBe(content);
  expect(log.mock.calls.flat().join(' ')).not.toContain('private-registry-token');
  expect(reads).toBe(2);
});

test('CLI validates flags and environment refs with sanitized errors', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await runEnrollment(['--help']); expect(log).toHaveBeenCalledWith(expect.stringContaining('dkg-kafka-enroll'));
  await expect(runEnrollment([])).rejects.toThrow('KAFKA_REGISTRY_CLI_ARGUMENTS_REQUIRED');
  const required = ['--registry-url', 'http://localhost/api/kafka/streams', '--ual', 'urn:entry',
    '--registry-context-graph', 'catalog', '--options', '/unused', '--out', '/unused-out'];
  await expect(runEnrollment([...required, '--registry-token-env', 'MISSING_REGISTRY_TEST_TOKEN'])).rejects.toThrow('KAFKA_REGISTRY_TOKEN_ENV_REQUIRED');
  await expect(runEnrollment([...required, '--registry-token-env', 'bad name'])).rejects.toThrow('KAFKA_REGISTRY_TOKEN_ENV_REQUIRED');
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await main([]); expect(error).toHaveBeenCalledWith('KAFKA_REGISTRY_CLI_ARGUMENTS_REQUIRED');
  await main(['--unknown-private-value']); expect(error).toHaveBeenLastCalledWith('KAFKA_REGISTRY_ENROLLMENT_FAILED');
});
