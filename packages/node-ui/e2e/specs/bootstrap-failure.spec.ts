import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupManagedDevnet } from '../global-teardown.js';

const bootstrap = fileURLToPath(new URL('../bootstrap-devnet.ts', import.meta.url));
const root = resolve(dirname(bootstrap), '../../..');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill(); await exited;
}

for (const mode of ['launch-failure', 'readiness-failure', 'cancelled'] as const) {
  test(`bootstrap retains its own ownership record after ${mode}`, async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'dkg-bootstrap-failure-'));
    const dir = join(sandbox, '.devnet');
    // Execute byte-for-byte production sources in an isolated repository layout.
    // No production configuration switch or ownership test double is needed.
    const isolatedBootstrap = join(sandbox, 'packages/node-ui/e2e/bootstrap-devnet.ts');
    mkdirSync(dirname(isolatedBootstrap), { recursive: true });
    mkdirSync(join(dirname(isolatedBootstrap), 'helpers'));
    writeFileSync(join(sandbox, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(isolatedBootstrap, readFileSync(bootstrap));
    writeFileSync(join(dirname(isolatedBootstrap), 'helpers/devnet.ts'), readFileSync(new URL('../helpers/devnet.ts', import.meta.url)));
    const node1 = join(dir, 'node1');
    mkdirSync(node1, { recursive: true });
    mkdirSync(join(dir, 'node2'));
    mkdirSync(join(dir, 'bin'));
    // A real pre-existing TCP listener is discovered by bootstrap's normal probe.
    const existing = spawn(process.execPath, ['-e', `
      const net = require('node:net'), fs = require('node:fs');
      const server = net.createServer(socket => socket.end());
      server.listen(0, '127.0.0.1', () => {
        fs.writeFileSync(process.env.PORT_FILE, String(server.address().port));
        process.send('ready');
      });
    `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, PORT_FILE: join(node1, 'api.port') } });
    const chain = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    let runner: ChildProcess | undefined;
    let output = '';
    try {
      await Promise.all([once(existing, 'message'), once(chain, 'spawn')]);
      writeFileSync(join(node1, 'devnet.pid'), String(existing.pid));
      writeFileSync(join(dir, 'hardhat.pid'), String(chain.pid));
      // Substitute only the external launcher, not bootstrap orchestration or
      // ownership bookkeeping. It starts real isolated children without an EVM.
      writeFileSync(join(dir, 'bin/bash'), `#!/usr/bin/env node
        import fs from 'node:fs';
        import path from 'node:path';
        import { spawn } from 'node:child_process';
        if (process.argv[3] !== 'start') throw new Error('unexpected launcher command');
        const dir = process.env.DEVNET_DIR, marker = path.join(dir, '.playwright-managed');
        fs.writeFileSync(path.join(dir, 'marker-at-launch.json'), fs.existsSync(marker) ? fs.readFileSync(marker) : 'null');
        if (process.env.FAILURE_MODE === 'launch-failure') process.exit(9);
        const nodeDir = path.join(dir, 'node2');
        const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: true, stdio: 'ignore', env: { ...process.env, DKG_HOME: nodeDir },
        });
        fs.writeFileSync(path.join(nodeDir, 'daemon.pid'), String(worker.pid));
        worker.unref();
        if (process.env.FAILURE_MODE === 'cancelled') {
          fs.writeFileSync(path.join(nodeDir, 'devnet.pid'), String(process.pid));
          setInterval(() => {}, 1000);
        }
        console.log('controlled launch complete');
      `, { mode: 0o755 });
      runner = spawn(process.execPath, ['--import', 'tsx', isolatedBootstrap], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env, PATH: `${join(dir, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`,
        DEVNET_DIR: dir, DEVNET_NODE: '2', PLAYWRIGHT_DEVNET_NUM_NODES: '2', PLAYWRIGHT_DEVNET_TIMEOUT_MS: '100', FAILURE_MODE: mode,
      } });
      runner.stdout!.on('data', data => { output += data; });
      runner.stderr!.on('data', data => { output += data; });
      const exited = once(runner, 'exit');
      if (mode === 'cancelled') {
        await expect.poll(() => output, { timeout: 10_000 }).toContain('controlled launch complete');
        runner.kill('SIGTERM');
        expect((await exited)[1]).toBe('SIGTERM');
      } else {
        expect((await exited)[0], output).toBe(1);
        expect(output).toContain('devnet bootstrap failed');
      }
      const marker = JSON.parse(readFileSync(join(dir, '.playwright-managed'), 'utf8'));
      expect(marker).toMatchObject({ nodeNum: '2', numNodes: '2', preExistingNodes: [1], preExistingHardhat: true });
      expect(JSON.parse(readFileSync(join(dir, 'marker-at-launch.json'), 'utf8'))).toEqual(marker);
      const owned = ['daemon.pid', 'devnet.pid'].map(name => join(dir, 'node2', name))
        .filter(file => existsSync(file)).map(file => Number(readFileSync(file, 'utf8')));
      if (mode !== 'launch-failure') expect(owned.length).toBeGreaterThan(0);
      for (const pid of owned) expect(alive(pid)).toBe(true);
      await cleanupManagedDevnet(dir);
      for (const pid of owned) await expect.poll(() => alive(pid)).toBe(false);
      expect(alive(existing.pid!)).toBe(true);
      expect(alive(chain.pid!)).toBe(true);
      expect(existsSync(join(dir, '.playwright-managed'))).toBe(false);
    } finally {
      if (runner) await stop(runner);
      // Clean controlled children even if a deliberately broken marker fails assertions.
      for (const name of ['daemon.pid', 'devnet.pid']) {
        try { process.kill(Number(readFileSync(join(dir, 'node2', name), 'utf8')), 'SIGKILL'); } catch { /* absent/exited */ }
      }
      await Promise.all([stop(existing), stop(chain)]);
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
}
