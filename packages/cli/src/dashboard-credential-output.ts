export interface DashboardCredentialCreatedOutput {
  created: true;
  path: string;
  username: string;
  password: string;
}

export interface DashboardCredentialExistingOutput {
  created: false;
  path: string;
  username: string;
}

export interface DashboardCredentialOutputOptions {
  prefix?: string;
}

export function printDashboardCredentialsCreatedForSetup(
  result: DashboardCredentialCreatedOutput,
  options: DashboardCredentialOutputOptions = {},
): void {
  printDashboardCredentialSecretBlock(result, {
    heading: "Dashboard login created:",
    pathLabel: "Credential file:",
    prefix: options.prefix,
    indent: "  ",
  });
}

export function printDashboardCredentialsConfiguredForSetup(
  result: DashboardCredentialExistingOutput,
  options: DashboardCredentialOutputOptions = {},
): void {
  console.log(withPrefix(options.prefix, `Dashboard login: configured (${result.username}) (${result.path})`));
}

export function printDashboardCredentialsSkippedForSetup(
  dkgHome: string,
  options: DashboardCredentialOutputOptions = {},
): void {
  console.log(withPrefix(options.prefix, `Dashboard login: skipped (API authentication disabled in ${dkgHome})`));
}

export function printDashboardCredentialsRepairWarningForSetup(
  dkgHome: string,
  err: unknown,
  options: DashboardCredentialOutputOptions = {},
): void {
  console.warn(withPrefix(
    options.prefix,
    `Could not create dashboard login credentials (${errorMessage(err)}).`,
  ));
  console.warn(withPrefix(
    options.prefix,
    `Run "dkg auth dashboard reset-password" with DKG_HOME=${dkgHome} after setup to create or repair them.`,
  ));
}

export function printDashboardCredentialsCreatedForInit(result: DashboardCredentialCreatedOutput): void {
  printDashboardCredentialSecretBlock(result, {
    heading: "\nDashboard login created:",
    pathLabel: "Credential file:",
    indent: "  ",
  });
}

export function printDashboardPasswordReset(result: DashboardCredentialCreatedOutput): void {
  printDashboardCredentialSecretBlock(result, {
    heading: "Dashboard password reset.",
    pathLabel: "\nCredential file saved to",
  });
  console.log("Existing password-login dashboard sessions will be invalidated on their next request.");
}

function printDashboardCredentialSecretBlock(
  result: DashboardCredentialCreatedOutput,
  options: {
    heading: string;
    pathLabel: string;
    prefix?: string;
    indent?: string;
  },
): void {
  const indent = options.indent ?? "";
  console.log(withPrefix(options.prefix, options.heading));
  console.log(`${indent}Username: ${result.username}`);
  console.log(`${indent}Password: ${result.password}`);
  console.log(`${indent}${options.pathLabel} ${result.path}`);
  printDashboardCredentialSecretWarning(indent);
}

function printDashboardCredentialSecretWarning(indent = ""): void {
  console.log(`${indent}Save this password securely. It will not be shown again.`);
  console.log(`${indent}Treat this terminal output as secret-bearing.`);
}

function withPrefix(prefix: string | undefined, message: string): string {
  return prefix ? `${prefix} ${message}` : message;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
