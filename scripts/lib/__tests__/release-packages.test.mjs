import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildInfoPayload,
  discoverPublishablePackages,
  findReleaseVersionMismatches,
  writeBuildInfo,
} from '../../release-packages.mjs';

function writePackage(root, rel, pkg) {
  const filePath = path.join(root, rel, 'package.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function withFixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-release-packages-'));
  try {
    writePackage(root, '.', { name: 'dkg-v10', version: '1.2.3', private: true });
    writePackage(root, 'packages/cli', { name: '@origintrail-official/dkg', version: '1.2.3' });
    writePackage(root, 'packages/query', { name: '@origintrail-official/dkg-query', version: '1.2.3' });
    writePackage(root, 'packages/private-tool', { name: '@origintrail-official/private-tool', version: '1.2.3', private: true });
    writePackage(root, 'packages/other-scope', { name: '@example/other', version: '1.2.3' });
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('discovers public OriginTrail packages only', () => withFixture((root) => {
  assert.deepEqual(
    discoverPublishablePackages(root).map((pkg) => pkg.name),
    ['@origintrail-official/dkg', '@origintrail-official/dkg-query'],
  );
}));

test('finds every release package version mismatch, including private packages and the root', () => withFixture((root) => {
  writePackage(root, 'packages/private-tool', {
    name: '@origintrail-official/private-tool',
    version: '1.2.4',
    private: true,
  });
  const mismatches = findReleaseVersionMismatches('1.2.3', root);
  assert.deepEqual(mismatches.map((m) => m.path), ['packages/private-tool/package.json']);
  assert.equal(mismatches[0].actual, '1.2.4');
}));

test('build-info payload matches the daemon manifest contract', () => {
  assert.deepEqual(buildInfoPayload({
    commit: 'abcdef1234567890',
    distTag: 'rc',
    ciRun: 'manual',
    buildTime: '2026-07-07T00:00:00.000Z',
  }), {
    commit: 'abcdef1234567890',
    commitShort: 'abcdef12',
    buildTime: '2026-07-07T00:00:00.000Z',
    distTag: 'rc',
    ciRun: 'manual',
  });
});

test('writeBuildInfo writes packages/cli/build-info.json', () => withFixture((root) => {
  const { outputPath, payload } = writeBuildInfo({
    rootDir: root,
    commit: '1234567890abcdef',
    distTag: 'latest',
    buildTime: '2026-07-07T00:00:00.000Z',
  });
  assert.equal(path.relative(root, outputPath), 'packages/cli/build-info.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), payload);
  assert.equal(payload.commitShort, '12345678');
}));
