import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeNetworkId } from '../../core/src/genesis.js';
import { validateStartupGenesis } from '../src/daemon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');
const cliSource = join(__dirname, '..', 'src', 'cli.ts');
const tsxLoader = join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');

describe('daemon startup genesis validation', () => {
  it('continues when the selected network genesis id matches its network id', async () => {
    const networkId = await computeNetworkId('gnosis-mainnet');

    await expect(validateStartupGenesis({
      networkName: 'DKG V10 Gnosis Mainnet',
      genesisId: 'gnosis-mainnet',
      networkId,
    })).resolves.toEqual({ ok: true, networkId });
  });

  it('reports the selected overlay when the selected genesis id mismatches its network id', async () => {
    const staleNetworkId = await computeNetworkId('base-mainnet');
    const selectedNetworkId = await computeNetworkId('neuroweb-mainnet');

    await expect(validateStartupGenesis({
      networkName: 'DKG V10 NeuroWeb Mainnet',
      genesisId: 'neuroweb-mainnet',
      networkId: staleNetworkId,
    })).resolves.toEqual({
      ok: false,
      networkId: selectedNetworkId,
      messages: [
        `FATAL: genesis mismatch! Expected networkId ${staleNetworkId.slice(0, 16)}... but computed ${selectedNetworkId.slice(0, 16)}...`,
        `This node's genesis does not match DKG V10 NeuroWeb Mainnet. Rebuild or update the selected network config.`,
      ],
    });
  });

  it('rejects pre-deployment configs with placeholder relay peer ids', async () => {
    const networkId = await computeNetworkId('base-mainnet');

    const result = await validateStartupGenesis({
      networkName: 'DKG V10 Base Mainnet',
      genesisId: 'base-mainnet',
      networkId,
      _status: 'pre-deployment: replace PEER_ID_* relay values before enabling Base mainnet',
      relays: ['/ip4/178.105.87.39/tcp/9090/p2p/PEER_ID_SOLARIS'],
    });

    expect(result.ok).toBe(false);
    expect(result.networkId).toBe(networkId);
    if (!result.ok) {
      expect(result.messages).toContain(
        'FATAL: network config DKG V10 Base Mainnet is marked pre-deployment: replace PEER_ID_* relay values before enabling Base mainnet.',
      );
      expect(result.messages.some(message => message.includes('PEER_ID_SOLARIS'))).toBe(true);
    }
  });
});

async function writeWorkspaceTsconfig(tsconfigPath: string): Promise<void> {
  const packagesDir = join(repoRoot, 'packages');
  const paths: Record<string, string[]> = {};

  for (const packageDir of await readdir(packagesDir)) {
    const packageJsonPath = join(packagesDir, packageDir, 'package.json');
    if (!existsSync(packageJsonPath)) continue;
    const parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { name?: string };
    if (!parsed.name) continue;
    paths[parsed.name] = [`packages/${packageDir}/src/index.ts`];
    paths[`${parsed.name}/*`] = [`packages/${packageDir}/src/*`];
  }

  await writeFile(
    tsconfigPath,
    JSON.stringify({ compilerOptions: { baseUrl: repoRoot, paths } }),
  );
}

async function runSupervisor(tempHome: string, tsconfigPath: string): Promise<void> {
  const env = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    TSX_TSCONFIG_PATH: tsconfigPath,
    DKG_DISABLE_TELEMETRY: '1',
  };
  delete env.DKG_HOME;
  delete env.DKG_NO_BLUE_GREEN;

  const child = spawn(
    process.execPath,
    ['--import', tsxLoader, cliSource, 'daemon-supervisor'],
    { env, stdio: 'pipe' },
  );

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
  child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));

  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolveExit(code));
  });

  if (code !== 0) {
    throw new Error(
      `daemon-supervisor exited with ${code}\n` +
      Buffer.concat(stdout).toString('utf8') +
      Buffer.concat(stderr).toString('utf8'),
    );
  }
  expect(code).toBe(0);
}

describe('daemon lifecycle control-plane files', () => {
  let tempRoot: string | undefined;

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  it('passes the selected DKG home to the supervised daemon worker', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'dkg-supervised-home-'));
    const selectedHome = join(tempRoot, '.dkg-dev');
    const defaultHome = join(tempRoot, '.dkg');
    const tsconfigPath = join(tempRoot, 'tsx-tsconfig.json');
    const slotDir = join(selectedHome, 'releases', 'a');
    const fakeWorker = join(slotDir, 'packages', 'cli', 'dist', 'cli.js');

    await mkdir(dirname(fakeWorker), { recursive: true });
    await mkdir(join(selectedHome, 'releases'), { recursive: true });
    await writeWorkspaceTsconfig(tsconfigPath);
    await writeFile(
      join(selectedHome, 'config.json'),
      JSON.stringify({
        name: 'supervisor-home-regression',
        apiPort: 25001,
        listenPort: 0,
        nodeRole: 'core',
      }),
    );
    await symlink('a', join(selectedHome, 'releases', 'current'));
    await writeFile(
      fakeWorker,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const os = require('node:os');",
        "const path = require('node:path');",
        "const home = process.env.DKG_HOME || path.join(os.homedir(), '.dkg');",
        'fs.mkdirSync(home, { recursive: true });',
        "if (process.argv[2] !== 'daemon-worker') process.exit(2);",
        "fs.writeFileSync(path.join(home, 'daemon.pid'), String(process.pid));",
        "fs.writeFileSync(path.join(home, 'api.port'), '25001');",
        'process.exit(0);',
        '',
      ].join('\n'),
    );
    await chmod(fakeWorker, 0o755);

    await runSupervisor(tempRoot, tsconfigPath);

    expect(readFileSync(join(selectedHome, 'api.port'), 'utf8')).toBe('25001');
    expect(readFileSync(join(selectedHome, 'daemon.pid'), 'utf8')).toMatch(/^\d+$/);
    expect(existsSync(join(defaultHome, 'api.port'))).toBe(false);
    expect(existsSync(join(defaultHome, 'daemon.pid'))).toBe(false);
  });
});
