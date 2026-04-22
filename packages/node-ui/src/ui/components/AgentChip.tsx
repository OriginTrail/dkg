/**
 * Agent attribution pill. Shows up anywhere the UI wants to answer
 * "who wrote this?" at a glance — decision/task list rows, entity
 * detail headers, timeline items, PR cards.
 *
 * Three sizes:
 *   - sm  : compact pill for list rows (avatar + name)
 *   - md  : default pill for timeline / cross-ref links
 *   - lg  : prominent header pill — name + framework + operator subtitle
 *
 * Colors come from useAgents (hash(URI) -> HSL hue), so the same agent
 * is the same color in every view. Framework glyph is the tiny icon on
 * the avatar corner: ⦿ claude-code, ◈ openclaw, ⬡ hermes, ● gemini,
 * 👤 human, ◉ generic AI. Click takes you to the agent's entity detail.
 */
import React from 'react';
import { useAgentsContext, type AgentSummary } from '../hooks/useAgents.js';

export interface AgentChipProps {
  agent: AgentSummary | null | undefined;
  /** Unknown agent: we still render a "?" chip so the curator notices. */
  fallbackUri?: string;
  size?: 'sm' | 'md' | 'lg';
  showOperator?: boolean;
  onOpenAgent?: (uri: string) => void;
  className?: string;
}

const FRAMEWORK_GLYPH: Record<string, string> = {
  'claude-code': '⦿',
  'openclaw':    '◈',
  'hermes':      '⬡',
  'gemini':      '✧',
  'human':       '👤',
};

function framedGlyph(framework: string | undefined, kind: 'human' | 'ai'): string {
  if (framework && FRAMEWORK_GLYPH[framework]) return FRAMEWORK_GLYPH[framework];
  return kind === 'human' ? '👤' : '◉';
}

// Compact initials shown inside the avatar disc for quick scanning.
function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + (parts[1][0] ?? '')).toUpperCase();
}

export const AgentChip: React.FC<AgentChipProps> = ({
  agent,
  fallbackUri,
  size = 'sm',
  showOperator = false,
  onOpenAgent,
  className = '',
}) => {
  // Hooks before any early return — Rules of Hooks.
  // Fall back to the context-provided openAgent handler so clicks work
  // "for free" anywhere inside a ProjectView / AgentProfilePage without
  // having to thread the callback through every wrapping component.
  const ctxAgents = useAgentsContext();
  if (!agent && !fallbackUri) return null;
  const resolvedOpen = onOpenAgent ?? ctxAgents?.openAgent;

  const uri  = agent?.uri ?? fallbackUri!;
  const name = agent?.name ?? (fallbackUri?.split(':').pop() ?? 'unknown');
  const kind = agent?.kind ?? 'ai';
  const framework = agent?.framework;
  const glyph = framedGlyph(framework, kind);
  const color = agent?.color ?? 'hsl(0, 0%, 55%)';
  const title = [
    name,
    framework ? `framework: ${framework}` : null,
    agent?.operatorName ? `operator: ${agent.operatorName}` : null,
    agent?.walletAddress ? `wallet: ${agent.walletAddress}` : null,
    agent?.peerId ? `peer: ${agent.peerId.slice(0, 20)}…` : null,
    agent?.reputation ? `— ${agent.reputation}` : null,
    uri,
  ].filter(Boolean).join('\n');

  const handle = resolvedOpen ? () => resolvedOpen(uri) : undefined;
  const interactive = !!handle;

  return (
    <span
      className={`v10-agent-chip v10-agent-chip-${size}${interactive ? ' interactive' : ''} ${className}`}
      style={{ '--agent-color': color } as React.CSSProperties}
      onClick={handle ? (e) => { e.stopPropagation(); handle(); } : undefined}
      title={title}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
    >
      <span className="v10-agent-chip-avatar" style={{ background: color }}>
        <span className="v10-agent-chip-initials">{initials(name)}</span>
        <span className="v10-agent-chip-glyph" title={framework ?? kind}>{glyph}</span>
      </span>
      <span className="v10-agent-chip-body">
        <span className="v10-agent-chip-name">{name}</span>
        {size === 'lg' && (agent?.operatorName || framework) && (
          <span className="v10-agent-chip-sub">
            {framework && kind === 'ai' && <span className="v10-agent-chip-fw">{framework}</span>}
            {agent?.operatorName && kind === 'ai' && (
              <>
                {framework && <span className="v10-agent-chip-sep">·</span>}
                <span className="v10-agent-chip-op">driven by {agent.operatorName}</span>
              </>
            )}
            {kind === 'human' && <span className="v10-agent-chip-fw">human</span>}
          </span>
        )}
        {size === 'md' && showOperator && agent?.operatorName && kind === 'ai' && (
          <span className="v10-agent-chip-sub">
            <span className="v10-agent-chip-op">· {agent.operatorName}</span>
          </span>
        )}
      </span>
    </span>
  );
};
