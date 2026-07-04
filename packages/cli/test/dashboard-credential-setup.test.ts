import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDashboardCredentialsForSetup } from '../src/dashboard-credential-setup.js';
import {
  dashboardCredentialsPath,
  verifyDashboardCredentials,
} from '../src/daemon/dashboard-credentials.js';

function captureConsole(key: 'log' | 'warn') {
  const calls: unknown[][] = [];
  const original = console[key];
  console[key] = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    calls,
    text: () => calls.map((args) => args.join(' ')).join('\n'),
    restore: () => {
      console[key] = original;
    },
  };
}

describe('dashboard credential setup helper', () => {
  let tempDir: string;
  let logCapture: ReturnType<typeof captureConsole>;
  let warnCapture: ReturnType<typeof captureConsole>;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `dkg-dashboard-credential-setup-${randomBytes(4).toString('hex')}`);
    await mkdir(tempDir, { recursive: true });
    logCapture = captureConsole('log');
    warnCapture = captureConsole('warn');
  });

  afterEach(async () => {
    logCapture.restore();
    warnCapture.restore();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates credentials when missing and prints the generated password once', async () => {
    await ensureDashboardCredentialsForSetup(tempDir);

    const firstOutput = logCapture.text();
    expect(firstOutput).toContain('Dashboard login created');
    const password = firstOutput.match(/Password: ([^\n]+)/)?.[1];
    expect(password).toBeTruthy();
    await expect(verifyDashboardCredentials('node-admin', password!, dashboardCredentialsPath(tempDir)))
      .resolves.toMatchObject({ ok: true });

    logCapture.calls.length = 0;
    await ensureDashboardCredentialsForSetup(tempDir);

    const rerunOutput = logCapture.text();
    expect(rerunOutput).toContain('Dashboard login: configured');
    expect(rerunOutput).not.toContain('Password:');
    expect(rerunOutput).not.toContain(password!);
    expect(await readFile(dashboardCredentialsPath(tempDir), 'utf8')).not.toContain(password!);
  });

  it('warns with reset-password guidance when the credential file is invalid', async () => {
    await writeFile(dashboardCredentialsPath(tempDir), '{"version":1,"password":"plaintext"}\n');

    await ensureDashboardCredentialsForSetup(tempDir);

    const warning = warnCapture.text();
    expect(warning).toContain('could not create dashboard login credentials');
    expect(warning).toContain('dkg auth dashboard reset-password');
  });
});
