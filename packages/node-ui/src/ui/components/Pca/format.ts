// Self-contained address truncation for the PCA components. The app's existing
// truncators are all file-local (`truncateAddress` in Settings.tsx,
// `shortAddr` duplicated across Notifications/Dashboard) and none is exported,
// so the PCA surfaces carry their own — the FULL address is always preserved in
// the accessible name / tooltip, never only the truncated form.
export function truncateAddress(address: string, head = 6, tail = 4): string {
  const a = (address ?? '').trim();
  if (a.length <= head + tail + 1) return a;
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}
