import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checksumPathFor,
  downloadBinaryAsset,
  ensureCurrentPlatformBinary,
  getSupportedTarget,
  parseSha256File,
  pyInstallerNameForTarget,
  readCliVersion,
  releaseAssetUrl,
  releaseBaseUrl,
  releaseTagForVersion,
  sha256Hex,
  SUPPORTED_TARGETS,
} from '../scripts/bundle-markitdown-binaries.mjs';

describe('bundle-markitdown-binaries helpers', () => {
  let tmpPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(tmpPaths.map((path) => rm(path, { recursive: true, force: true })));
    tmpPaths = [];
  });

  it('reads the CLI version from package.json', async () => {
    const pkgDir = await mkdtemp(join(tmpdir(), 'dkg-markitdown-pkg-'));
    tmpPaths.push(pkgDir);
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ version: '9.0.0-rc.2' }, null, 2));

    expect(readCliVersion(pkgDir)).toBe('9.0.0-rc.2');
  });

  it('parses standard sha256 files', () => {
    expect(parseSha256File('abc123  markitdown-linux-x64\n')).toBe('abc123');
    expect(releaseTagForVersion('9.0.0-rc.2')).toBe('v9.0.0-rc.2');
    expect(releaseBaseUrl('9.0.0-rc.2')).toBe(
      'https://github.com/OriginTrail/dkg-v9/releases/download/v9.0.0-rc.2',
    );
    expect(releaseAssetUrl('https://example.invalid/release', 'markitdown-linux-x64')).toBe(
      'https://example.invalid/release/markitdown-linux-x64',
    );
    expect(pyInstallerNameForTarget({ assetName: 'markitdown-win32-x64.exe' })).toBe('markitdown-win32-x64');
    expect(pyInstallerNameForTarget({ assetName: 'markitdown-linux-x64' })).toBe('markitdown-linux-x64');
  });

  it('downloads an asset and writes its checksum sidecar', async () => {
    const destinationDir = await mkdtemp(join(tmpdir(), 'dkg-markitdown-bin-'));
    tmpPaths.push(destinationDir);

    const assetName = 'markitdown-test';
    const bytes = Buffer.from('# test markdown\n', 'utf-8');
    const hash = sha256Hex(bytes);

    const server = createServer((req, res) => {
      if (req.url === `/release/${assetName}`) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(bytes);
        return;
      }
      if (req.url === `/release/${assetName}.sha256`) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`${hash}  ${assetName}\n`);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}/release`;

    try {
      const result = await downloadBinaryAsset({
        assetName,
        destinationDir,
        baseUrl,
      });

      expect(result.status).toBe('downloaded');
      expect(await readFile(join(destinationDir, assetName))).toEqual(bytes);
      expect(await readFile(checksumPathFor(join(destinationDir, assetName)), 'utf-8')).toContain(hash);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('keeps a verified existing asset without hitting the network', async () => {
    const destinationDir = await mkdtemp(join(tmpdir(), 'dkg-markitdown-present-'));
    tmpPaths.push(destinationDir);

    const assetName = 'markitdown-test';
    const bytes = Buffer.from('# verified markdown\n', 'utf-8');
    const hash = sha256Hex(bytes);
    const binaryPath = join(destinationDir, assetName);
    await writeFile(binaryPath, bytes);
    await writeFile(checksumPathFor(binaryPath), `${hash}  ${assetName}\n`, 'utf-8');

    const result = await downloadBinaryAsset({
      assetName,
      destinationDir,
      baseUrl: 'http://127.0.0.1:1/release',
    });

    expect(result.status).toBe('present');
    expect(await readFile(binaryPath)).toEqual(bytes);
  });

  it('re-downloads an existing asset when its checksum sidecar is missing', async () => {
    const destinationDir = await mkdtemp(join(tmpdir(), 'dkg-markitdown-redownload-'));
    tmpPaths.push(destinationDir);

    const assetName = 'markitdown-test';
    const binaryPath = join(destinationDir, assetName);
    await writeFile(binaryPath, Buffer.from('stale bytes', 'utf-8'));

    const bytes = Buffer.from('# refreshed markdown\n', 'utf-8');
    const hash = sha256Hex(bytes);

    const server = createServer((req, res) => {
      if (req.url === `/release/${assetName}`) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(bytes);
        return;
      }
      if (req.url === `/release/${assetName}.sha256`) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`${hash}  ${assetName}\n`);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;

    try {
      const result = await downloadBinaryAsset({
        assetName,
        destinationDir,
        baseUrl: `http://127.0.0.1:${port}/release`,
      });

      expect(result.status).toBe('downloaded');
      expect(await readFile(binaryPath)).toEqual(bytes);
      expect(await readFile(checksumPathFor(binaryPath), 'utf-8')).toContain(hash);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('rejects checksum mismatches from the release asset feed', async () => {
    const destinationDir = await mkdtemp(join(tmpdir(), 'dkg-markitdown-bad-'));
    tmpPaths.push(destinationDir);

    const assetName = 'markitdown-test';
    const bytes = Buffer.from('bad checksum case', 'utf-8');

    const server = createServer((req, res) => {
      if (req.url === `/release/${assetName}`) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(bytes);
        return;
      }
      if (req.url === `/release/${assetName}.sha256`) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`deadbeef  ${assetName}\n`);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;

    try {
      await expect(downloadBinaryAsset({
        assetName,
        destinationDir,
        baseUrl: `http://127.0.0.1:${port}/release`,
      })).rejects.toThrow(/Checksum mismatch/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('stages the current-platform asset from a matching release URL', async () => {
    const target = getSupportedTarget();
    expect(target).not.toBeNull();
    if (!target) return;

    const packageDir = await mkdtemp(join(tmpdir(), 'dkg-markitdown-package-'));
    const outputDir = await mkdtemp(join(tmpdir(), 'dkg-markitdown-output-'));
    tmpPaths.push(packageDir, outputDir);
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ version: '9.0.0-rc.3' }, null, 2));

    const bytes = Buffer.from('platform-specific binary', 'utf-8');
    const hash = sha256Hex(bytes);

    const server = createServer((req, res) => {
      if (req.url === `/release/${target.assetName}`) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(bytes);
        return;
      }
      if (req.url === `/release/${target.assetName}.sha256`) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`${hash}  ${target.assetName}\n`);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;

    try {
      const result = await ensureCurrentPlatformBinary({
        packageDir,
        outputDir,
        releaseBaseUrlOverride: `http://127.0.0.1:${port}/release`,
      });

      expect(result.status).toBe('downloaded');
      expect(result.source).toBe('release');
      expect(existsSync(join(outputDir, target.assetName))).toBe(true);
      expect(await readFile(join(outputDir, target.assetName))).toEqual(bytes);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('declares npm postinstall staging in the CLI package manifest', async () => {
    const pkgRaw = await readFile(new URL('../package.json', import.meta.url), 'utf-8');
    const pkg = JSON.parse(pkgRaw) as {
      scripts?: Record<string, string>;
      files?: string[];
    };

    expect(pkg.scripts?.postinstall).toContain('bundle-markitdown-binaries.mjs');
    expect(pkg.scripts?.postinstall).toContain('--current-platform');
    expect(pkg.scripts?.postinstall).toContain('--best-effort');
    expect(pkg.files).toContain('markitdown-targets.json');
    expect(pkg.files).toContain('scripts');
  });

  it('keeps MarkItDown target metadata in a shared JSON file that the release workflow reads', async () => {
    const targetsRaw = await readFile(new URL('../markitdown-targets.json', import.meta.url), 'utf-8');
    const targets = JSON.parse(targetsRaw) as Array<{ assetName: string; runner: string }>;
    expect(targets.map((target) => target.assetName)).toEqual(SUPPORTED_TARGETS.map((target) => target.assetName));

    const workflowRaw = await readFile(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf-8');
    expect(workflowRaw).toContain('markitdown-targets.json');
    expect(workflowRaw).toContain('fromJSON(needs.markitdown-target-matrix.outputs.matrix)');
  });
});
