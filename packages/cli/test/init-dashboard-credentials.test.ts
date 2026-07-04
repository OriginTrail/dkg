import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureDashboardCredentialsForInit,
  printCreatedDashboardCredentialsForInit,
} from '../src/commands/init.js';
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

describe('dkg init dashboard credential creation', () => {
  let tempDir: string;
  let oldDkgHome: string | undefined;
  let logCapture: ReturnType<typeof captureConsole>;
  let warnCapture: ReturnType<typeof captureConsole>;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `dkg-init-dashboard-${randomBytes(4).toString('hex')}`);
    await mkdir(tempDir, { recursive: true });
    oldDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempDir;
    logCapture = captureConsole('log');
    warnCapture = captureConsole('warn');
  });

  afterEach(async () => {
    logCapture.restore();
    warnCapture.restore();
    if (oldDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = oldDkgHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates dashboard credentials once and does not reprint the password on rerun', async () => {
    const first = await ensureDashboardCredentialsForInit(true);
    printCreatedDashboardCredentialsForInit(first);

    expect(first?.created).toBe(true);
    const output = logCapture.text();
    expect(output).toContain('Dashboard login created');
    expect(output).toContain('Password:');
    expect(output).toContain('Credential file:');
    expect(output).toContain('Treat this terminal output as secret-bearing.');
    const password = output.match(/Password: ([^\n]+)/)?.[1];
    expect(password).toBeTruthy();
    await expect(verifyDashboardCredentials('node-admin', password!, dashboardCredentialsPath(tempDir)))
      .resolves.toMatchObject({ ok: true });
    await expect(readFile(dashboardCredentialsPath(tempDir), 'utf8')).resolves.not.toContain(password!);

    logCapture.calls.length = 0;
    const second = await ensureDashboardCredentialsForInit(true);
    printCreatedDashboardCredentialsForInit(second);

    expect(second).toMatchObject({
      created: false,
      username: 'node-admin',
      path: dashboardCredentialsPath(tempDir),
    });
    expect(logCapture.text()).not.toContain('Password:');
    expect(warnCapture.text()).toBe('');
  });

  it('does not create dashboard credentials when init disables API auth', async () => {
    const result = await ensureDashboardCredentialsForInit(false);
    printCreatedDashboardCredentialsForInit(result);

    expect(result).toBeNull();
    expect(logCapture.text()).toBe('');
    await expect(readFile(dashboardCredentialsPath(tempDir), 'utf8')).rejects.toThrow();
  });
});
