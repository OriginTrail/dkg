// @origintrail/dkg-graph-viz/agent-initials — the agent avatar initials rule,
// shared by the graph's agent nodes and the UI's agent avatars so a legend
// dot always matches its graph node. Dependency-free on purpose: importing it
// must not pull the renderer into a caller's bundle.

/**
 * Two-letter initials for an agent avatar: "Claude Code" → "CC",
 * "hermes" → "HE". Shortened addresses ("0x3f2a…9b1c") and DIDs use the
 * first two hex digits after 0x. Empty and separator-only names give "?".
 */
export function agentInitials(label: string): string {
  let t = stripQuotes((label ?? '').trim()).trim(); // labels can arrive as quoted literals
  if (t.startsWith('did:')) t = t.split(':').pop() ?? '';
  if (!t) return '?';
  const hex = t.match(/^0x([0-9a-f]{2})/i);
  if (hex) return hex[1].toUpperCase();
  // Separator-only names ("_", "--") leave no parts: fall back like an empty name.
  const parts = t.split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const QUOTES = new Set(['"', "'", '“', '”']);

/** Trim surrounding quote marks with a linear scan (no backtracking regex). */
function stripQuotes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && QUOTES.has(s[start])) start++;
  while (end > start && QUOTES.has(s[end - 1])) end--;
  return s.slice(start, end);
}
