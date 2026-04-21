/**
 * Agent profile page — a first-class view of a single agent. Shows:
 *
 *   • Header card with avatar, name, framework badge, operator chain,
 *     peer id, reputation note, join date.
 *   • Activity feed filtered to this agent — all decisions / tasks /
 *     PRs / commits the agent has authored, newest first.
 *   • Per-sub-graph breakdown (decisions N, tasks N, github N …).
 *   • Quick-filter by type so you can narrow to "this agent's proposed
 *     decisions" or "this agent's open tasks".
 *
 * The feed reuses the same ActivityFeed component as the project home,
 * so behaviours stay consistent (status pill, status chip, sub-graph
 * color cue, relative time). Clicking a row opens the entity detail.
 */
import React, { useMemo, useState } from 'react';
import type { MemoryEntity } from '../hooks/useMemoryEntities.js';
import { useAgentsContext, type AgentSummary } from '../hooks/useAgents.js';
import { useProjectProfileContext } from '../hooks/useProjectProfile.js';
import { ActivityFeed } from './ActivityFeed.js';
import { AgentChip } from './AgentChip.js';

const PROV_WAS_ATTRIBUTED_TO = 'http://www.w3.org/ns/prov#wasAttributedTo';

const PRIMARY_TYPES: Array<{ iri: string; label: string }> = [
  { iri: 'http://dkg.io/ontology/decisions/Decision',   label: 'Decisions' },
  { iri: 'http://dkg.io/ontology/tasks/Task',           label: 'Tasks' },
  { iri: 'http://dkg.io/ontology/github/PullRequest',   label: 'Pull Requests' },
  { iri: 'http://dkg.io/ontology/github/Issue',         label: 'Issues' },
  { iri: 'http://dkg.io/ontology/github/Commit',        label: 'Commits' },
];

export interface AgentProfileViewProps {
  agentUri: string;
  entityList: MemoryEntity[];
  onSelectEntity: (uri: string) => void;
  onOpenAgent?: (uri: string) => void;
  onBack: () => void;
}

export const AgentProfileView: React.FC<AgentProfileViewProps> = ({
  agentUri,
  entityList,
  onSelectEntity,
  onOpenAgent,
  onBack,
}) => {
  const agents = useAgentsContext();
  const profile = useProjectProfileContext();
  const agent: AgentSummary | null = agents?.get(agentUri) ?? null;

  // Entities authored by this agent, grouped by primary rdf:type so we
  // can render "Decisions (9) · Tasks (16)" counts + filter buttons.
  const authoredByType = useMemo(() => {
    const out = new Map<string, MemoryEntity[]>();
    for (const e of entityList) {
      const attributed = e.connections.some(c =>
        c.predicate === PROV_WAS_ATTRIBUTED_TO && c.targetUri === agentUri,
      );
      if (!attributed) continue;
      const primary = PRIMARY_TYPES.find(t => e.types.includes(t.iri));
      if (!primary) continue;
      const arr = out.get(primary.iri) ?? [];
      arr.push(e);
      out.set(primary.iri, arr);
    }
    return out;
  }, [entityList, agentUri]);

  const total = useMemo(() => {
    let n = 0;
    for (const arr of authoredByType.values()) n += arr.length;
    return n;
  }, [authoredByType]);

  // Operator chain: AI agent → human operator (if we can resolve it via
  // the loaded agent map). Click to jump to the human's profile.
  const operator = agent?.operatorUri ? agents?.get(agent.operatorUri) ?? null : null;

  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  return (
    <div className="v10-agent-profile">
      <div className="v10-agent-profile-header">
        <button type="button" className="v10-ka-back" onClick={onBack}>← Back</button>
        <div className="v10-agent-profile-head">
          <AgentChip agent={agent ?? undefined} fallbackUri={agentUri} size="lg" showOperator />
          {agent?.reputation && (
            <div className="v10-agent-profile-reputation">
              {agent.reputation}
            </div>
          )}
        </div>
        <div className="v10-agent-profile-meta">
          {agent?.walletAddress && (
            <div className="v10-agent-profile-meta-row">
              <span className="v10-agent-profile-meta-lbl">Wallet</span>
              <span className="v10-agent-profile-meta-val mono v10-agent-profile-wallet" title={agent.walletAddress}>
                {agent.walletAddress}
                <button
                  type="button"
                  className="v10-agent-profile-copy"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard?.writeText(agent.walletAddress!).catch(() => {});
                  }}
                  title="Copy wallet address"
                >
                  ⎘
                </button>
              </span>
            </div>
          )}
          <div className="v10-agent-profile-meta-row">
            <span className="v10-agent-profile-meta-lbl">URI</span>
            <span className="v10-agent-profile-meta-val mono">{agentUri}</span>
          </div>
          {agent?.peerId && (
            <div className="v10-agent-profile-meta-row">
              <span className="v10-agent-profile-meta-lbl">Peer ID</span>
              <span className="v10-agent-profile-meta-val mono">{agent.peerId}</span>
            </div>
          )}
          {operator && (
            <div className="v10-agent-profile-meta-row">
              <span className="v10-agent-profile-meta-lbl">Driven by</span>
              <span className="v10-agent-profile-meta-val">
                <AgentChip agent={operator} size="sm" onOpenAgent={onOpenAgent} />
              </span>
            </div>
          )}
          {agent?.framework && (
            <div className="v10-agent-profile-meta-row">
              <span className="v10-agent-profile-meta-lbl">Framework</span>
              <span className="v10-agent-profile-meta-val mono">{agent.framework}</span>
            </div>
          )}
        </div>
      </div>

      <div className="v10-agent-profile-stats">
        <button
          type="button"
          className={`v10-agent-profile-stat${typeFilter === null ? ' active' : ''}`}
          onClick={() => setTypeFilter(null)}
        >
          <span className="v10-agent-profile-stat-val">{total}</span>
          <span className="v10-agent-profile-stat-lbl">All activity</span>
        </button>
        {PRIMARY_TYPES.map(t => {
          const arr = authoredByType.get(t.iri) ?? [];
          if (arr.length === 0) return null;
          const binding = profile?.forType(t.iri);
          const color = binding?.color ?? '#a855f7';
          return (
            <button
              key={t.iri}
              type="button"
              className={`v10-agent-profile-stat${typeFilter === t.iri ? ' active' : ''}`}
              style={{ '--stat-color': color } as React.CSSProperties}
              onClick={() => setTypeFilter(t.iri)}
            >
              <span className="v10-agent-profile-stat-val">{arr.length}</span>
              <span className="v10-agent-profile-stat-lbl">
                {binding?.label ? binding.label : t.label}
              </span>
            </button>
          );
        })}
      </div>

      <ActivityFeed
        entities={entityList}
        agentUri={agentUri}
        typeIri={typeFilter ?? undefined}
        onSelectEntity={onSelectEntity}
        onOpenAgent={onOpenAgent}
        title={
          <>
            All activity
            {agent && <span className="v10-agent-profile-feed-sub"> · authored by {agent.name}</span>}
          </>
        }
        emptyHint={
          total === 0
            ? `${agent?.name ?? agentUri} hasn't authored anything in this project yet.`
            : 'No entries match the current filter.'
        }
      />
    </div>
  );
};
