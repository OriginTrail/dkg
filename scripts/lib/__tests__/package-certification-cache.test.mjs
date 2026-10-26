import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readNpmCache } from '../package-certification/npm-cache.mjs';
import { hash } from '../package-certification/bundle.mjs';
import { archive } from './package-certification-fixture.mjs';

test('npm 10 global installation produces cache evidence through its bundled cacache 19', { timeout: 60_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-cache-compatibility-'));
  const cacheDirectory = path.join(root, 'cache'), prefix = path.join(root, 'prefix');
  const npmExecutable = fs.realpathSync(path.join(path.dirname(process.execPath),
    process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'npm'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.toLowerCase().startsWith('npm_config_') && !['NODE_PATH', 'NODE_OPTIONS'].includes(key)));
  Object.assign(env, { HOME: root, NPM_CONFIG_CACHE: cacheDirectory,
    NPM_CONFIG_USERCONFIG: path.join(root, 'npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(root, 'global-npmrc') });
  fs.writeFileSync(env.NPM_CONFIG_USERCONFIG, ''); fs.writeFileSync(env.NPM_CONFIG_GLOBALCONFIG, '');
  const npm = args => promisify(execFile)(process.execPath, [npmExecutable, ...args], { cwd: root, env, timeout: 30_000 });
  const name = '@origintrail-official/cache-fixture', version = '1.0.0', tarball = 'tarballs/cache-fixture.tgz';
  const bytes = archive({ 'package.json': JSON.stringify({ name, version }), 'index.js': 'export const fixture = true;' });
  const integrity = `sha512-${hash(bytes, 'sha512', 'base64')}`;
  const requested = [];
  let registry;
  const server = http.createServer((req, res) => {
    const route = decodeURIComponent(req.url);
    requested.push(route);
    if (route === `/registry/${tarball}`) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(bytes);
    } else if (route === `/registry/${name}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name, 'dist-tags': { latest: version }, versions: {
        [version]: { name, version, dist: { integrity, tarball: `${registry}${tarball}` } },
      } }));
    } else { res.writeHead(404); res.end(); }
  });
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections(); await closed;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  registry = `http://127.0.0.1:${server.address().port}/registry/`;
  const npmVersion = (await npm(['--version'])).stdout.trim();
  assert.match(npmVersion, /^10\./, 'the certification compatibility test requires the supported npm 10 toolchain');
  await npm(['install', '--global', '--prefix', prefix, `${name}@${version}`, `--registry=${registry}`,
    '--replace-registry-host=never', '--no-audit', '--no-fund']);
  assert.ok(requested.includes(`/registry/${name}`));
  assert.ok(requested.includes(`/registry/${tarball}`));
  const { reader, archives } = await readNpmCache({ npmExecutable, npmVersion, cacheDirectory,
    manifest: { packages: [{ name, version, tarball, integrity }] },
  });
  assert.match(reader.cacacheVersion, /^19\./);
  assert.equal(reader.npmVersion, npmVersion);
  assert.deepEqual(archives, { [`${name}@${version}`]: { integrity, resolved: `${registry}${tarball}` } });
});
