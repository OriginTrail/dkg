import React, { useId, useMemo, useState } from 'react';
import { formatWeiToTrac } from './format.js';

// The picker's prop type is intentionally separate from the API's `DesignatableNode`: the picker
// doesn't display `ask`, but the API always returns it (and requires it). This type is a structural
// subset, so the parent can pass the API nodes straight in.
export interface PrimaryNodeOption {
  /** Hex string (`0x…`) — the node's self-reported id; display-only ("unverified"). */
  nodeId: string;
  /** Decimal string — the on-chain identity; the value passed as `primaryNode`. */
  identityId: string;
  /** Wei string. */
  stake: string;
}

const CAP = 50;

/**
 * The always-visible, REQUIRED primary-node picker for Create/Renew. Purely presentational: the
 * parent fetches the staked-node list and owns the value. The picked node receives the account's
 * reward-weight credit while the creator gets only the discount, so the copy is honest that picking
 * a node DONATES that reward weight to it. The node's identityId is the primary identifier (the
 * self-reported nodeId is shown but marked "unverified"); the `ask` column is not displayed.
 * `value`/`onChange` carry the node's `identityId` — the exact `primaryNode` value Create submits.
 */
export function PrimaryNodePicker({
  nodes,
  loading,
  error,
  onRetry,
  value,
  onChange,
  ownIdentityId,
  role,
  required = false,
}: {
  nodes: PrimaryNodeOption[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  /** The selected node's `identityId` ('' = none picked yet). */
  value: string;
  onChange: (identityId: string) => void;
  /** This node's OWN staked identityId, but only when it is present in `nodes` (the parent
   *  cross-checks that the node is actually staked). null/undefined ⇒ edge / not-staked ⇒ no
   *  "this node" affordance. */
  ownIdentityId?: string | null;
  role?: 'core' | 'edge';
  /** The field is mandatory (Create requires a primary node). Drives aria-required + aria-invalid
   *  so assistive tech announces that an unresolved pick blocks submit (a disabled button doesn't). */
  required?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [pasteVal, setPasteVal] = useState('');
  const [pasteErr, setPasteErr] = useState<string | null>(null);
  const listboxId = useId();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter(
      (n) => n.nodeId.toLowerCase().includes(q) || n.identityId.toLowerCase().includes(q),
    );
  }, [nodes, query]);
  const shown = filtered.slice(0, CAP);
  const truncated = filtered.length > shown.length;

  const select = (n: PrimaryNodeOption) => {
    onChange(n.identityId);
    setQuery('');
    setOpen(false);
    setActiveIdx(-1);
    setPasteErr(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActiveIdx((i) => Math.min(i + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true); // Up also opens a closed popup (combobox keyboard convention)
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && activeIdx >= 0 && shown[activeIdx]) {
        e.preventDefault();
        select(shown[activeIdx]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActiveIdx(-1);
    }
  };

  const usePastedId = () => {
    // Strip a leading '#' and match case-INSENSITIVELY (nodeId is a hex string; a pasted
    // '#42' / mixed-case hex must still resolve a valid staked node).
    const raw = pasteVal.trim().replace(/^#/, '');
    if (!raw) return;
    const match = nodes.find((n) => n.identityId === raw || n.nodeId.toLowerCase() === raw.toLowerCase());
    if (!match) {
      setPasteErr('Not a staked sharding-table node.');
      return;
    }
    select(match);
    setPasteVal('');
  };

  const selectedNode = value ? nodes.find((n) => n.identityId === value) : undefined;
  const pickedOwn = value !== '' && ownIdentityId != null && value === ownIdentityId;
  const pickedOther = value !== '' && (ownIdentityId == null || value !== ownIdentityId);
  const isEdgeLike = role === 'edge' || ownIdentityId == null;

  return (
    <div className="v10-pca-node-picker" data-testid="pca-primary-node-picker">
      {/* Confusion-killer — primary node ≠ payer ≠ covered ≠ discount. */}
      <p className="v10-pca-create-hint">
        Primary node = where reward weight goes. It’s separate from which wallets publish and from
        your discount.
      </p>

      {loading ? (
        <p className="v10-pca-create-hint" role="status">Loading staked nodes…</p>
      ) : error ? (
        <div className="v10-modal-warning" role="alert" data-testid="pca-primary-node-error">
          Couldn’t load the staked-node list — a primary node is required to create.{' '}
          <button
            type="button"
            className="v10-pca-card-btn"
            data-testid="pca-primary-node-retry"
            onClick={onRetry}
          >
            Retry
          </button>
          {/* Surface the best-effort default (core fell back to its own id) so it isn't
              invisible while the list is down. */}
          {value !== '' && (
            <p className="v10-pca-create-hint" data-testid="pca-primary-node-error-selected">
              Using node #{value}{pickedOwn ? ' (this node)' : ''} for now — Retry to pick another.
            </p>
          )}
        </div>
      ) : nodes.length === 0 ? (
        <p className="v10-pca-create-hint" role="status">No staked nodes found.</p>
      ) : (
        <>
          <div className="v10-pca-node-picker-combo">
            <input
              type="text"
              role="combobox"
              aria-expanded={open}
              aria-controls={open ? listboxId : undefined}
              aria-autocomplete="list"
              aria-label="Search staked nodes"
              aria-required={required}
              aria-invalid={required && value === ''}
              aria-activedescendant={
                open && activeIdx >= 0 && shown[activeIdx]
                  ? `${listboxId}-opt-${shown[activeIdx].identityId}`
                  : undefined
              }
              className="v10-form-input"
              data-testid="pca-primary-node-search"
              value={query}
              placeholder="Search staked nodes by id…"
              autoComplete="off"
              onFocus={() => setOpen(true)}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
                setActiveIdx(-1);
              }}
              onKeyDown={onKeyDown}
            />
            {open && (
              <ul role="listbox" id={listboxId} aria-label="Staked sharding-table nodes" className="v10-pca-node-picker-list">
                {shown.map((n, i) => {
                  const selected = n.identityId === value;
                  const isOwn = ownIdentityId != null && n.identityId === ownIdentityId;
                  return (
                    <li
                      key={n.identityId}
                      id={`${listboxId}-opt-${n.identityId}`}
                      role="option"
                      aria-selected={selected}
                      data-testid="pca-primary-node-option"
                      className={[
                        'v10-pca-node-picker-option',
                        i === activeIdx ? 'active' : '',
                        selected ? 'selected' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      aria-label={`Node ${n.identityId}, peer ${n.nodeId}, stake ${formatWeiToTrac(n.stake)} TRAC${isOwn ? ', this node' : ''}`}
                      onMouseDown={(e) => {
                        e.preventDefault(); // select before the input blurs
                        select(n);
                      }}
                    >
                      <span className="v10-pca-node-picker-id">#{n.identityId}</span>
                      <span className="v10-pca-node-picker-peer" title={n.nodeId}>
                        {n.nodeId}
                      </span>
                      <span className="badge" title="Node labels are not verified — match on id">
                        unverified
                      </span>
                      <span className="v10-pca-node-picker-stake">
                        {formatWeiToTrac(n.stake)} TRAC staked
                      </span>
                      {isOwn && <span className="v10-pca-node-picker-own">✓ this node</span>}
                    </li>
                  );
                })}
                {truncated && (
                  // A non-option child of the listbox must not be an `option` to assistive tech.
                  <li role="presentation" className="v10-pca-node-picker-more">
                    showing {shown.length} of {filtered.length} — refine your search
                  </li>
                )}
              </ul>
            )}
          </div>

          {/* Paste-an-id convenience (NOT a replacement for the dropdown). */}
          <div className="v10-pca-node-picker-paste">
            <input
              type="text"
              className="v10-form-input"
              data-testid="pca-primary-node-paste"
              value={pasteVal}
              placeholder="…or paste a node id"
              aria-label="Paste a node id"
              autoComplete="off"
              onChange={(e) => {
                setPasteVal(e.target.value);
                setPasteErr(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  usePastedId();
                }
              }}
            />
            <button
              type="button"
              className="v10-pca-card-btn"
              data-testid="pca-primary-node-paste-use"
              onClick={usePastedId}
            >
              Use
            </button>
            {pasteErr && (
              <p className="v10-pca-crux-error" role="alert" data-testid="pca-primary-node-paste-error">
                {pasteErr}
              </p>
            )}
          </div>

          {value !== '' && (
            <p className="v10-pca-create-hint" data-testid="pca-primary-node-selected">
              Selected: node #{value}
              {selectedNode ? ` (${formatWeiToTrac(selectedNode.stake)} TRAC staked)` : ''}
              {pickedOwn && ' — ✓ this node'}
            </p>
          )}

          {/* Honest reward-weight DONATION copy. */}
          {isEdgeLike ? (
            <p className="v10-pca-create-hint" data-testid="pca-primary-node-donation">
              You get the discount; the reward weight from this account accrues to the node you pick —
              not to you.
            </p>
          ) : (
            pickedOther && (
              <p className="v10-pca-create-warn" role="status" data-testid="pca-primary-node-heads-up">
                Reward weight will go to node #{value} instead of this node.
              </p>
            )
          )}
        </>
      )}
    </div>
  );
}
