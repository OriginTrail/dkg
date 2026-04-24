/**
 * Prominent on-chain identity block for a Verified Memory entity.
 * Surfaces the three things a curator needs to confirm an anchored
 * KA: its UAL, who owns it, and when it was published (plus who
 * actually fired the publish). Rendered above the Provenance Trail
 * in the KA detail view.
 *
 * Does not render anything while data is loading or missing — so
 * freshly published entities that haven't yet had their meta
 * propagated just show the Provenance Trail instead.
 */
import React from 'react';
import { useAgentsContext } from '../hooks/useAgents.js';
import {
  useVerifiedEntityIdentity,
  agentFromPeerId,
  truncateId,
} from '../hooks/useVerifiedEntityIdentity.js';
import { AgentChip } from './AgentChip.js';

export interface VerifiedIdentityBannerProps {
  contextGraphId: string;
  entityUri: string;
  /** Controls whether the hook fires; caller filters on trust level. */
  enabled: boolean;
}

export const VerifiedIdentityBanner: React.FC<VerifiedIdentityBannerProps> = ({
  contextGraphId,
  entityUri,
  enabled,
}) => {
  const agents = useAgentsContext();
  const identity = useVerifiedEntityIdentity(contextGraphId, entityUri, enabled);

  if (!enabled || identity.loading) return null;
  // If we don't have *anything* useful to show, bail — the Provenance
  // Trail still renders below.
  if (!identity.ual && !identity.owner && !identity.publishedAt) return null;

  const publishedAt = identity.publishedAt ? formatWhen(identity.publishedAt) : null;
  const publisherAgentUri = identity.publisherPeerId && agents
    ? agentFromPeerId(identity.publisherPeerId, agents.agents)
    : null;
  const publisherAgent = publisherAgentUri ? agents?.get(publisherAgentUri) ?? null : null;
  const ownerAgentUri = identity.owner && agents
    ? agentFromPeerId(identity.owner, agents.agents)
    : null;
  const ownerAgent = ownerAgentUri ? agents?.get(ownerAgentUri) ?? null : null;

  const copy = (value: string) => {
    navigator.clipboard?.writeText(value).catch(() => {});
  };

  return (
    <div className="v10-vm-identity">
      <div className="v10-vm-identity-head">
        <span className="v10-vm-identity-glyph">◉</span>
        <span className="v10-vm-identity-title">On-chain identity</span>
        <span className="v10-vm-identity-badge">VERIFIED</span>
      </div>

      {identity.ual && (
        <div className="v10-vm-identity-row">
          <span className="v10-vm-identity-lbl">UAL</span>
          <span className="v10-vm-identity-val mono" title={identity.ual}>
            {identity.ual}
          </span>
          <button
            type="button"
            className="v10-vm-identity-copy"
            onClick={() => copy(identity.ual!)}
            title="Copy UAL"
          >⎘</button>
        </div>
      )}

      {(ownerAgent || identity.owner) && (
        <div className="v10-vm-identity-row">
          <span className="v10-vm-identity-lbl">Owner</span>
          {ownerAgent ? (
            <span className="v10-vm-identity-val">
              <AgentChip agent={ownerAgent} size="sm" />
              {ownerAgent.walletAddress && (
                <span className="v10-vm-identity-wallet mono" title={ownerAgent.walletAddress}>
                  {truncateId(ownerAgent.walletAddress, 6, 4)}
                </span>
              )}
            </span>
          ) : (
            <>
              <span className="v10-vm-identity-val mono" title={identity.owner ?? ''}>
                {truncateId(identity.owner, 8, 6)}
              </span>
              <button
                type="button"
                className="v10-vm-identity-copy"
                onClick={() => copy(identity.owner!)}
                title="Copy owner id"
              >⎘</button>
            </>
          )}
        </div>
      )}

      {publishedAt && (
        <div className="v10-vm-identity-row">
          <span className="v10-vm-identity-lbl">Published</span>
          <span className="v10-vm-identity-val" title={identity.publishedAt ?? ''}>
            {publishedAt}
          </span>
          {identity.opId && (
            <span className="v10-vm-identity-opid mono" title={`Anchor op: ${identity.opId}`}>
              · anchor {identity.opId.slice(0, 10)}
            </span>
          )}
        </div>
      )}

      {(publisherAgent || identity.publisherPeerId) && (
        <div className="v10-vm-identity-row">
          <span className="v10-vm-identity-lbl">By</span>
          {publisherAgent ? (
            <AgentChip agent={publisherAgent} size="sm" />
          ) : (
            <span className="v10-vm-identity-val mono" title={identity.publisherPeerId ?? ''}>
              {truncateId(identity.publisherPeerId, 8, 6)}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

function formatWhen(raw: string): string {
  const d = new Date(raw.replace(/^"|"$/g, ''));
  if (!Number.isFinite(d.getTime())) return raw;
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
