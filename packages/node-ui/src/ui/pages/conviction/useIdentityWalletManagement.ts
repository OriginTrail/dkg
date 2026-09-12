import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { getAddress, type Address, type Hex } from 'viem';
import { fetchOperationalWallets, type OperationalWalletSnapshot } from '../../api.js';
import { useFetch } from '../../hooks.js';
import { eqAddress } from '../../pca/address.js';
import { isWrongNetwork, useWalletStore } from '../../stores/wallet.js';
import { publicClientFor } from '../../web3/clients.js';
import {
  IdentityWalletActionError,
  identityWalletActionSubmitter,
  readIdentityWalletSummary,
  type IdentityWalletAction,
  type IdentityWalletActionDeps,
  type IdentityWalletSummary,
} from '../../web3/identityWalletActions.js';
import { describeWalletTxError, WalletReceiptWaitError, WalletTxStepError } from '../../web3/walletTxError.js';

export type IdentityWalletRole = 'operational' | 'admin';

export interface PendingIdentityWalletRemoval {
  role: IdentityWalletRole;
  address: Address;
}

export interface CompletedIdentityWalletAction {
  action: IdentityWalletAction;
  address: Address;
  txHash: Hex;
  confirmed: boolean;
}

export const IDENTITY_WALLET_ACTION_META = {
  'add-operational': { role: 'operational', verb: 'add', label: 'Operational wallet registered' },
  'remove-operational': { role: 'operational', verb: 'remove', label: 'Operational wallet removed' },
  'add-admin': { role: 'admin', verb: 'add', label: 'Admin wallet registered' },
  'remove-admin': { role: 'admin', verb: 'remove', label: 'Admin wallet removed' },
} as const satisfies Record<IdentityWalletAction, {
  role: IdentityWalletRole;
  verb: 'add' | 'remove';
  label: string;
}>;

export type IdentityWalletTransactionState =
  | { status: 'idle' }
  | { status: 'signing'; action: IdentityWalletAction; address: Address }
  | { status: 'submitted'; action: IdentityWalletAction; address: Address; txHash: Hex }
  | { status: 'succeeded'; completed: CompletedIdentityWalletAction }
  | { status: 'failed'; message: string; completed?: CompletedIdentityWalletAction };

interface ManagementState {
  inputs: Record<IdentityWalletRole, string>;
  removal: PendingIdentityWalletRemoval | null;
  transaction: IdentityWalletTransactionState;
}

type ManagementEvent =
  | { type: 'input'; role: IdentityWalletRole; value: string }
  | { type: 'request-removal'; removal: PendingIdentityWalletRemoval }
  | { type: 'cancel-removal' }
  | { type: 'signing'; action: IdentityWalletAction; address: Address }
  | { type: 'submitted'; action: IdentityWalletAction; address: Address; txHash: Hex }
  | { type: 'succeeded'; completed: CompletedIdentityWalletAction }
  | { type: 'failed'; message: string; completed?: CompletedIdentityWalletAction };

const initialState: ManagementState = {
  inputs: { operational: '', admin: '' },
  removal: null,
  transaction: { status: 'idle' },
};

function managementReducer(state: ManagementState, event: ManagementEvent): ManagementState {
  switch (event.type) {
    case 'input':
      return { ...state, inputs: { ...state.inputs, [event.role]: event.value } };
    case 'request-removal':
      return { ...state, removal: event.removal, transaction: { status: 'idle' } };
    case 'cancel-removal':
      return { ...state, removal: null };
    case 'signing':
      return { ...state, transaction: { status: 'signing', action: event.action, address: event.address } };
    case 'submitted':
      return {
        ...state,
        transaction: { status: 'submitted', action: event.action, address: event.address, txHash: event.txHash },
      };
    case 'succeeded': {
      const meta = IDENTITY_WALLET_ACTION_META[event.completed.action];
      return {
        ...state,
        inputs: meta.verb === 'add' ? { ...state.inputs, [meta.role]: '' } : state.inputs,
        removal: null,
        transaction: { status: 'succeeded', completed: event.completed },
      };
    }
    case 'failed':
      return { ...state, transaction: { status: 'failed', message: event.message, completed: event.completed } };
  }
}

function parseAddress(value: string, label: string): Address {
  try {
    return getAddress(value.trim()) as Address;
  } catch {
    throw new IdentityWalletActionError(`${label} must be a valid EVM address.`);
  }
}

function actionError(err: unknown): string {
  if (err instanceof IdentityWalletActionError) return err.message;
  const info = describeWalletTxError(err, 'action');
  if (info.kind === 'rejected') return 'You rejected the transaction. No identity key was changed.';
  return info.message;
}

function uncertainTransactionHash(err: unknown): Hex | undefined {
  if (err instanceof WalletReceiptWaitError) return err.txHash;
  if (err instanceof WalletTxStepError && err.cause instanceof WalletReceiptWaitError) {
    return err.cause.txHash;
  }
  return undefined;
}

async function dispatchIdentityWalletAction(
  deps: IdentityWalletActionDeps,
  action: IdentityWalletAction,
  identityId: string,
  address: Address,
  primaryAddress: string | null,
) {
  const submitter = identityWalletActionSubmitter(deps);
  switch (action) {
    case 'add-operational': return submitter.addOperational(identityId, address);
    case 'remove-operational': return submitter.removeOperational(identityId, address, primaryAddress);
    case 'add-admin': return submitter.addAdmin(identityId, address);
    case 'remove-admin': return submitter.removeAdmin(identityId, address);
  }
}

export function useIdentityWalletManagement() {
  const { data, loading, error: loadError, refresh } = useFetch(fetchOperationalWallets, [], 0);
  const bootstrap = useWalletStore((state) => state.bootstrap);
  const connected = useWalletStore((state) => state.address);
  const wrongNetwork = useWalletStore((state) => isWrongNetwork(state));
  const [summary, setSummary] = useState<IdentityWalletSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryRevision, reloadSummary] = useReducer((value: number) => value + 1, 0);
  const [state, dispatch] = useReducer(managementReducer, initialState);

  const knownAddresses = useMemo(() => {
    // Older daemons and e2e fixtures can return an empty object while this
    // capability is unavailable. Treat a missing list as empty instead of
    // letting the optional feature crash the entire PCA landing page.
    const addresses = [...(data?.wallets?.map((wallet) => wallet.address) ?? [])];
    if (connected) addresses.push(connected);
    return addresses;
  }, [connected, data]);
  const knownAddressesKey = knownAddresses.join('|').toLowerCase();

  useEffect(() => {
    let cancelled = false;
    if (!data?.hasProfile || !bootstrap?.identityWallets) {
      setSummary(null);
      setSummaryError(null);
      setSummaryLoading(false);
      return;
    }
    setSummaryLoading(true);
    setSummaryError(null);
    const client = publicClientFor(bootstrap.chainId, bootstrap.rpcUrls);
    void readIdentityWalletSummary(bootstrap, client, data.identityId, knownAddresses)
      .then((next) => {
        if (!cancelled) setSummary(next);
      })
      .catch((err) => {
        if (!cancelled) {
          setSummary(null);
          setSummaryError((err as Error)?.message ?? 'Could not read identity keys from chain.');
        }
      })
      .finally(() => {
        if (!cancelled) setSummaryLoading(false);
      });
    return () => { cancelled = true; };
  }, [bootstrap, data?.hasProfile, data?.identityId, knownAddressesKey, summaryRevision]);

  const connectedRoles = summary?.addresses.find((item) => eqAddress(item.address, connected));
  const connectedIsAdmin = connectedRoles?.admin === true;
  const transactionPending = state.transaction.status === 'signing' || state.transaction.status === 'submitted';
  const writesEnabled = Boolean(
    data?.hasProfile &&
    bootstrap?.identityWallets &&
    connected &&
    connectedIsAdmin &&
    !wrongNetwork &&
    !transactionPending,
  );
  const primaryAddress = data?.wallets?.find((wallet) => wallet.isPrimary)?.address ?? null;

  const submit = useCallback(async (action: IdentityWalletAction, addressValue: string) => {
    let address: Address;
    try {
      address = parseAddress(
        addressValue,
        IDENTITY_WALLET_ACTION_META[action].role === 'admin' ? 'Admin wallet' : 'Operational wallet',
      );
    } catch (err) {
      dispatch({ type: 'failed', message: actionError(err) });
      return;
    }
    if (!data?.hasProfile) {
      dispatch({ type: 'failed', message: 'This node does not have an on-chain identity profile.' });
      return;
    }
    dispatch({ type: 'signing', action, address });
    try {
      const result = await dispatchIdentityWalletAction(
        {
          onProgress: (event) => {
            if (event.state === 'submitted' && event.txHash) {
              dispatch({ type: 'submitted', action, address, txHash: event.txHash });
            } else if (event.state === 'signing') {
              dispatch({ type: 'signing', action, address });
            }
          },
        },
        action,
        data.identityId,
        address,
        primaryAddress,
      );
      dispatch({
        type: 'succeeded',
        completed: { action, address: result.address, txHash: result.txHash, confirmed: true },
      });
      refresh();
      reloadSummary();
    } catch (err) {
      const txHash = uncertainTransactionHash(err);
      dispatch({
        type: 'failed',
        message: actionError(err),
        completed: txHash ? { action, address, txHash, confirmed: false } : undefined,
      });
    }
  }, [data?.hasProfile, data?.identityId, primaryAddress, refresh]);

  const requestRemoval = useCallback((role: IdentityWalletRole, value: string) => {
    try {
      const address = parseAddress(value, role === 'admin' ? 'Admin wallet' : 'Operational wallet');
      if (role === 'operational' && primaryAddress && eqAddress(address, primaryAddress)) {
        throw new IdentityWalletActionError(
          'The primary operational wallet cannot be removed because it anchors this node\'s on-chain identity.',
        );
      }
      dispatch({ type: 'request-removal', removal: { role, address } });
    } catch (err) {
      dispatch({ type: 'failed', message: actionError(err) });
    }
  }, [primaryAddress]);

  const confirmRemoval = useCallback(() => {
    if (!state.removal) return;
    void submit(
      state.removal.role === 'admin' ? 'remove-admin' : 'remove-operational',
      state.removal.address,
    );
  }, [state.removal, submit]);

  return {
    data: data as OperationalWalletSnapshot | null,
    loading,
    loadError,
    refresh,
    bootstrap,
    connected,
    wrongNetwork,
    summary,
    summaryError,
    summaryLoading,
    reloadSummary,
    connectedIsAdmin,
    identityContractsReady: Boolean(bootstrap?.identityWallets),
    writesEnabled,
    primaryAddress,
    inputs: state.inputs,
    setInput: (role: IdentityWalletRole, value: string) => dispatch({ type: 'input', role, value }),
    removal: state.removal,
    requestRemoval,
    cancelRemoval: () => dispatch({ type: 'cancel-removal' }),
    confirmRemoval,
    submit,
    transaction: state.transaction,
    transactionPending,
  };
}
