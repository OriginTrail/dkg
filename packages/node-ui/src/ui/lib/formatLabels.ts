/**
 * Label formatting shared across the UI (DESIGN.md · Type: sentence case).
 * Pure functions with no component dependencies, so shell, pages and
 * project views can use them without importing a feature component.
 */

/** "PullRequest" → "Pull request", "CreativeWork" → "Creative work",
 *  "code_review" → "Code review". */
export function humanizeTypeName(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().split(/\s+/);
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase())).join(' ');
}

/** Machine status → sentence case: "in_progress" → "In progress",
 *  "peer-relayed" → "Peer relayed". Leaves the rest of the casing as is. */
export function humanizeStatus(status: string): string {
  const t = status.replace(/[_-]+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}
