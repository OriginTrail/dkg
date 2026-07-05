import {
  dashboardCredentialsPath,
  ensureDashboardCredentials,
} from './daemon/dashboard-credentials.js';
import { readPersistedDkgConfig } from './config.js';

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
}

function isDashboardAuthExplicitlyDisabled(dkgHome: string): boolean {
  const config = readPersistedDkgConfig(dkgHome);
  return (config as { auth?: { enabled?: unknown } } | null)?.auth?.enabled === false;
}
