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
import { agentInitials, agentInitialsColor } from '@origintrail-official/dkg-graph-viz/agent-initials';
import { agentColorForUri } from '../hooks/useAgents.js';

// One initials rule for avatars and graph agent nodes, so a legend dot
// matches its graph node. The subpath is dependency-free: it doesn't pull
// the (lazy-loaded) graph renderer into the shell bundle.
export { agentInitials };

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

/** Initials scale with the avatar but stop at the 10px type floor (DESIGN.md · Type). */
const initialsSize = (size: number) => Math.max(11, Math.round(size * 0.45));

export const AgentDot: React.FC<AgentDotProps> = ({ uri, label, color, size = 18, title, className = '' }) => {
  const fill = color ?? agentColorForUri(uri);
  return (
    <span
      className={`v10-agent-dot ${className}`}
      style={{ background: fill, color: agentInitialsColor(fill), width: size, height: size, fontSize: initialsSize(size) }}
      title={title ?? (label ? `${label}\n${uri}` : uri)}
      aria-hidden="true"
      data-agent={uri}
    >
      {agentInitials(label || uri)}
    </span>
  );
};

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
        <span className="v10-agent-dot v10-agent-dot-more" style={{ minWidth: size, height: size, fontSize: initialsSize(size) }} aria-hidden="true">
          +{rest}
        </span>
      )}
    </span>
  );
};
