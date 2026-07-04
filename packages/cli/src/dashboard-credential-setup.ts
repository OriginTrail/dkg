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
  try {
    const result = await ensureDashboardCredentials({
      path: dashboardCredentialsPath(dkgHome),
    });
    if (result.created) {
      console.log(`${prefix} Dashboard login created:`);
      console.log(`  Username: ${result.username}`);
      console.log(`  Password: ${result.password}`);
      console.log(`  Credential hash: ${result.path}`);
      console.log('  Save this password securely. It will not be shown again.');
      return;
    }

    console.log(`${prefix} Dashboard login: configured (${result.username}) (${result.path})`);
  } catch (err: any) {
    console.warn(`${prefix} WARNING: could not create dashboard login credentials (${err?.message ?? String(err)}).`);
    console.warn(`${prefix} Run "dkg auth dashboard reset-password" after setup to create or repair them.`);
  }
}
