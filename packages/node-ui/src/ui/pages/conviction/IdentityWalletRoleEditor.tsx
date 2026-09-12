import React from 'react';
import type { IdentityWalletAction } from '../../web3/identityWalletActions.js';
import type { IdentityWalletRole } from './useIdentityWalletManagement.js';

const ROLE_EDITOR_META = {
  operational: {
    title: 'Operational keys',
    label: 'Operational wallet address',
    description: 'These wallets sign publishes. Registering an address does not copy its private key into this node; it must already be present in the node\'s operational wallet pool to participate in rotation.',
    addAction: 'add-operational',
    removeAction: 'remove-operational',
    addLabel: 'Register operational',
    removeLabel: 'Remove operational',
  },
  admin: {
    title: 'Admin keys',
    label: 'Admin wallet address',
    description: 'Admin addresses are stored on-chain as hashes, so they cannot be enumerated back into addresses. Enter the exact address when rotating an old key. The contract never allows the final admin key to be removed.',
    addAction: 'add-admin',
    removeAction: 'remove-admin',
    addLabel: 'Register admin',
    removeLabel: 'Remove admin',
  },
} as const satisfies Record<IdentityWalletRole, {
  title: string;
  label: string;
  description: string;
  addAction: IdentityWalletAction;
  removeAction: IdentityWalletAction;
  addLabel: string;
  removeLabel: string;
}>;

export function IdentityWalletRoleEditor({
  role,
  value,
  writesEnabled,
  finalAdmin,
  onChange,
  onSubmit,
  onRemove,
}: {
  role: IdentityWalletRole;
  value: string;
  writesEnabled: boolean;
  finalAdmin?: boolean;
  onChange: (value: string) => void;
  onSubmit: (action: IdentityWalletAction, address: string) => void;
  onRemove: (role: IdentityWalletRole, address: string) => void;
}) {
  const meta = ROLE_EDITOR_META[role];
  const inputId = `identity-${role}-address`;
  const empty = !value.trim();
  return (
    <div className="v10-identity-wallet-card" data-testid={`${role}-wallet-editor`}>
      <h4>{meta.title}</h4>
      <p>{meta.description}</p>
      <label htmlFor={inputId}>{meta.label}</label>
      <input
        id={inputId}
        className="v10-form-input mono"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="0x…"
        autoComplete="off"
        spellCheck={false}
      />
      <div className="v10-identity-wallet-actions">
        <button
          type="button"
          className="v10-pca-card-btn primary"
          data-testid={meta.addAction}
          onClick={() => onSubmit(meta.addAction, value)}
          disabled={!writesEnabled || empty}
        >
          {meta.addLabel}
        </button>
        <button
          type="button"
          className="v10-pca-card-btn"
          data-testid={meta.removeAction}
          onClick={() => onRemove(role, value)}
          disabled={!writesEnabled || empty || Boolean(finalAdmin)}
        >
          {meta.removeLabel}
        </button>
      </div>
    </div>
  );
}
