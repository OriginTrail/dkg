import type {
  DashboardCredentialCreation,
  DashboardCredentialExisting,
} from "./daemon/dashboard-credentials.js";

export interface DashboardCredentialOutputOptions {
  prefix?: string;
}

export function printDashboardCredentialsCreatedForSetup(
  result: DashboardCredentialCreation,
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
  result: DashboardCredentialExisting,
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

export function printDashboardCredentialsCreatedForInit(result: DashboardCredentialCreation): void {
  printDashboardCredentialSecretBlock(result, {
    heading: "Dashboard login created:",
    pathLabel: "Credential file:",
    blankLineBeforeHeading: true,
    indent: "  ",
  });
}

export function printDashboardPasswordReset(result: DashboardCredentialCreation): void {
  printDashboardCredentialSecretBlock(result, {
    heading: "Dashboard password reset.",
    pathLabel: "Credential file saved to",
    blankLineBeforePath: true,
  });
  console.log("Existing password-login dashboard sessions will be invalidated on their next request.");
}

function printDashboardCredentialSecretBlock(
  result: DashboardCredentialCreation,
  options: {
    heading: string;
    pathLabel: string;
    prefix?: string;
    indent?: string;
    blankLineBeforeHeading?: boolean;
    blankLineBeforePath?: boolean;
  },
): void {
  const indent = options.indent ?? "";
  if (options.blankLineBeforeHeading) console.log("");
  console.log(withPrefix(options.prefix, options.heading));
  console.log(`${indent}Username: ${result.username}`);
  console.log(`${indent}Password: ${result.password}`);
  if (options.blankLineBeforePath) console.log("");
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
