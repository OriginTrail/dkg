import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  dashboardCredentialsPath,
  ensureDashboardCredentials,
} from './daemon/dashboard-credentials.js';

export interface DashboardCredentialSetupOptions {
  prefix?: string;
}

export async function ensureDashboardCredentialsForSetup(
  dkgHome: string,
  options: DashboardCredentialSetupOptions = {},
): Promise<void> {
  const prefix = options.prefix ?? '[setup]';
  const credentialPath = dashboardCredentialsPath(dkgHome);
  if (isDashboardAuthExplicitlyDisabled(dkgHome)) {
    console.log(`${prefix} Dashboard login: skipped (API authentication disabled in ${dkgHome})`);
    return;
  }
  try {
    const result = await ensureDashboardCredentials({
      path: credentialPath,
    });
    if (result.created) {
      console.log(`${prefix} Dashboard login created:`);
      console.log(`  Username: ${result.username}`);
      console.log(`  Password: ${result.password}`);
      console.log(`  Credential file: ${result.path}`);
      console.log('  Save this password securely. It will not be shown again.');
      console.log('  Treat this terminal output as secret-bearing.');
      return;
    }

    console.log(`${prefix} Dashboard login: configured (${result.username}) (${result.path})`);
  } catch (err: any) {
    console.warn(`${prefix} WARNING: could not create dashboard login credentials (${err?.message ?? String(err)}).`);
    console.warn(`${prefix} Credential file: ${credentialPath}`);
    console.warn(`${prefix} Run "dkg auth dashboard reset-password" with DKG_HOME=${dkgHome} after setup to create or repair them.`);
  }
}

function isDashboardAuthExplicitlyDisabled(dkgHome: string): boolean {
  const config = readSetupConfig(join(dkgHome, 'config.json')) ??
    readSetupConfig(join(dkgHome, 'config.yaml'));
  return (config as { auth?: { enabled?: unknown } } | null)?.auth?.enabled === false;
}

function readSetupConfig(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    return path.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);
  } catch {
    return null;
  }
}
