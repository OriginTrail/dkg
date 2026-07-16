import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('EPCIS e2e runner contract', () => {
  it('fails the real test:e2e command when the configured node is unreachable', () => {
    const pnpmExecPath = process.env.npm_execpath;
    expect(pnpmExecPath).toBeTruthy();

    const result = spawnSync(
      process.execPath,
      [pnpmExecPath!, 'run', 'test:e2e'],
      {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, DKG_API_PORT: '1' },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('EPCIS live-node prerequisites are required');
    expect(output).toContain('Test Files  1 failed');
  }, 35_000);
});
