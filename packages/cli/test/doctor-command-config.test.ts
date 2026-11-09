import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

describe('registered doctor command with a rejected node config', () => {
  it.each([
    { file: 'config.json', content: '{ malformed' },
    { file: 'config.yaml', content: 'nodeRole: [invalid' },
    { file: 'config.json', content: JSON.stringify({ core: { authorityIndex: 1 } }) },
  ])('emits a config-sanity report and exit 2 for $file: $content', async ({ file, content }) => {
    const home = await mkdtemp(join(tmpdir(), 'dkg-doctor-config-'));
    try {
      await writeFile(join(home, file), content);
      const result = await new Promise<{ code: string | number | undefined; stdout: string; stderr: string }>((resolve) => {
        execFile(process.execPath, [cli, 'doctor', '--json', '--no-orphan-scan'], {
          env: { ...process.env, DKG_HOME: home }, timeout: 30_000, encoding: 'utf8',
        }, (error, stdout, stderr) => resolve({ code: error?.code, stdout, stderr }));
      });
      expect(result.code, result.stderr).toBe(2);
      const report = JSON.parse(result.stdout);
      expect(report.exitCode).toBe(2);
      expect(report.findings).toContainEqual(expect.objectContaining({ check: 'config-sanity', severity: 'error' }));
      expect(result.stderr).toContain('the node config did not load');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 40_000);
});
