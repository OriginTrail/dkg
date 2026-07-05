import { useState } from 'react';
import { listPcaAgents } from '../api.js';
import { useTabsStore } from '../stores/tabs.js';

export interface RenewApproveState {
  newAccountId: string;
  seedBulk: string;
  agentsResolved: boolean;
}

export interface RenewalChaining {
  renewOpen: boolean;
  renewChaining: boolean;
  renewApprove: RenewApproveState | null;
  openRenew: () => void;
  closeRenew: () => void;
  onRenewSuccess: (newAccountId: string) => void;
  onManageNew: (newAccountId: string) => void;
  clearRenewApprove: () => void;
}

/**
 * S2b renew (re-mint replacement) chaining for the PCA detail view. After the
 * replacement mint, resolve the OLD account's approved wallets and open the chained
 * Approve modal pre-seeded with them (in 'sponsor' mode; the modal deregisters them
 * from the old account first — expiry doesn't free them, gate-HIGH). `agentsResolved:false`
 * (listPcaAgents failed) stops the next step from promising a pre-filled list it lacks.
 */
export function useRenewalChaining(accountId: string): RenewalChaining {
  const [renewOpen, setRenewOpen] = useState(false);
  // LOW#3 — in-flight while resolving the old agents (prevents a no-feedback gap).
  const [renewChaining, setRenewChaining] = useState(false);
  const [renewApprove, setRenewApprove] = useState<RenewApproveState | null>(null);
  const openTab = useTabsStore((s) => s.openTab);

  const onRenewSuccess = (newAccountId: string) => {
    // LOW#3 — close the create modal IMMEDIATELY so its success button can't be
    // double-clicked into a second chain, and show an in-flight state while we resolve
    // the old agents. `agentsResolved:false` (listPcaAgents failed) stops the next step
    // from promising a pre-filled list it doesn't have.
    setRenewOpen(false);
    setRenewChaining(true);
    listPcaAgents(accountId)
      .then((r) => ({ agents: r.agents, resolved: true }))
      .catch(() => ({ agents: [] as string[], resolved: false }))
      .then(({ agents, resolved }) => {
        setRenewChaining(false);
        setRenewApprove({ newAccountId, seedBulk: agents.join('\n'), agentsResolved: resolved });
      });
  };

  const onManageNew = (newAccountId: string) => {
    setRenewOpen(false);
    openTab({ id: `conviction:${newAccountId}`, label: `PCA #${newAccountId}`, closable: true });
  };

  return {
    renewOpen,
    renewChaining,
    renewApprove,
    openRenew: () => setRenewOpen(true),
    closeRenew: () => setRenewOpen(false),
    onRenewSuccess,
    onManageNew,
    clearRenewApprove: () => setRenewApprove(null),
  };
}
