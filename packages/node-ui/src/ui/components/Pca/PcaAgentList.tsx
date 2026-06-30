import React from 'react';
import { WalletRow } from './WalletRow.js';

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export interface PcaAgentListProps {
  /** The FULL approved publishing-wallet set (checksummed), from `listPcaAgents` (B3). */
  agents: string[];
  /** This node's operational wallets — the ones in `agents` get a "this node" badge. */
  nodeWallets: string[];
  /** Owner-gated: Remove is enabled when this PCA is daemon-owned or connected-wallet-owned. */
  ownerIsPrimary: boolean;
  /** Tooltip explaining why Remove is disabled (when owner writes are unavailable). */
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
                    {/* D (#1357) — when the wallet belongs to THIS node, removing it degrades
                        this node's OWN publishes; name that explicitly vs a generic external wallet. */}
                    <span>
                      {isNode
                        ? 'This is one of this node’s own signing wallets — its publishes will pay the direct cost (and revert if it holds no TRAC). Remove?'
                        : 'Publishes from this wallet will pay the direct cost (and revert if it holds no TRAC). Remove?'}
                    </span>
                    <button
                      type="button"
                      className="v10-pca-card-btn"
                      data-testid="pca-deregister-btn"
                      aria-label={`Confirm removing ${addr}`}
                      onClick={() => onConfirmRemove(addr)}
                      disabled={removeBusy}
                    >
                      {removeBusy ? 'Removing…' : 'Yes, remove'}
                    </button>
                    <button type="button" className="v10-pca-card-btn" aria-label={`Cancel removing ${addr}`} onClick={onCancelRemove} disabled={removeBusy}>
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
                      aria-label={`Remove ${addr}`}
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
