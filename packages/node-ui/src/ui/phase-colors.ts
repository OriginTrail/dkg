/**
 * Shared phase → color palette used by Dashboard and Operations.
 *
 * P-1 review: the two views kept independent literal maps and the
 * `chain:writeahead` hex started to drift (#b45309 vs #ea580c), so
 * the same phase rendered inconsistently depending on which view
 * the user happened to be looking at. Co-locate the palette here so
 * a new phase only needs to be declared once.
 */
export const PHASE_COLORS: Record<string, string> = {
  prepare: '#3b82f6',
  'prepare:ensureContextGraph': '#60a5fa',
  'prepare:partition': '#2563eb',
  'prepare:manifest': '#93c5fd',
  'prepare:validate': '#1d4ed8',
  'prepare:merkle': '#7dd3fc',
  store: '#8b5cf6',
  chain: '#f59e0b',
  'chain:sign': '#fbbf24',
  'chain:submit': '#d97706',
  // P-1: boundary around the adapter send/wait call — see
  // packages/publisher/src/dkg-publisher.ts for emission rules.
  'chain:writeahead': '#ea580c',
  'chain:metadata': '#f97316',
  broadcast: '#22c55e',
  decode: '#14b8a6',
  validate: '#2dd4bf',
  'read-shared-memory': '#06b6d4',
  parse: '#3b82f6',
  execute: '#8b5cf6',
  transfer: '#60a5fa',
  verify: '#22c55e',
};

export const PHASE_FALLBACK_COLOR = '#a78bfa';

/**
 * Legend entries surfaced on the Operations view.
 *
 * P-1 review: previously Operations.tsx maintained a hand-written
 * legend map that duplicated the colour half of `PHASE_COLORS` —
 * which meant a change in one needed a matching change in the
 * other (e.g. `chain:writeahead` drift). Derive the legend from
 * `PHASE_COLORS` here so there is exactly one source of truth.
 *
 * The whitelist pins the subset we want to render in the legend
 * (legend space is limited; we don't expose every micro-phase).
 * Colours always come from `PHASE_COLORS` — do NOT hard-code them.
 */
const PHASE_LEGEND_ORDER: Array<{ phase: string; label: string }> = [
  { phase: 'prepare', label: 'Prepare' },
  { phase: 'store', label: 'Store' },
  { phase: 'chain', label: 'Chain' },
  { phase: 'chain:writeahead', label: 'Write-ahead' },
  { phase: 'broadcast', label: 'Broadcast' },
  { phase: 'parse', label: 'Parse' },
  { phase: 'execute', label: 'Execute' },
  { phase: 'transfer', label: 'Transfer' },
  { phase: 'verify', label: 'Verify' },
  { phase: 'decode', label: 'Decode' },
  { phase: 'validate', label: 'Validate' },
];

export const PHASE_LEGEND_ENTRIES: Array<{ phase: string; label: string; color: string }> =
  PHASE_LEGEND_ORDER.map(({ phase, label }) => ({
    phase,
    label,
    color: PHASE_COLORS[phase] ?? PHASE_FALLBACK_COLOR,
  }));
