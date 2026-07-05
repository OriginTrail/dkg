import {
  dashboardCredentialsPath,
  ensureDashboardCredentials,
} from './daemon/dashboard-credentials.js';
import { readPersistedDkgConfig } from './config.js';
import {
  printDashboardCredentialsConfiguredForSetup,
  printDashboardCredentialsCreatedForSetup,
  printDashboardCredentialsRepairWarningForSetup,
  printDashboardCredentialsSkippedForSetup,
} from './dashboard-credential-output.js';

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
    printDashboardCredentialsSkippedForSetup(dkgHome, { prefix });
    return;
  }
  const result = await ensureDashboardCredentials({
    path: credentialPath,
  });
  if (result.created) {
    printDashboardCredentialsCreatedForSetup(result, { prefix });
    return;
  }

  printDashboardCredentialsConfiguredForSetup(result, { prefix });
}

export async function ensureDashboardCredentialsForSetupBestEffort(
  dkgHome: string,
  options: DashboardCredentialSetupOptions = {},
): Promise<void> {
  const prefix = options.prefix ?? '[setup]';
  try {
    await ensureDashboardCredentialsForSetup(dkgHome, { prefix });
  } catch (err) {
    printDashboardCredentialsRepairWarningForSetup(dkgHome, err, { prefix });
  }
}

function isDashboardAuthExplicitlyDisabled(dkgHome: string): boolean {
  const config = readPersistedDkgConfig(dkgHome);
  return (config as { auth?: { enabled?: unknown } } | null)?.auth?.enabled === false;
}
