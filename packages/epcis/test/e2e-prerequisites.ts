export function assertEpcisLiveNodeAvailable(
  required: boolean,
  reachable: boolean,
  detail: string,
): void {
  if (required && !reachable) {
    throw new Error(`EPCIS live-node prerequisites are required: ${detail}`);
  }
}
