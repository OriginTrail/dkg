import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { registerAuthCommand } from '../src/commands/auth.js';
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
    clear: () => {
      calls.length = 0;
    },
    restore: () => {
      console[key] = original;
    },
  };
}

function createAuthProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  registerAuthCommand(program);
  return program;
}

describe('dkg auth dashboard command wiring', () => {
  let tempDir: string;
  let oldDkgHome: string | undefined;
  let logCapture: ReturnType<typeof captureConsole>;
  let warnCapture: ReturnType<typeof captureConsole>;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `dkg-auth-dashboard-${randomBytes(4).toString('hex')}`);
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

  async function runAuthCommand(args: string[]): Promise<void> {
    await createAuthProgram().parseAsync(args, { from: 'user' });
  }

  it('resets dashboard password with username and reports status without printing the password', async () => {
    await runAuthCommand(['auth', 'status']);
    expect(logCapture.text()).toContain('Dashboard login: not configured');
    expect(logCapture.text()).not.toContain('Password:');
    logCapture.clear();

    await runAuthCommand(['auth', 'dashboard', 'reset-password', '--username', 'operator']);

    const resetOutput = logCapture.text();
    expect(resetOutput).toContain('Dashboard password reset.');
    expect(resetOutput).toContain('Username: operator');
    expect(resetOutput).toContain('Credential file saved to');
    expect(resetOutput).toContain('Treat this terminal output as secret-bearing.');
    const password = resetOutput.match(/Password: ([^\n]+)/)?.[1];
    expect(password).toBeTruthy();
    await expect(verifyDashboardCredentials('operator', password!, dashboardCredentialsPath(tempDir)))
      .resolves.toMatchObject({ ok: true, username: 'operator' });
    await expect(readFile(dashboardCredentialsPath(tempDir), 'utf8')).resolves.not.toContain(password!);

    logCapture.clear();
    await runAuthCommand(['auth', 'status']);
    const configuredStatus = logCapture.text();
    expect(configuredStatus).toContain('Dashboard login: configured (operator)');
    expect(configuredStatus).toContain(`Dashboard file:  ${dashboardCredentialsPath(tempDir)}`);
    expect(configuredStatus).not.toContain(password!);
    expect(configuredStatus).not.toContain('Password:');

    await writeFile(dashboardCredentialsPath(tempDir), '{"version":1,"password":"plaintext"}\n');
    logCapture.clear();
    await runAuthCommand(['auth', 'status']);
    const invalidStatus = logCapture.text();
    expect(invalidStatus).toContain('Dashboard login: unavailable (invalid credential file)');
    expect(invalidStatus).toContain(`Dashboard file:  ${dashboardCredentialsPath(tempDir)}`);
    expect(invalidStatus).not.toContain(password!);
    expect(invalidStatus).not.toContain('Password:');
    expect(warnCapture.text()).toBe('');
  });
});
