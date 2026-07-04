import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DASHBOARD_CREDENTIALS_FILENAME,
  DEFAULT_DASHBOARD_USERNAME,
  ensureDashboardCredentials,
  readDashboardCredentialFingerprintSync,
  readDashboardCredentialSummary,
  resetDashboardPassword,
  verifyDashboardCredentials,
} from '../src/daemon/dashboard-credentials.js';

describe('dashboard credentials', () => {
  let tempDir: string;
  let credentialPath: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `dkg-dashboard-credentials-${randomBytes(4).toString('hex')}`);
    await mkdir(tempDir, { recursive: true });
    credentialPath = join(tempDir, DASHBOARD_CREDENTIALS_FILENAME);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates a hash-only credential file with owner-only permissions', async () => {
    const created = await ensureDashboardCredentials({
      path: credentialPath,
      password: 'correct horse battery staple',
    });

    expect(created).toMatchObject({
      created: true,
      path: credentialPath,
      username: DEFAULT_DASHBOARD_USERNAME,
    });
    const raw = await readFile(credentialPath, 'utf8');
    expect(raw).not.toContain('correct horse battery staple');
    expect(JSON.parse(raw)).toMatchObject({
      version: 1,
      username: DEFAULT_DASHBOARD_USERNAME,
      password: { algorithm: 'scrypt' },
    });
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
  });

  it('verifies the correct password and rejects wrong credentials', async () => {
    await ensureDashboardCredentials({
      path: credentialPath,
      username: 'node-admin',
      password: 'dashboard-password',
    });

    await expect(verifyDashboardCredentials('node-admin', 'dashboard-password', credentialPath))
      .resolves.toMatchObject({ ok: true, username: 'node-admin' });
    await expect(verifyDashboardCredentials('node-admin', 'wrong-password', credentialPath))
      .resolves.toEqual({ ok: false, reason: 'mismatch' });
    await expect(verifyDashboardCredentials('other-user', 'dashboard-password', credentialPath))
      .resolves.toEqual({ ok: false, reason: 'mismatch' });
  });

  it('does not overwrite an existing credential during ensure', async () => {
    const first = await ensureDashboardCredentials({
      path: credentialPath,
      username: 'operator',
      password: 'first-password',
    });
    const fingerprint = readDashboardCredentialFingerprintSync(credentialPath);

    const second = await ensureDashboardCredentials({
      path: credentialPath,
      username: 'other',
      password: 'second-password',
    });

    expect(first.created).toBe(true);
    expect(second).toEqual({
      created: false,
      path: credentialPath,
      username: 'operator',
    });
    expect(readDashboardCredentialFingerprintSync(credentialPath)).toBe(fingerprint);
    await expect(verifyDashboardCredentials('operator', 'first-password', credentialPath))
      .resolves.toMatchObject({ ok: true });
  });

  it('resets the password and changes the credential fingerprint', async () => {
    await ensureDashboardCredentials({
      path: credentialPath,
      username: 'operator',
      password: 'old-password',
    });
    const oldFingerprint = readDashboardCredentialFingerprintSync(credentialPath);

    const reset = await resetDashboardPassword({
      path: credentialPath,
      password: 'new-password',
    });

    expect(reset).toMatchObject({
      created: true,
      username: 'operator',
      path: credentialPath,
    });
    expect(readDashboardCredentialFingerprintSync(credentialPath)).not.toBe(oldFingerprint);
    await expect(verifyDashboardCredentials('operator', 'old-password', credentialPath))
      .resolves.toEqual({ ok: false, reason: 'mismatch' });
    await expect(verifyDashboardCredentials('operator', 'new-password', credentialPath))
      .resolves.toMatchObject({ ok: true });
  });

  it('reports missing and invalid credential summaries without exposing secrets', async () => {
    await expect(readDashboardCredentialSummary(credentialPath)).resolves.toEqual({
      path: credentialPath,
      exists: false,
    });

    await writeFile(credentialPath, '{"version":1,"password":"plaintext"}\n', { mode: 0o600 });

    await expect(readDashboardCredentialSummary(credentialPath)).resolves.toEqual({
      path: credentialPath,
      exists: true,
      invalid: true,
    });
    await expect(verifyDashboardCredentials('node-admin', 'anything', credentialPath))
      .resolves.toEqual({ ok: false, reason: 'invalid' });

    await expect(resetDashboardPassword({
      path: credentialPath,
      password: 'recovered-password',
    })).resolves.toMatchObject({
      created: true,
      username: DEFAULT_DASHBOARD_USERNAME,
      path: credentialPath,
    });
    await expect(verifyDashboardCredentials(DEFAULT_DASHBOARD_USERNAME, 'recovered-password', credentialPath))
      .resolves.toMatchObject({ ok: true });
  });
});
