/**
 * The agent avatar on its own: a circle in the agent's colour with its
 * initials. Same shape as the agent chip's avatar and as agent nodes in the
 * graphs, so wherever an agent shows up (a legend, a roster, a notification,
 * a count) it reads as an agent at a glance.
 *
 * Use `AgentChip` when there's room for the name and the click-through;
 * use this where only the mark fits or the name is already on the row.
 */
import React from 'react';
import { agentColorForUri } from '../hooks/useAgents.js';

/** "Claude Code" → "CC", "hermes" → "HE"; addresses and DIDs use the first
 *  two hex digits after 0x ("0x3f2a…9b1c" → "3F"). Same rule as graph-viz's
 *  `agentInitials`, so a legend dot matches its graph node. */
export function agentInitials(label: string): string {
  let t = (label ?? '').trim();
  t = t.replace(/^["'“”]+|["'“”]+$/g, '').trim(); // labels can arrive as quoted literals
  if (!t) return '?';
  if (t.startsWith('did:')) t = t.split(':').pop() ?? t;
  const hex = t.match(/^0x([0-9a-f]{2})/i);
  if (hex) return hex[1].toUpperCase();
  const parts = t.split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + (parts[1][0] ?? '')).toUpperCase();
}

export interface AgentDotProps {
  /** Agent URI / DID; hashed for the colour unless `color` is given. */
  uri: string;
  /** Display name or short address; initials come from it (else from `uri`). */
  label?: string;
  /** Explicit colour (e.g. an attribution palette entry). */
  color?: string;
  size?: number;
  title?: string;
  className?: string;
}

export const AgentDot: React.FC<AgentDotProps> = ({ uri, label, color, size = 18, title, className = '' }) => (
  <span
    className={`v10-agent-dot ${className}`}
    style={{ background: color ?? agentColorForUri(uri), width: size, height: size, fontSize: Math.round(size * 0.45) }}
    title={title ?? (label ? `${label}\n${uri}` : uri)}
    aria-hidden="true"
    data-agent={uri}
  >
    {agentInitials(label || uri)}
  </span>
);

/** Overlapping avatars for a set of agents, with "+N" for the rest. */
export const AgentDotStack: React.FC<{
  agents: Array<{ uri: string; label?: string; color?: string }>;
  max?: number;
  size?: number;
  label?: string;
}> = ({ agents, max = 6, size = 20, label }) => {
  if (agents.length === 0) return null;
  const shown = agents.slice(0, max);
  const rest = agents.length - shown.length;
  return (
    <span className="v10-agent-dot-stack" role="img" aria-label={label ?? `${agents.length} agent${agents.length === 1 ? '' : 's'}`}>
      {shown.map(a => <AgentDot key={a.uri} uri={a.uri} label={a.label} color={a.color} size={size} />)}
      {rest > 0 && (
        <span className="v10-agent-dot v10-agent-dot-more" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
          +{rest}
        </span>
      )}
    </span>
  );
};
