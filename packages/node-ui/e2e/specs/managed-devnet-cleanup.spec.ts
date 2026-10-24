import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupManagedDevnet } from '../global-teardown.js';

test('cleans interrupted-bootstrap children while preserving pre-existing nodes and chain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-owned-cleanup-'));
  const children = Array.from({ length: 5 }, (_, index) => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', env: { ...process.env, DKG_HOME: join(dir, index === 3 ? 'node2' : index === 4 ? 'node20' : `unrelated${index}`) },
  }));
  try {
    await Promise.all(children.map(child => once(child, 'spawn')));
    for (let index = 0; index < 2; index++) {
      mkdirSync(join(dir, `node${index + 1}`));
      writeFileSync(join(dir, `node${index + 1}`, 'devnet.pid'), String(children[index]!.pid));
    }
    writeFileSync(join(dir, 'hardhat.pid'), String(children[2]!.pid));
    // The worker has no daemon.pid yet: cancellation raced its initialization.
    // node20 deliberately shares the node2 prefix and must remain untouched.
    writeFileSync(join(dir, '.playwright-managed'), JSON.stringify({ numNodes: '2', preExistingNodes: [1], preExistingHardhat: true }));
    const stopped = Promise.all([once(children[1]!, 'exit'), once(children[3]!, 'exit')]);
    await cleanupManagedDevnet(dir);
    expect(() => process.kill(children[3]!.pid!, 0), 'owned daemon worker must also exit').toThrow();
    await stopped;
    expect(() => process.kill(children[0]!.pid!, 0)).not.toThrow();
    expect(() => process.kill(children[2]!.pid!, 0)).not.toThrow();
    expect(() => process.kill(children[4]!.pid!, 0)).not.toThrow();
    expect(existsSync(join(dir, '.playwright-managed'))).toBe(false);
    await cleanupManagedDevnet(dir); // repeated always-cleanup is harmless
    expect(() => process.kill(children[0]!.pid!, 0)).not.toThrow();
  } finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const stopped = once(child, 'exit'); child.kill(); await stopped;
    }));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stops an owned chain from an interrupted boot with a legacy colorized PID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-owned-chain-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    writeFileSync(join(dir, 'hardhat.pid'), `\u001b[33m${child.pid}\u001b[39m\n`);
    writeFileSync(join(dir, '.playwright-managed'), JSON.stringify({ numNodes: '4', preExistingNodes: [], preExistingHardhat: false }));
    const stopped = once(child, 'exit');
    await cleanupManagedDevnet(dir);
    await stopped;
    expect(existsSync(join(dir, 'hardhat.pid'))).toBe(false);
    expect(existsSync(join(dir, '.playwright-managed'))).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit'); child.kill(); await stopped;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
