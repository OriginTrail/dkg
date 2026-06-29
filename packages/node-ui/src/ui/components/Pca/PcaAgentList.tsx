import React from 'react';
import { WalletRow } from './WalletRow.js';

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export interface PcaAgentListProps {
  /** The FULL approved publishing-wallet set (checksummed), from `listPcaAgents` (B3). */
  agents: string[];
  /** This node's operational wallets — the ones in `agents` get a "this node" badge. */
  nodeWallets: string[];
  /** Owner-gated: Remove is enabled only when the node owner is the primary wallet (§8A). */
  ownerIsPrimary: boolean;
  /** Tooltip explaining why Remove is disabled (when not owner-primary). */
  ownerTitle?: string;
  /** The address currently mid remove-confirm (consequence-naming two-step), if any. */
  confirmRemove: string | null;
  onAskRemove: (addr: string) => void;
  onCancelRemove: () => void;
  onConfirmRemove: (addr: string) => void;
  removeBusy: boolean;
  /** Explorer base URL for a per-address link (omitted when the node has none). */
  explorer?: string | null;
}

/**
 * B3 — the FULL list of approved publishing wallets on a PCA (the chain enumerator,
 * via `GET /api/pca/:id/agents`), replacing P0's probe-only "this node's wallets"
 * view + the count-only caveat. Every listed wallet IS approved, so each carries an
 * owner-gated Remove (deregister) reusing the detail view's confirm flow; wallets
 * belonging to this node are badged. The caller renders the empty / loading /
 * graceful-degrade states — this component only renders a non-empty list.
 */
export function PcaAgentList({
  agents,
  nodeWallets,
  ownerIsPrimary,
  ownerTitle,
  confirmRemove,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
  removeBusy,
  explorer,
}: PcaAgentListProps) {
  return (
    <div className="v10-pca-detail-agentlist" data-testid="pca-agent-list">
      {agents.map((addr) => {
        const isNode = nodeWallets.some((w) => eq(w, addr));
        const confirming = eq(confirmRemove ?? undefined, addr);
        return (
          <div className="v10-pca-agent-row" data-testid="pca-agent-row" key={addr}>
            <WalletRow
              address={addr}
              status={isNode ? 'approved · this node' : 'approved'}
              statusTone="success"
              trailing={
                confirming ? (
                  <span className="v10-pca-agent-confirm">
                    <span>Publishes from this wallet will pay the direct cost (and revert if it holds no TRAC). Remove?</span>
                    <button
                      type="button"
                      className="v10-pca-card-btn"
                      data-testid="pca-deregister-btn"
                      onClick={() => onConfirmRemove(addr)}
                      disabled={removeBusy}
                    >
                      {removeBusy ? 'Removing…' : 'Yes, remove'}
                    </button>
                    <button type="button" className="v10-pca-card-btn" onClick={onCancelRemove} disabled={removeBusy}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <>
                    {explorer && (
                      <a
                        className="v10-pca-card-explorer"
                        href={`${explorer}/address/${addr}`}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`View ${addr} on explorer`}
                      >
                        ↗
                      </a>
                    )}
                    <button
                      type="button"
                      className="v10-pca-card-btn"
                      onClick={() => onAskRemove(addr)}
                      disabled={!ownerIsPrimary}
                      title={ownerTitle}
                    >
                      Remove
                    </button>
                  </>
                )
              }
            />
          </div>
        );
      })}
    </div>
  );
}
