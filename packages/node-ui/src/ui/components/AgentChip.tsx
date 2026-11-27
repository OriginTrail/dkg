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
 * `AgentTitle` is the same identity as a page title: the page is the agent,
 * so it has no pill and no click-through.
 *
 * Colors come from useAgents (hash(URI) -> HSL hue), so the same agent
 * is the same color in every view. Framework glyph is the tiny icon on
 * the avatar corner: ⦿ claude-code, ◈ openclaw, ⬡ hermes, ● gemini,
 * 👤 human, ◉ generic AI. Click takes you to the agent's entity detail.
 */
import React from 'react';
import { agentInitials, agentInitialsColor } from '@origintrail-official/dkg-graph-viz/agent-initials';
import { useAgentsContext, type AgentSummary } from '../hooks/useAgents.js';
import { Bot, Cpu, Feather, Sparkles, Terminal, User, type LucideIcon } from 'lucide-react';
import { truncateAddress } from '../lib/format.js';

export interface AgentChipProps {
  agent: AgentSummary | null | undefined;
  /** Unknown agent: we still render a "?" chip so the curator notices. */
  fallbackUri?: string;
  size?: 'sm' | 'md' | 'lg';
  showOperator?: boolean;
  onOpenAgent?: (uri: string) => void;
  className?: string;
}

// A Map, so a framework name from the graph only finds an icon registered here. An object
// would hand back inherited properties: "constructor" would find Object, which can't render.
const FRAMEWORK_GLYPH = new Map<string, LucideIcon>([
  ['claude-code', Terminal],
  ['openclaw', Cpu],
  ['hermes', Feather],
  ['gemini', Sparkles],
  ['human', User],
]);

export function framedGlyph(framework: string | undefined, kind: 'human' | 'ai'): LucideIcon {
  return (framework && FRAMEWORK_GLYPH.get(framework)) || (kind === 'human' ? User : Bot);
}

// Compact initials shown inside the avatar disc: the same rule as AgentDot
// and the graph's agent nodes.
const initials = agentInitials;

const agentColorVar = (color: string) => ({ '--agent-color': color }) as React.CSSProperties;

function agentIdentity(agent: AgentSummary | null | undefined, fallbackUri?: string) {
  // With no resolved profile, a peer id or address stands in for the name, shortened so it
  // fits the pill. Short ids stay whole.
  const name = agent?.name
    ?? (fallbackUri ? truncateAddress(fallbackUri.split(':').pop() ?? fallbackUri) : 'unknown');
  const kind = agent?.kind ?? 'ai';
  const framework = agent?.framework;
  return { name, kind, framework, Glyph: framedGlyph(framework, kind), color: agent?.color ?? 'var(--identity-fallback)' };
}

const AgentAvatar: React.FC<{ identity: ReturnType<typeof agentIdentity>; glyphSize: number }> = ({ identity, glyphSize }) => {
  const { name, kind, framework, Glyph, color } = identity;
  return (
    <span className="v10-agent-chip-avatar" style={{ background: color, color: agentInitialsColor(color) }}>
      <span className="v10-agent-chip-initials">{initials(name)}</span>
      <span className="v10-agent-chip-glyph" title={framework ?? kind}><Glyph size={glyphSize} /></span>
    </span>
  );
};

/** Framework and operator, under the name. Renders nothing when neither is known. */
const AgentSubline: React.FC<{ agent: AgentSummary | null | undefined; identity: ReturnType<typeof agentIdentity> }> = ({ agent, identity }) => {
  const { kind, framework } = identity;
  if (!agent?.operatorName && !framework) return null;
  return (
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
  );
};

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
  // N6 polish (item 4) — only truncate the FALLBACK path. Resolved
  // agents already have a human-readable `name`; truncating that
  // would hide useful display info.
  const identity = agentIdentity(agent, fallbackUri);
  const { name, framework, color } = identity;
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
      style={agentColorVar(color)}
      onClick={handle ? (e) => { e.stopPropagation(); handle(); } : undefined}
      onKeyDown={handle ? (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        handle();
      } : undefined}
      title={title}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
    >
      <AgentAvatar identity={identity} glyphSize={size === 'sm' ? 8 : 10} />
      <span className="v10-agent-chip-body">
        <span className="v10-agent-chip-name">{name}</span>
        {size === 'lg' && <AgentSubline agent={agent} identity={identity} />}
        {size === 'md' && showOperator && agent?.operatorName && identity.kind === 'ai' && (
          <span className="v10-agent-chip-sub">
            <span className="v10-agent-chip-op">· {agent.operatorName}</span>
          </span>
        )}
      </span>
    </span>
  );
};

/** An agent as the title of its own page: avatar, the page's h1, then framework and operator. */
export const AgentTitle: React.FC<{ agent: AgentSummary | null | undefined; fallbackUri: string }> = ({ agent, fallbackUri }) => {
  const identity = agentIdentity(agent, fallbackUri);
  return (
    <div className="v10-agent-title" style={agentColorVar(identity.color)}>
      <AgentAvatar identity={identity} glyphSize={10} />
      <div className="v10-agent-title-text">
        <h1 className="ds-page-title" title={identity.name}>{identity.name}</h1>
        <AgentSubline agent={agent} identity={identity} />
      </div>
    </div>
  );
};
