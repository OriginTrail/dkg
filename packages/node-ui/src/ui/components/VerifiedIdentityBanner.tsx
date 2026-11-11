/**
 * Prominent on-chain identity block for a Verifiable Memory entity.
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
import { useEntityOnChainReceipt } from '../hooks/useEntityOnChainReceipt.js';
import { useFetch } from '../hooks.js';
import { fetchStatus } from '../api.js';
import { AgentChip } from './AgentChip.js';
import { Badge, LayerGlyph } from './ds/Badge.js';
import { Check, Copy } from 'lucide-react';
import { formatDateTime } from '../lib/format.js';
import { ExternalMark } from './ds/ExternalMark.js';

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
  // Real on-chain receipt (UAL / tx hash / block / KA id). Layers on top of the
  // identity block above, which still supplies owner / publisher attribution.
  const receipt = useEntityOnChainReceipt(contextGraphId, entityUri, enabled);
  const { data: statusData } = useFetch(fetchStatus, [], 60_000);
  const explorerUrl = (statusData as any)?.blockExplorerUrl as string | undefined;
  // Prefer the genuine did:dkg UAL once we have it; the identity hook's `ual`
  // is the synthetic WorkspaceOperation URI used as a stand-in.
  const onChainUal = receipt.ual ?? identity.ual;
  const onChain = receipt.status === 'verified';

  if (!enabled || identity.loading) return null;
  // If we don't have *anything* useful to show, bail — the Provenance
  // Trail still renders below.
  if (!identity.ual && !identity.owner && !identity.publishedAt && !onChain) return null;

  const publishedAt = identity.publishedAt ? formatDateTime(identity.publishedAt) : null;
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
    <div className="v10-vm-identity ds-card">
      <div className="v10-vm-identity-head">
        <span className="v10-vm-identity-glyph"><LayerGlyph layer="vm" /></span>
        <span className="v10-vm-identity-title">On-chain identity</span>
        <Badge tone="vm" size="sm" icon={<Check size={12} />} className="v10-vm-identity-badge">Verified</Badge>
      </div>

      {onChainUal && (
        <div className="v10-vm-identity-row">
          <span className="v10-vm-identity-lbl">UAL</span>
          <span className="v10-vm-identity-val mono" title={onChainUal}>
            {onChainUal}
          </span>
          <button
            type="button"
            className="v10-vm-identity-copy"
            onClick={() => copy(onChainUal)}
            aria-label="Copy UAL" title="Copy UAL"
          ><Copy size={12} /></button>
        </div>
      )}

      {onChain && receipt.txHash && (
        <div className="v10-vm-identity-row">
          <span className="v10-vm-identity-lbl">Tx</span>
          {explorerUrl ? (
            <a
              className="v10-vm-identity-val mono"
              href={`${explorerUrl}/tx/${receipt.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              title={receipt.txHash}
            >
              {truncateId(receipt.txHash, 10, 8)} <ExternalMark />
            </a>
          ) : (
            <span className="v10-vm-identity-val mono" title={receipt.txHash}>
              {truncateId(receipt.txHash, 10, 8)}
            </span>
          )}
          <button
            type="button"
            className="v10-vm-identity-copy"
            onClick={() => copy(receipt.txHash!)}
            aria-label="Copy transaction hash" title="Copy transaction hash"
          ><Copy size={12} /></button>
          {receipt.blockNumber && (
            <span className="v10-vm-identity-opid mono">· block {receipt.blockNumber}</span>
          )}
        </div>
      )}

      {onChain && receipt.kaId && (
        <div className="v10-vm-identity-row">
          <span className="v10-vm-identity-lbl">Knowledge Asset ID</span>
          <span className="v10-vm-identity-val mono" title={receipt.kaId}>
            {truncateId(receipt.kaId, 8, 8)}
          </span>
          <button
            type="button"
            className="v10-vm-identity-copy"
            onClick={() => copy(receipt.kaId!)}
            aria-label="Copy Knowledge Asset ID" title="Copy Knowledge Asset ID"
          ><Copy size={12} /></button>
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
                aria-label="Copy owner id" title="Copy owner id"
              ><Copy size={12} /></button>
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

