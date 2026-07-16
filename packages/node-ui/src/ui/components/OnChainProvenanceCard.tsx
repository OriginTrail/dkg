/**
 * OnChainProvenanceCard — a pinned corner card that surfaces the REAL
 * blockchain identity of whichever graph node is currently selected.
 *
 * Mounted as a CHILD of `<RdfGraph>` (the dkg-graph-viz React wrapper), so it
 * reads the clicked node straight from the viz context via `useRdfGraph()` —
 * no screen-coordinate plumbing required. It floats in the graph's bottom-left
 * corner (clear of the library's `NodePanel`, which sits bottom-right) and shows:
 *
 *   • UAL (did:dkg:…), transaction hash (+ block-explorer link), block number,
 *     packed KA id, and author — for entities anchored in Verifiable Memory.
 *   • an honest "not yet on-chain" state for Working / Shared-memory entities.
 *
 * Data comes from `useEntityOnChainReceipt`, which reads the publish receipt
 * the daemon persists at publish time (read-only over /api/query).
 */
import React, { useEffect, useState } from 'react';
import { useRdfGraph } from '@origintrail-official/dkg-graph-viz/react';
import { useEntityOnChainReceipt } from '../hooks/useEntityOnChainReceipt.js';
import { truncateId } from '../hooks/useVerifiedEntityIdentity.js';

export interface OnChainProvenanceCardProps {
  contextGraphId: string;
  /** Active memory layer — tunes the "off-chain" copy. */
  layer?: 'wm' | 'swm' | 'vm';
  /** Block-explorer base URL (from /api/status); links are omitted when absent. */
  explorerUrl?: string;
}

const LAYER_OFFCHAIN_COPY: Record<'wm' | 'swm' | 'vm', string> = {
  wm: 'This entity lives in Working Memory — a private local draft. It gets an on-chain anchor only after it is promoted and published to Verifiable Memory.',
  swm: 'This entity lives in Shared Working Memory. It is not anchored on-chain until it is published to Verifiable Memory.',
  vm: 'No on-chain receipt found for this entity yet. It may still be settling, or it was read back from a pre-cutover graph.',
};

export const OnChainProvenanceCard: React.FC<OnChainProvenanceCardProps> = ({
  contextGraphId,
  layer,
  explorerUrl,
}) => {
  const { selectedNode } = useRdfGraph();
  // Local dismissal: the × hides the card for the CURRENT selection only. Any
  // change of selection (to another node, or cleared to null) resets it via the
  // effect below, so selecting a node away and back always re-opens its card —
  // the dismissal never sticks past the selection it was made for.
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  const nodeId = selectedNode?.id ?? null;
  useEffect(() => {
    setDismissedId(null);
  }, [nodeId]);
  const open = Boolean(nodeId) && nodeId !== dismissedId;
  const receipt = useEntityOnChainReceipt(contextGraphId, nodeId, open);

  if (!open || !selectedNode) return null;

  const copy = (value: string) => {
    navigator.clipboard?.writeText(value).catch(() => {});
  };

  const title = selectedNode.label || selectedNode.id;
  const verified = receipt.status === 'verified';

  return (
    <div
      className={`v10-graph-prov-card${verified ? ' verified' : ''}`}
      role="dialog"
      aria-label="On-chain provenance"
    >
      <div className="v10-graph-prov-head">
        <span className="v10-graph-prov-glyph">{verified ? '◉' : '◌'}</span>
        <span className="v10-graph-prov-title">On-chain provenance</span>
        {verified && <span className="v10-graph-prov-badge">VERIFIED</span>}
        <button
          type="button"
          className="v10-graph-prov-close"
          onClick={() => setDismissedId(nodeId)}
          aria-label="Dismiss"
          title="Dismiss"
        >
          ×
        </button>
      </div>

      <div className="v10-graph-prov-entity" title={selectedNode.id}>{title}</div>

      {receipt.status === 'loading' && (
        <div className="v10-graph-prov-muted">Resolving on-chain identity…</div>
      )}

      {receipt.status === 'error' && (
        <div className="v10-graph-prov-muted">Couldn’t load on-chain identity.</div>
      )}

      {(receipt.status === 'offchain') && (
        <div className="v10-graph-prov-offchain">
          <span className="v10-graph-prov-offchain-tag">Off-chain</span>
          <p>{LAYER_OFFCHAIN_COPY[layer ?? 'vm']}</p>
        </div>
      )}

      {verified && (
        <div className="v10-vm-identity" style={{ margin: 0, background: 'none', border: 'none', padding: 0 }}>
          {receipt.ual && (
            <div className="v10-vm-identity-row">
              <span className="v10-vm-identity-lbl">UAL</span>
              <span className="v10-vm-identity-val mono" title={receipt.ual}>{receipt.ual}</span>
              <button type="button" className="v10-vm-identity-copy" onClick={() => copy(receipt.ual!)} title="Copy UAL">⎘</button>
            </div>
          )}

          {receipt.txHash && (
            <div className="v10-vm-identity-row">
              <span className="v10-vm-identity-lbl">Tx</span>
              {explorerUrl ? (
                <a
                  className="v10-vm-identity-val mono v10-graph-prov-link"
                  href={`${explorerUrl}/tx/${receipt.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={receipt.txHash}
                >
                  {truncateId(receipt.txHash, 10, 8)} ↗
                </a>
              ) : (
                <span className="v10-vm-identity-val mono" title={receipt.txHash}>{truncateId(receipt.txHash, 10, 8)}</span>
              )}
              <button type="button" className="v10-vm-identity-copy" onClick={() => copy(receipt.txHash!)} title="Copy transaction hash">⎘</button>
            </div>
          )}

          {receipt.blockNumber && (
            <div className="v10-vm-identity-row">
              <span className="v10-vm-identity-lbl">Block</span>
              <span className="v10-vm-identity-val mono">{formatBlock(receipt.blockNumber)}</span>
            </div>
          )}

          {receipt.kaId && (
            <div className="v10-vm-identity-row">
              <span className="v10-vm-identity-lbl">KA id</span>
              <span className="v10-vm-identity-val mono" title={receipt.kaId}>{truncateId(receipt.kaId, 8, 8)}</span>
              <button type="button" className="v10-vm-identity-copy" onClick={() => copy(receipt.kaId!)} title="Copy KA id">⎘</button>
            </div>
          )}

          {receipt.author && (
            <div className="v10-vm-identity-row">
              <span className="v10-vm-identity-lbl">Author</span>
              {explorerUrl ? (
                <a
                  className="v10-vm-identity-val mono v10-graph-prov-link"
                  href={`${explorerUrl}/address/${receipt.author}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={receipt.author}
                >
                  {truncateId(receipt.author, 6, 4)} ↗
                </a>
              ) : (
                <span className="v10-vm-identity-val mono" title={receipt.author}>{truncateId(receipt.author, 6, 4)}</span>
              )}
              <button type="button" className="v10-vm-identity-copy" onClick={() => copy(receipt.author!)} title="Copy author address">⎘</button>
            </div>
          )}

          {receipt.finalizedAt && (
            <div className="v10-vm-identity-row">
              <span className="v10-vm-identity-lbl">Finalized</span>
              <span className="v10-vm-identity-val">{formatWhen(receipt.finalizedAt)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function formatBlock(raw: string): string {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n.toLocaleString() : raw;
}

function formatWhen(raw: string): string {
  const d = new Date(raw.replace(/^"|"$/g, ''));
  if (!Number.isFinite(d.getTime())) return raw;
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}
