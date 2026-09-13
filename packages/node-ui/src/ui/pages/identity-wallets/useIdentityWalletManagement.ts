import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { getAddress, type Address, type Hex } from 'viem';
import {
  fetchIdentityWalletContracts,
  fetchOperationalWallets,
  type IdentityWalletContracts,
  type OperationalWalletSnapshot,
} from '../../identity-wallet-api.js';
import { useFetch } from '../../hooks.js';
import { eqAddress } from '../../web3/address.js';
import { useWalletStore } from '../../stores/wallet.js';
import { numericChainId } from '../../web3/chainId.js';
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

export type IdentityWalletQueryState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'unavailable';
      reason: 'operational-wallets' | 'identity-contracts';
      snapshot: OperationalWalletSnapshot | null;
    }
  | {
      status: 'ready';
      snapshot: OperationalWalletSnapshot;
      bootstrap: IdentityWalletContracts;
    };

export type IdentityWalletSummaryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; value: IdentityWalletSummary };

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

type SettledIdentityWalletQueryState = Extract<
  IdentityWalletQueryState,
  { status: 'ready' | 'unavailable' }
>;

async function fetchIdentityWalletQuery(): Promise<SettledIdentityWalletQueryState> {
  const [operational, bootstrap] = await Promise.all([
    fetchOperationalWallets(),
    fetchIdentityWalletContracts(),
  ]);
  if (!operational.available) {
    return { status: 'unavailable', reason: 'operational-wallets', snapshot: null };
  }
  if (!bootstrap) {
    return {
      status: 'unavailable',
      reason: 'identity-contracts',
      snapshot: operational.snapshot,
    };
  }
  return { status: 'ready', snapshot: operational.snapshot, bootstrap };
}

function useIdentityWalletQuery(): {
  state: IdentityWalletQueryState;
  refresh: () => void;
} {
  const request = useFetch(fetchIdentityWalletQuery, [], 0);
  const state = useMemo<IdentityWalletQueryState>(() => {
    if (request.error) return { status: 'error', message: request.error };
    return request.data ?? { status: 'loading' };
  }, [request.data, request.error]);
  return { state, refresh: request.refresh };
}

interface IdentityWalletMutationOptions {
  data: OperationalWalletSnapshot | null;
  bootstrap: IdentityWalletContracts | null;
  primaryAddress: string | null;
  refreshQuery: () => void;
  reloadSummary: () => void;
}

function useIdentityWalletMutations({
  data,
  bootstrap,
  primaryAddress,
  refreshQuery,
  reloadSummary,
}: IdentityWalletMutationOptions) {
  const [state, dispatch] = useReducer(managementReducer, initialState);
  const transactionPending = state.transaction.status === 'signing' || state.transaction.status === 'submitted';

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
          bootstrap: bootstrap ?? undefined,
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
      refreshQuery();
      reloadSummary();
    } catch (err) {
      const txHash = uncertainTransactionHash(err);
      dispatch({
        type: 'failed',
        message: actionError(err),
        completed: txHash ? { action, address, txHash, confirmed: false } : undefined,
      });
    }
  }, [bootstrap, data?.hasProfile, data?.identityId, primaryAddress, refreshQuery, reloadSummary]);

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

export function useIdentityWalletManagement() {
  const query = useIdentityWalletQuery();
  const data = query.state.status === 'ready' || query.state.status === 'unavailable'
    ? query.state.snapshot
    : null;
  const bootstrap = query.state.status === 'ready' ? query.state.bootstrap : null;
  const connected = useWalletStore((state) => state.address);
  const connectedChainId = useWalletStore((state) => state.chainId);
  const wrongNetwork = Boolean(
    bootstrap && connectedChainId !== numericChainId(bootstrap.chainId),
  );
  const [summaryState, setSummaryState] = useState<IdentityWalletSummaryState>({ status: 'idle' });
  const [summaryRevision, reloadSummary] = useReducer((value: number) => value + 1, 0);
  const knownAddresses = useMemo(() => {
    const addresses = [...(data?.wallets.map((wallet) => wallet.address) ?? [])];
    if (connected) addresses.push(connected);
    return addresses;
  }, [connected, data]);
  const knownAddressesKey = knownAddresses.join('|').toLowerCase();

  useEffect(() => {
    let cancelled = false;
    if (!data?.hasProfile || !bootstrap) {
      setSummaryState({ status: 'idle' });
      return;
    }
    setSummaryState({ status: 'loading' });
    const client = publicClientFor(bootstrap.chainId, bootstrap.rpcUrls);
    void readIdentityWalletSummary(bootstrap, client, data.identityId, knownAddresses)
      .then((value) => {
        if (!cancelled) setSummaryState({ status: 'ready', value });
      })
      .catch((err) => {
        if (!cancelled) {
          setSummaryState({
            status: 'error',
            message: (err as Error)?.message ?? 'Could not read identity keys from chain.',
          });
        }
      });
    return () => { cancelled = true; };
  }, [bootstrap, data?.hasProfile, data?.identityId, knownAddressesKey, summaryRevision]);

  const summary = summaryState.status === 'ready' ? summaryState.value : null;
  const connectedRoles = summary?.addresses.find((item) => eqAddress(item.address, connected));
  const connectedIsAdmin = connectedRoles?.admin === true;
  const primaryAddress = data?.wallets.find((wallet) => wallet.isPrimary)?.address ?? null;
  const mutations = useIdentityWalletMutations({
    data,
    bootstrap,
    primaryAddress,
    refreshQuery: query.refresh,
    reloadSummary,
  });
  const writesEnabled = Boolean(
    query.state.status === 'ready'
    && data?.hasProfile
    && connected
    && connectedIsAdmin
    && !wrongNetwork
    && !mutations.transactionPending,
  );

  return {
    query: query.state,
    refreshQuery: query.refresh,
    connected,
    wrongNetwork,
    summary: summaryState,
    reloadSummary,
    connectedIsAdmin,
    writesEnabled,
    ...mutations,
  };
}
