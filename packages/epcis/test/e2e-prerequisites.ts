export function isEpcisLiveNodeRequired(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.DKG_EPCIS_E2E_REQUIRED === '1';
}

export function assertEpcisLiveNodeAvailable(
  required: boolean,
  reachable: boolean,
  detail: string,
): void {
  if (required && !reachable) {
    throw new Error(`EPCIS live-node prerequisites are required: ${detail}`);
  }
}
