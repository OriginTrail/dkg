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

/**
 * The colour for initials on an agent's fill: black or white, whichever reads
 * better. One of the two always clears 4.5:1, whatever the fill. Returns
 * undefined for a fill it can't read, such as a CSS variable.
 */
export function agentInitialsColor(fill: string): '#000000' | '#ffffff' | undefined {
  const rgb = parseColor(fill);
  if (!rgb) return undefined;
  const [r, g, b] = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff';
}

/** #rgb, #rrggbb or hsl() as sRGB channels from 0 to 1. */
function parseColor(fill: string): [number, number, number] | undefined {
  const value = (fill ?? '').trim();
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
  }
  const hsl = value.match(/^hsl\(\s*([\d.]+)[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*\)$/i);
  if (!hsl) return undefined;
  const h = Number(hsl[1]);
  const s = Number(hsl[2]) / 100;
  const l = Number(hsl[3]) / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
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
