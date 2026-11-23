import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configureUbuntuApt } from '../../ci/prepare-ubuntu-apt.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ubuntu-apt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'sources.list.d'));
  fs.mkdirSync(path.join(root, 'apt.conf.d'));
  return root;
}

test('archive fallback preserves suites, components, signing keys and unrelated feeds', t => {
  const root = fixture(t);
  const source = 'Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates noble-backports\nComponents: main universe restricted multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\nTypes: deb\nURIs: https://security.ubuntu.com/ubuntu\nSuites: noble-security\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n';
  const sourcePath = path.join(root, 'sources.list.d', 'ubuntu.sources');
  fs.writeFileSync(sourcePath, source);
  const otherPath = path.join(root, 'sources.list.d', 'other.list');
  const other = 'deb [signed-by=/key.gpg] https://packages.microsoft.com/ubuntu/24.04/prod noble main\n';
  fs.writeFileSync(otherPath, other);
  configureUbuntuApt(root);
  const updated = fs.readFileSync(sourcePath, 'utf8');
  assert.equal(updated, source.replaceAll('http://azure.archive.ubuntu.com/ubuntu/', 'mirror+file:/etc/apt/apt-mirrors.txt')
    .replaceAll('https://security.ubuntu.com/ubuntu', 'mirror+file:/etc/apt/apt-mirrors.txt'));
  assert.equal(fs.readFileSync(otherPath, 'utf8'), other);
  assert.match(fs.readFileSync(path.join(root, 'apt-mirrors.txt'), 'utf8'), /kernel\.org.*priority:1\nhttps:\/\/archive\.ubuntu\.com.*priority:2/);
  assert.doesNotMatch(updated, /trusted=yes|AllowInsecure|allow-unauthenticated/);
  configureUbuntuApt(root);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), updated, 'setup is idempotent for the hosted mirror-list format');
});

test('legacy signed source lines retain security and release pockets', t => {
  const root = fixture(t);
  const sourcePath = path.join(root, 'sources.list');
  fs.writeFileSync(sourcePath, 'deb [signed-by=/ubuntu.gpg] http://archive.ubuntu.com/ubuntu resolute main\ndeb https://security.ubuntu.com/ubuntu/ resolute-security main\n');
  configureUbuntuApt(root);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'deb [signed-by=/ubuntu.gpg] mirror+file:/etc/apt/apt-mirrors.txt resolute main\ndeb mirror+file:/etc/apt/apt-mirrors.txt resolute-security main\n');
});

test('an unsupported source layout fails without writing configuration', t => {
  const root = fixture(t);
  assert.throws(() => configureUbuntuApt(root), /No supported Ubuntu archive/);
  assert.equal(fs.existsSync(path.join(root, 'apt-mirrors.txt')), false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'apt.conf.d')), []);
});
