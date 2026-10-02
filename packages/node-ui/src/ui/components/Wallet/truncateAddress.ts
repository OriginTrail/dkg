// Feature-neutral address truncation. The full address must remain available
// in the surrounding accessible name or tooltip.
export function truncateAddress(address: string, head = 6, tail = 4): string {
  const value = (address ?? '').trim();
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
