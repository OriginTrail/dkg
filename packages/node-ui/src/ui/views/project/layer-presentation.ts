import type { TrustLevel } from '../../hooks/useMemoryEntities.js';

// ─── Shared layer configuration ─────────────────────────────
// Single source of truth for the visual identity of WM / SWM / VM.
export const LAYER_CONFIG: Record<'wm' | 'swm' | 'vm', {
  icon: string;
  color: string;
  title: string;
  desc: string;
  trustLabel: string;
  trustLevel: TrustLevel;
}> = {
  wm: {
    icon: '◇',
    color: '#64748b',
    title: 'Working Memory',
    desc: 'Private agent scratchpad — ephemeral, fast local storage',
    trustLabel: 'Working',
    trustLevel: 'working',
  },
  swm: {
    icon: '◈',
    color: '#f59e0b',
    title: 'Shared Working Memory',
    desc: 'Team workspace — shared proposals, TTL-bounded',
    trustLabel: 'Shared',
    trustLevel: 'shared',
  },
  vm: {
    icon: '◉',
    color: '#22c55e',
    title: 'Verifiable Memory',
    desc: 'Endorsed, published, on-chain knowledge',
    trustLabel: 'Verifiable',
    trustLevel: 'verified',
  },
};

export function layerNoun(
  layer: 'wm' | 'swm' | 'vm' | TrustLevel,
  count: number = 2,
): string {
  const normalized =
    layer === 'working' ? 'wm' :
    layer === 'shared' ? 'swm' :
    layer === 'verified' ? 'vm' :
    layer;
  const plural = count !== 1;
  if (normalized === 'vm') return plural ? 'Knowledge Assets' : 'Knowledge Asset';
  return plural ? 'Entities' : 'Entity';
}

export const VM_TRIPLE_STAT = {
  label: 'Stored triples (data + provenance)',
  tooltip: 'Publication adds provenance to the data. Raw triple counts can change between memory layers without losing entities.',
} as const;
