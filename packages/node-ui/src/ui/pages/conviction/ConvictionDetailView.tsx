import React, { useEffect, useRef, useState } from 'react';
import { useFetch } from '../../hooks.js';
import {
  fetchPca,
  fetchWalletsBalances,
  fetchContextGraphs,
  registerContextGraph,
  listPcaAgents,
  listPcaContracts,
  describePcaError,
  isRpcTransportError,
  HttpError,
  type PcaSnapshot,
} from '../../api.js';
import { useOwnerActionSubmitter } from '../../pca/ownerActions.js';
import { useAgentsStore } from '../../stores/agents.js';
import { useTabsStore } from '../../stores/tabs.js';
import { isWrongNetwork, useWalletStore } from '../../stores/wallet.js';
import { usePcaStore } from '../../stores/pca.js';
import { publicClientFor } from '../../web3/clients.js';
import {
  describeWalletTxError,
  WalletReceiptRevertedError,
  WalletReceiptWaitError,
  WalletTxStepError,
} from '../../web3/walletTxError.js';
import { formatTrac } from '../../lib/formatTrac.js';
import {
  HealthChip,
  WalletRow,
  PcaAgentList,
  AddressCrux,
  WalletConnectControl,
  WalletPill,
  DeviceConfirmProgress,
  formatWeiToTrac,
  formatRelativeExpiry,
  type DeviceConfirmStep,
} from '../../components/Pca/index.js';
import type { WalletTxProgressEvent } from '../../web3/walletOwnerActionSubmitter.js';
import { healthForSnapshot } from '../../pca/health.js';
import { StatStrip } from '../../components/ContextGraphPrimitives.js';
import { ApproveWalletsModal } from './ApproveWalletsModal.js';
import { CreatePcaModal } from './CreatePcaModal.js';

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
type DetailOwnerMode = 'daemon' | 'wallet' | 'external' | 'unknown';

function detailOwnerMode(owner: string, primaryWallet?: string, connectedWallet?: string | null): DetailOwnerMode {
  if (eq(owner, primaryWallet)) return 'daemon';
  if (connectedWallet && eq(owner, connectedWallet) && !eq(owner, primaryWallet)) return 'wallet';
  return 'external';
}

type DetailDeviceAction = 'topup' | 'remove';

function initialDetailDeviceSteps(action: DetailDeviceAction): DeviceConfirmStep[] {
  return action === 'topup'
    ? [
        { id: 'approve', label: 'Approve exact TRAC allowance', state: 'pending' },
        { id: 'action', label: 'Sign top-up', state: 'pending' },
        { id: 'confirm', label: 'Confirm on-chain receipt', state: 'pending' },
      ]
    : [
        { id: 'action', label: 'Sign remove wallet', state: 'pending' },
        { id: 'confirm', label: 'Confirm on-chain receipt', state: 'pending' },
      ];
}

/**
 * M7 — CG-bind goes through `POST /api/context-graph/register` whose classifier
 * differs from the PCA routes (Backend-confirmed caveat set), so it needs its
 * own mapping rather than `describePcaError`:
 *  - transport RPC_* / TIMEOUT → transient retry
 *  - 501 → soft "can't verify PCA ownership" (introspection gap, not a hard error)
 *  - 403 signer≠owner → "bind from the PCA owner wallet"
 *  - 404 / 409 / 400 (engine validation sentence) → surfaced verbatim-ish
 *  - 503 "no known creator" → creator not synced yet (vs generic transport)
 */
function describeCgBindError(err: unknown): string {
  if (isRpcTransportError(err)) return 'The chain RPC is temporarily unavailable — try again.';
  if (err instanceof HttpError) {
    const raw = (err.body as { error?: string } | undefined)?.error ?? err.message ?? '';
    switch (err.status) {
      case 501:
        return 'Couldn’t verify PCA ownership on this node — its chain adapter doesn’t support the lookup, so binding can’t be completed here.';
      case 403:
        return 'Bind from the PCA owner wallet — this node’s chain signer isn’t the account owner.';
      case 404:
        return 'That context graph or PCA account doesn’t exist.';
      case 409:
        return /already/i.test(raw) ? 'This context graph is already registered.' : raw || 'Already registered.';
      case 400:
        return raw || 'Invalid request — the context graph must be curated and the PCA id a positive integer.';
      case 503:
        return /no known creator/i.test(raw)
          ? 'The context graph’s creator isn’t synced on this node yet — try again shortly.'
          : 'The chain RPC is temporarily unavailable — try again.';
    }
  }
  return (err as Error)?.message ?? 'Bind failed.';
}

interface ActionState {
  busy: boolean;
  error: string | null;
  result: { txHash?: string; message: string } | null;
  /**
   * W2 — an ambiguous-broadcast warning (e.g. a top-up 504 carrying a txHash): the tx
   * MAY be on-chain, so we surface it role=alert with the tx + a recheck, NOT a benign
   * "try again" that would invite a second fund-locking submit.
   */
  warning?: { txHash?: string; message: string } | null;
}
const IDLE: ActionState = { busy: false, error: null, result: null };

/**
 * S3 PCA Detail (Manage). Owner actions are enabled for the daemon-owned branch
 * and for the connected-wallet-owned branch on the right network; external PCAs
 * remain read-only. Settlement and the probe stay enabled for everyone
 * (permissionless). Every write surfaces its txHash + a pending/verify escape.
 */
export function ConvictionDetailView({ accountId }: { accountId: string }) {
  // GAP-4/5 — the S3 detail view opts into the EXTENDED snapshot (remainingAllowance /
  // primaryNode / currentEpoch) for the budget widget. It's a single on-mount read (not a
  // hot poll), so the extra readback cost is fine here; the fields are best-effort (absent
  // on read-failure → the widget shows nothing, never a false value).
  const { data: snapshot, loading, error, refresh } = useFetch(() => fetchPca(accountId, undefined, { extended: true }), [accountId]);
  const { data: wb, error: wbError, refresh: refreshWallets } = useFetch(fetchWalletsBalances, [], 0);
  const nodeStatus = useAgentsStore((s) => s.nodeStatus) as { blockExplorerUrl?: string | null } | null;
  const explorer = nodeStatus?.blockExplorerUrl ?? null;
  const connectedWallet = useWalletStore((s) => s.address);
  const walletWrongNetwork = useWalletStore((s) => isWrongNetwork(s));
  const switchToExpectedChain = useWalletStore((s) => s.switchToExpectedChain);
  const setWalletBootstrap = useWalletStore((s) => s.setBootstrap);
  const initWallet = useWalletStore((s) => s.initWallet);
  const wallets = wb?.wallets ?? [];
  // L3: a transient balances blip (wb null + error) must NOT reclassify
  // owned→not-owner and flicker the owner controls into a definitive "you're not
  // the owner" — show "can't confirm" instead and keep the retry.
  const walletsUnknown = !wb && !!wbError;

  useEffect(() => {
    let cancelled = false;
    void listPcaContracts()
      .then((contracts) => {
        if (!cancelled) setWalletBootstrap(contracts);
      })
      .catch(() => {
        // Detail reads still work through the daemon. Wallet writes fail closed
        // through the owner-action resolver until bootstrap succeeds.
      })
      .finally(() => {
        if (!cancelled) initWallet();
      });
    return () => {
      cancelled = true;
    };
  }, [initWallet, setWalletBootstrap]);

  if (loading && !snapshot) return <div className="lazy-spinner">Loading PCA #{accountId}…</div>;
  if (error || !snapshot) {
    return (
      <div className="v10-pca-detail">
        <div className="card">
          <div className="card-body v10-pca-card-error">
            <p>Couldn’t load PCA #{accountId}.</p>
            <button type="button" className="v10-pca-card-btn" onClick={() => refresh()}>Retry</button>
          </div>
        </div>
      </div>
    );
  }

  const ownerMode: DetailOwnerMode = walletsUnknown
    ? 'unknown'
    : detailOwnerMode(snapshot.owner, wallets[0], connectedWallet);
  const ownerIsPrimary = ownerMode === 'daemon';
  const ownerWritesEnabled = ownerMode === 'daemon' || (ownerMode === 'wallet' && !walletWrongNetwork);
  const ownerInPool = wallets.some((w) => eq(w, snapshot.owner));
  const ownerOnlyReason = walletsUnknown
    ? `Couldn’t load this node’s wallets — can’t confirm ownership of PCA #${accountId}.`
    : ownerInPool
      ? `Owner-only — PCA #${accountId} is owned by ${snapshot.owner}, not this node’s primary operational wallet, so node-UI can’t sign for it.`
      : `Owner-only — this node isn’t the owner of PCA #${accountId}.`;

  const ownerGateReason = walletsUnknown
    ? `Couldn't load this node's wallets - can't confirm ownership of PCA #${accountId}.`
    : ownerMode === 'wallet' && walletWrongNetwork
      ? `Wrong network - switch the connected wallet to this node's PCA network to manage PCA #${accountId}.`
      : ownerMode === 'wallet'
        ? `Connected wallet ${snapshot.owner} owns PCA #${accountId}; device-signed owner actions are enabled.`
        : ownerInPool
          ? `Owner-only - PCA #${accountId} is owned by ${snapshot.owner}, not this node's primary operational wallet, so node-UI can't sign for it.`
          : connectedWallet
            ? `Owner-only - connected as ${connectedWallet}; switch to ${snapshot.owner} to manage PCA #${accountId}.`
            : `Owner-only - connect ${snapshot.owner} to manage PCA #${accountId}.`;

  return (
    <DetailBody
      accountId={accountId}
      snapshot={snapshot}
      wallets={wallets}
      ownerTrac={wb?.balances?.find((b) => eq(b.address, snapshot.owner))?.trac}
      explorer={explorer}
      ownerMode={ownerMode}
      ownerWritesEnabled={ownerWritesEnabled}
      walletWrongNetwork={walletWrongNetwork}
      connectedWallet={connectedWallet}
      ownerOnlyReason={ownerGateReason}
      walletsUnknown={walletsUnknown}
      onRetryWallets={refreshWallets}
      onSwitchNetwork={() => void switchToExpectedChain()}
      refresh={refresh}
    />
  );
}

function DetailBody({
  accountId,
  snapshot,
  wallets,
  ownerTrac,
  explorer,
  ownerMode,
  ownerWritesEnabled,
  walletWrongNetwork,
  connectedWallet,
  ownerOnlyReason,
  walletsUnknown,
  onRetryWallets,
  onSwitchNetwork,
  refresh,
}: {
  accountId: string;
  snapshot: PcaSnapshot;
  wallets: string[];
  ownerTrac?: string;
  explorer: string | null;
  ownerMode: DetailOwnerMode;
  ownerWritesEnabled: boolean;
  walletWrongNetwork: boolean;
  connectedWallet?: string | null;
  ownerOnlyReason: string;
  walletsUnknown: boolean;
  onRetryWallets: () => void;
  onSwitchNetwork: () => void;
  refresh: () => void;
}) {
  const deviceActionRef = useRef<DetailDeviceAction | null>(null);
  const [deviceSteps, setDeviceSteps] = useState<DeviceConfirmStep[]>([]);
  const [deviceLabel, setDeviceLabel] = useState('Confirm on your device');
  const onWalletProgress = (event: WalletTxProgressEvent) => {
    const action = deviceActionRef.current ?? 'topup';
    setDeviceLabel(() => {
      if (event.step === 'approve') {
        if (event.state === 'skipped' || event.state === 'confirmed') return 'Allowance ready — continue to the owner action';
        if (event.state === 'failed') return 'Wallet transaction failed';
        return 'Confirm on your device (1 of 2): approve TRAC';
      }
      if (event.state === 'active') return action === 'topup'
        ? 'Confirm on your device (2 of 2): top up'
        : 'Confirm on your device: remove wallet';
      if (event.state === 'submitted') return 'Waiting for on-chain confirmation';
      if (event.state === 'confirmed') return 'Transaction confirmed on-chain';
      return 'Wallet transaction failed';
    });
    setDeviceSteps((prev) => {
      const next = (prev.length ? prev : initialDetailDeviceSteps(action)).map((s) => ({ ...s }));
      const approve = next.find((s) => s.id === 'approve');
      const actionStep = next.find((s) => s.id === 'action')!;
      const confirm = next.find((s) => s.id === 'confirm')!;
      if (event.step === 'approve') {
        if (!approve) return next;
        if (event.state === 'skipped') {
          approve.state = 'confirmed';
          approve.label = 'TRAC allowance already sufficient';
        } else if (event.state === 'active' || event.state === 'submitted') {
          approve.state = 'active';
          approve.txHash = event.txHash;
        } else if (event.state === 'confirmed') {
          approve.state = 'confirmed';
          approve.txHash = event.txHash;
        } else if (event.state === 'failed') {
          approve.state = 'failed';
          approve.txHash = event.txHash;
          approve.error = describeWalletTxError(event.error, 'approve').message;
        }
        return next;
      }
      if (event.state === 'active') {
        if (approve?.state === 'pending') approve.state = 'confirmed';
        actionStep.state = 'active';
      } else if (event.state === 'submitted') {
        if (approve?.state === 'pending') approve.state = 'confirmed';
        actionStep.state = 'confirmed';
        actionStep.txHash = event.txHash;
        confirm.state = 'active';
      } else if (event.state === 'confirmed') {
        if (approve?.state === 'pending') approve.state = 'confirmed';
        actionStep.state = 'confirmed';
        actionStep.txHash = event.txHash;
        confirm.state = 'confirmed';
        confirm.txHash = event.txHash;
      } else if (event.state === 'failed') {
        actionStep.state = 'failed';
        actionStep.txHash = event.txHash;
        actionStep.error = describeWalletTxError(event.error, 'action').message;
      }
      return next;
    });
  };
  const owner = useOwnerActionSubmitter({
    accountId,
    onWalletProgress: ownerMode === 'wallet' ? onWalletProgress : undefined,
  });
  const ownerIsPrimary = ownerMode === 'daemon';
  const bindOwnerEnabled = ownerMode === 'daemon';
  const bindOwnerTitle = bindOwnerEnabled
    ? undefined
    : ownerMode === 'wallet'
      ? 'Context-graph binding from a connected wallet is not available yet; bind from the node hot owner.'
      : ownerOnlyReason;
  const topUpPending = usePcaStore((s) => s.topUpPending[accountId] ?? null);
  const setTopUpPending = usePcaStore((s) => s.setTopUpPending);
  const clearTopUpPending = usePcaStore((s) => s.clearTopUpPending);
  const walletBootstrap = useWalletStore((s) => s.bootstrap);
  const [topUp, setTopUp] = useState('');
  const [fund, setFund] = useState<ActionState>(IDLE);
  const [settle, setSettle] = useState<ActionState>(IDLE);
  const [probe, setProbe] = useState('');
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [bindCg, setBindCg] = useState('');
  const [bind, setBind] = useState<ActionState>(IDLE);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removeState, setRemoveState] = useState<ActionState>(IDLE);
  const [approveOpen, setApproveOpen] = useState(false);
  // S2b renew (re-mint replacement): the seeded create modal, then the chained
  // approve modal pre-filled with THIS (old) account's agents for one-step re-approval.
  const [renewOpen, setRenewOpen] = useState(false);
  // LOW#3 — in-flight while resolving the old agents (prevents a no-feedback gap).
  const [renewChaining, setRenewChaining] = useState(false);
  const [renewApprove, setRenewApprove] = useState<
    { newAccountId: string; seedBulk: string; agentsResolved: boolean } | null
  >(null);
  const openTab = useTabsStore((s) => s.openTab);

  useEffect(() => {
    if (!topUpPending || !walletBootstrap?.rpcUrls?.length) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const client = publicClientFor(walletBootstrap.chainId, walletBootstrap.rpcUrls);
        const receipt = await client.getTransactionReceipt({
          hash: topUpPending.txHash as `0x${string}`,
        });
        if (cancelled) return;
        clearTopUpPending(accountId);
        if (receipt.status === 'success') {
          setFund({
            busy: false,
            error: null,
            warning: null,
            result: { txHash: topUpPending.txHash, message: 'Top-up confirmed on-chain.' },
          });
          refresh();
        } else {
          setFund({
            busy: false,
            error: 'The pending top-up transaction reverted on-chain.',
            warning: null,
            result: null,
          });
        }
      } catch {
        if (!cancelled) timer = setTimeout(poll, 5_000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [accountId, clearTopUpPending, refresh, topUpPending, walletBootstrap]);

  // After the renewal mint, chain into Approve seeded with the OLD account's agents.
  // Approvals don't carry over AND expiry doesn't free them (gate-HIGH), so the chained
  // modal deregisters each from the old account before re-approving on the new id.
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

  const { data: cgData } = useFetch(fetchContextGraphs, [], 0);
  // B3 — the FULL approved publishing-wallet set (chain enumerator). A 404/503/error
  // degrades to the P0 probe-only "this node's wallets" view below (no crash).
  const { data: agentsData, loading: agentsLoading, refresh: refreshAgents } =
    useFetch(() => listPcaAgents(accountId), [accountId]);
  // A (#1357) — useFetch RETAINS the prior account's data on a failed re-fetch, so after
  // switching PCAs a failed listPcaAgents for the NEW account would render the PREVIOUS
  // account's wallets under the new header. The response echoes its accountId; only treat
  // the data as current when it matches (both decimal id strings). Otherwise loading/degrade.
  const agentsForThis = agentsData && agentsData.accountId === accountId ? agentsData : null;
  // O3 (corrects N3) — bind == register an UNREGISTERED CG with a PCA, forcing the
  // CURATED publish policy at registration (the backend governs bindability by
  // PUBLISH policy, not access policy — public-read + curated-publish is supported).
  // So bindable = unregistered (no onChainId); a registered CG can't be re-bound
  // (there's no update-authority route) so it's excluded to avoid a false "Bound".
  const cgs = (cgData?.contextGraphs ?? []) as Array<{
    id: string;
    name?: string;
    onChainId?: string;
  }>;
  const bindable = cgs.filter((cg) => !cg.onChainId);
  const health = healthForSnapshot(snapshot);
  const ownerTitle = ownerWritesEnabled ? undefined : ownerOnlyReason;

  const runFund = async () => {
    if (ownerMode === 'wallet') {
      deviceActionRef.current = 'topup';
      setDeviceSteps(initialDetailDeviceSteps('topup'));
      setDeviceLabel('Confirm on your device (1 of 2): approve TRAC');
    } else {
      setDeviceSteps([]);
    }
    setFund({ busy: true, error: null, result: null, warning: null });
    try {
      const res = await owner.topUp(accountId, topUp.trim());
      clearTopUpPending(accountId);
      setFund({ busy: false, error: null, result: { txHash: res.txHash, message: `Added ${formatTrac(res.addedTokens)} TRAC.` } });
      setTopUp('');
      refresh();
    } catch (err) {
      // W2 — a 504 carrying a broadcast txHash means the top-up MAY be on-chain (the
      // transferFrom already ran). Do NOT say "try again" — a retry would lock a SECOND
      // top-up. Warn + show the tx + let them recheck. A 504 with NO txHash is a genuine
      // pre-broadcast outage ("try again" correct), and 400/403/409 are unchanged.
      if (err instanceof HttpError && err.status === 504) {
        const txHash = (err.body as { txHash?: string } | undefined)?.txHash;
        if (txHash) {
          setTopUpPending({
            accountId,
            ownerEoa: snapshot.owner,
            submittedAt: Date.now(),
            txHash,
            tokens: topUp.trim(),
            previousTopUpBufferTrac: snapshot.topUpBufferTrac,
          });
          setFund({
            busy: false,
            error: null,
            result: null,
            warning: {
              txHash,
              message:
                'Your top-up was submitted but we lost confirmation — it may already be on-chain. Verify on the explorer before adding again; a second top-up would lock additional TRAC.',
            },
          });
          return;
        }
      }
      if (err instanceof WalletReceiptWaitError && err.txStep === 'action' && err.txHash) {
        setTopUpPending({
          accountId,
          ownerEoa: snapshot.owner,
          submittedAt: Date.now(),
          txHash: err.txHash,
          tokens: topUp.trim(),
          previousTopUpBufferTrac: snapshot.topUpBufferTrac,
        });
        setFund({
          busy: false,
          error: null,
          result: null,
          warning: {
            txHash: err.txHash,
            message:
              'Your top-up was submitted but we lost confirmation - it may already be on-chain. This exact transaction is being checked; do not add again until it resolves.',
          },
        });
        return;
      }
      if (ownerMode === 'wallet') {
        const info = describeWalletTxError(
          err,
          err instanceof WalletTxStepError ? err.txStep : err instanceof WalletReceiptWaitError ? err.txStep ?? 'action' : 'action',
        );
        setFund({
          busy: false,
          error: info.message,
          result: null,
          warning: err instanceof WalletReceiptRevertedError ? null : undefined,
        });
        return;
      }
      setFund({ busy: false, error: describePcaError(err, { accountId })?.message ?? (err as Error)?.message ?? 'Top-up failed.', result: null });
    }
  };
  const runSettle = async () => {
    setSettle({ busy: true, error: null, result: null });
    try {
      const res = await owner.settle(accountId);
      setSettle({ busy: false, error: null, result: { txHash: res.txHash, message: 'Settlement sweep submitted.' } });
      refresh();
    } catch (err) {
      setSettle({ busy: false, error: describePcaError(err, { accountId })?.message ?? (err as Error)?.message ?? 'Settle failed.', result: null });
    }
  };
  const runProbe = async () => {
    setProbeResult(null);
    const addr = probe.trim();
    if (!ADDR_RE.test(addr)) { setProbeResult('Enter a valid 0x address.'); return; }
    try {
      const snap = await fetchPca(accountId, addr);
      const reg = snap.probedKey?.registered;
      // M8: a 200 that omits probedKey (or registered:null) means the adapter
      // couldn't answer — render "couldn't determine", NOT a false "✗ NOT approved".
      setProbeResult(
        reg === true
          ? `✓ ${addr} is an approved publishing wallet here.`
          : reg === false
            ? `✗ ${addr} is NOT approved here.`
            : `Couldn’t determine whether ${addr} is approved here — retry.`,
      );
    } catch (err) {
      setProbeResult(describePcaError(err, { accountId })?.message ?? 'Probe failed.');
    }
  };
  const runBind = async () => {
    setBind({ busy: true, error: null, result: null });
    try {
      // O3 — force the CURATED publish policy: a public CG would otherwise derive
      // to OPEN and the backend rejects ("PCA account id can only be used with
      // curated publish policy"). Binding makes the graph curated-publish.
      const res = await registerContextGraph(bindCg, { pcaAccountId: accountId, publishPolicy: 0 });
      // N3 — a 200 with NO txHash means the CG was already registered on-chain and
      // the daemon took the idempotent path WITHOUT applying the new pcaAccountId.
      // Never claim "Bound" (a #9 false confirmation) — say it plainly.
      if (!res.txHash) {
        setBind({
          busy: false,
          error:
            'This context graph is already registered on-chain — its publishing authority can’t be changed from here. Bind a PCA when first registering the graph.',
          result: null,
        });
        return;
      }
      setBind({ busy: false, error: null, result: { txHash: res.txHash, message: `Bound ${bindCg} to PCA #${accountId}.` } });
    } catch (err) {
      setBind({ busy: false, error: describeCgBindError(err), result: null });
    }
  };
  const runRemove = async (addr: string) => {
    if (ownerMode === 'wallet') {
      deviceActionRef.current = 'remove';
      setDeviceSteps(initialDetailDeviceSteps('remove'));
      setDeviceLabel('Confirm on your device: remove wallet');
    } else {
      setDeviceSteps([]);
    }
    setRemoveState({ busy: true, error: null, result: null });
    try {
      await owner.deregisterAgent(accountId, addr);
      setRemoveState({ busy: false, error: null, result: { message: `Removed ${addr}.` } });
      setConfirmRemove(null);
      refresh();
      refreshAgents();
    } catch (err) {
      setRemoveState({ busy: false, error: describePcaError(err, { accountId })?.message ?? (err as Error)?.message ?? 'Remove failed.', result: null });
    }
  };

  const pct = (snapshot.discountBps / 100).toFixed(snapshot.discountBps % 100 === 0 ? 0 : 1);
  const walletSurfaceCopy = connectedWallet
    ? ownerMode === 'wallet'
      ? walletWrongNetwork
        ? 'Owner wallet matches; switch network before signing owner actions.'
        : 'Connected owner wallet will sign top-up, approve, remove, and renewal actions.'
      : ownerMode === 'daemon'
        ? 'Connected wallet is available for wallet-owned PCAs; this account uses the node daemon for owner actions.'
        : `Connected as ${connectedWallet}; switch to ${snapshot.owner} to manage owner actions.`
    : ownerMode === 'external'
      ? 'Connect the PCA owner wallet to manage this account. Provider metadata is display-only.'
      : 'Connect a wallet to view and manage wallet-owned PCAs from this tab.';

  return (
    <div className="v10-pca-detail" data-testid="pca-detail">
      <div className="v10-pca-detail-band">
        <span className="v10-pca-detail-id">PCA #{accountId}</span>
        <span className="badge badge-info">◉ {pct}% discount</span>
        <span className="v10-pca-detail-committed">{formatTrac(snapshot.committedTRACTrac)} TRAC committed</span>
        <span className="v10-pca-card-spacer" />
        <HealthChip state={health} />
      </div>

      <div className="v10-modal-tip" role="status">
        {walletSurfaceCopy}
        {connectedWallet ? <WalletPill /> : <WalletConnectControl />}
      </div>

      {deviceSteps.length > 0 && (
        <DeviceConfirmProgress
          steps={deviceSteps}
          currentLabel={deviceLabel}
          blockExplorerUrl={explorer}
        />
      )}

      {!ownerWritesEnabled && (
        <div className="v10-modal-warning" role="status">
          ⓘ {ownerOnlyReason}{' '}
          {walletsUnknown ? (
            <button type="button" className="v10-pca-card-btn" onClick={onRetryWallets}>Retry</button>
          ) : (
            'Settlement and the wallet probe stay available.'
          )}
        </div>
      )}

      <StatStrip
        items={[
          { id: 'buffer', label: 'Top-up buffer', value: `${formatTrac(snapshot.topUpBufferTrac)} TRAC` },
          { id: 'per-epoch', label: 'TRAC per epoch', value: `${formatWeiToTrac(snapshot.baseEpochAllowance)} TRAC` },
          // GAP-4/5 — the precise current-epoch remaining allowance (extended snapshot,
          // best-effort). Display only — the coverage spine stays the coarse proxy (#1349
          // is a separate decision). Omitted when the extended read didn't return it.
          ...(snapshot.remainingAllowanceTrac != null
            ? [{
                id: 'remaining',
                label: 'Remaining this epoch',
                value: `${formatTrac(snapshot.remainingAllowanceTrac)} TRAC`,
                tooltip: snapshot.currentEpoch != null ? `Current epoch ${snapshot.currentEpoch}` : undefined,
              }]
            : []),
          { id: 'wallets', label: 'Publishing wallets', value: `${snapshot.agentCount} / 100` },
          { id: 'expires', label: 'Expires', value: formatRelativeExpiry(snapshot.expiresAtTimestamp), tooltip: `Expiry epoch ${snapshot.expiresAtEpoch}` },
          // GAP-4/5 — the node this PCA directs publishing-reward weight to. '0' = none set;
          // ABSENT (read-failed) → omit, never a false value.
          ...(snapshot.primaryNode != null
            ? [{
                id: 'primary-node',
                label: 'Primary node',
                value: snapshot.primaryNode === '0' ? 'None set' : `Node #${snapshot.primaryNode}`,
                tooltip: snapshot.lastPrimaryNodeChangeEpoch != null ? `Last changed epoch ${snapshot.lastPrimaryNodeChangeEpoch}` : undefined,
              }]
            : []),
        ]}
      />
      <div className="v10-pca-detail-owner">
        <span className="v10-pca-card-owner-lbl">Owner</span>
        <WalletRow
          address={snapshot.owner}
          trailing={explorer ? <a className="v10-pca-card-explorer" href={`${explorer}/address/${snapshot.owner}`} target="_blank" rel="noreferrer" aria-label="View owner on explorer">↗</a> : undefined}
        />
      </div>

      {/* Funding */}
      <section className="v10-pca-detail-section">
        <h3 className="v10-pca-detail-section-title">Funding</h3>
        <p className="v10-pca-detail-hint">
          Top-up raises the spendable buffer. It does <strong>not</strong> extend the lock period —
          when the account expires you create a new one.
        </p>
        {ownerTrac != null && <p className="v10-pca-detail-hint">Owner balance: {formatTrac(ownerTrac)} TRAC</p>}
        <div className="v10-pca-detail-form">
          <input
            className="v10-form-input"
            type="text"
            inputMode="decimal"
            value={topUp}
            onChange={(e) => setTopUp(e.target.value)}
            placeholder="Top up (TRAC)"
            disabled={!ownerWritesEnabled || fund.busy || !!topUpPending}
            aria-label="Top-up amount in TRAC"
          />
          <button
            type="button"
            className="v10-pca-card-btn primary"
            data-testid="pca-topup-btn"
            onClick={runFund}
            disabled={!ownerWritesEnabled || fund.busy || !!topUpPending || !/^\d+(\.\d+)?$/.test(topUp.trim()) || Number(topUp.trim()) <= 0}
            title={ownerTitle}
          >
            {fund.busy ? 'Adding…' : 'Add funds'}
          </button>
        </div>
        <ActionFeedback state={fund} explorer={explorer} onRecheck={refresh} />
        {topUpPending && (
          <p className="v10-pca-create-warn" data-testid="pca-topup-pending" role="alert">
            Top-up transaction <code>{topUpPending.txHash}</code> is pending confirmation. The top-up
            button is disabled while this exact receipt is checked; adding again could lock more TRAC.
            {' '}
            <button type="button" className="v10-pca-card-btn" onClick={refresh}>Recheck account</button>
          </p>
        )}
      </section>

      {/* Settlement (permissionless) */}
      <section className="v10-pca-detail-section">
        <h3 className="v10-pca-detail-section-title">Settlement</h3>
        <p className="v10-pca-detail-hint">
          Sweeps each epoch’s unspent budget to the staker reward pool. It’s lazy and permissionless —
          anyone can trigger it; it only moves already-earmarked funds. Last settled epoch{' '}
          {snapshot.lastSettledWindow} · fully swept {snapshot.fullySwept ? '✓' : '✗'}.
        </p>
        <button
          type="button"
          className="v10-pca-card-btn"
          data-testid="pca-settle-btn"
          onClick={runSettle}
          disabled={settle.busy || snapshot.fullySwept}
          title={snapshot.fullySwept ? 'Already fully swept.' : undefined}
        >
          {settle.busy ? 'Sweeping…' : 'Run settlement sweep'}
        </button>
        <ActionFeedback state={settle} explorer={explorer} />
      </section>

      {/* Publishing wallets */}
      <section className="v10-pca-detail-section">
        <h3 className="v10-pca-detail-section-title">Publishing wallets — {snapshot.agentCount} / 100</h3>
        <div className="v10-pca-detail-form">
          <AddressCrux mode="single" value={probe} onChange={setProbe} label="Check a wallet" cruxNote={null} />
          <button type="button" className="v10-pca-card-btn" onClick={runProbe}>Probe</button>
        </div>
        {probeResult && <p className="v10-pca-detail-hint" role="status">{probeResult}</p>}

        {agentsLoading && !agentsForThis ? (
          <p className="v10-pca-detail-hint" role="status">Loading approved wallets…</p>
        ) : agentsForThis ? (
          // B3 — the FULL approved set (chain enumerator); the count-only caveat is retired.
          <>
            <p className="v10-pca-detail-subhead">Approved publishing wallets:</p>
            {agentsForThis.agents.length > 0 ? (
              <PcaAgentList
                agents={agentsForThis.agents}
                nodeWallets={wallets}
                ownerIsPrimary={ownerWritesEnabled}
                ownerTitle={ownerTitle}
                confirmRemove={confirmRemove}
                onAskRemove={(a) => setConfirmRemove(a)}
                onCancelRemove={() => setConfirmRemove(null)}
                onConfirmRemove={(a) => runRemove(a)}
                removeBusy={removeState.busy}
                explorer={explorer}
              />
            ) : (
              <div className="v10-pca-detail-agentlist" data-testid="pca-agent-list">
                <p className="v10-pca-handshake-empty">No approved publishing wallets yet.</p>
              </div>
            )}
          </>
        ) : (
          // Graceful degrade (B3 route absent / 503 / a 404 race after the snapshot
          // loaded): the P0 probe-only view of THIS node's wallets + the count-only caveat.
          <>
            <p className="v10-pca-detail-subhead">This node’s wallets:</p>
            <div className="v10-pca-detail-agentlist" data-testid="pca-agent-list">
              {wallets.map((w) => (
                <WalletProbeRow
                  key={w}
                  accountId={accountId}
                  wallet={w}
                  ownerIsPrimary={ownerWritesEnabled}
                  ownerTitle={ownerTitle}
                  confirming={confirmRemove === w}
                  onAskRemove={() => setConfirmRemove(w)}
                  onCancelRemove={() => setConfirmRemove(null)}
                  onConfirmRemove={() => runRemove(w)}
                  removeBusy={removeState.busy}
                />
              ))}
              {wallets.length === 0 && <p className="v10-pca-handshake-empty">No operational wallets on this node.</p>}
            </div>
            <p className="v10-pca-overview-caveat">
              ⓘ The chain exposes how many wallets are approved, not the full list — only this node’s
              wallets and any you probe are shown here.
            </p>
          </>
        )}
        {removeState.error && <p className="v10-modal-error" role="alert">{removeState.error}</p>}
        {/* D2 (#1357) — surface the deregister success (was a dead state). */}
        {removeState.result && (
          <p className="v10-pca-detail-result" role="status" data-testid="pca-remove-result">{removeState.result.message}</p>
        )}
        <button
          type="button"
          className="v10-pca-card-btn primary"
          onClick={() => setApproveOpen(true)}
          disabled={!ownerWritesEnabled}
          title={ownerTitle}
        >
          + Approve publishing wallet
        </button>
      </section>

      {/* Context-graph binding (registers the graph with curated publishing) */}
      <section className="v10-pca-detail-section">
        <h3 className="v10-pca-detail-section-title">Context-graph binding</h3>
        <p className="v10-pca-detail-hint">
          Binding registers the graph with <strong>curated publishing</strong> — only this PCA’s owner
          and authorized wallets can publish into it; read access is unchanged. It’s separate from the
          primary node and from which wallets pay, and the binding node’s signer must equal the PCA owner.
        </p>
        {bindable.length === 0 ? (
          <p className="v10-pca-detail-hint" role="status">
            No unregistered context graphs to bind. Binding sets a graph’s publishing authority at its
            first on-chain registration; an already-registered graph can’t be changed from here.
          </p>
        ) : (
          <div className="v10-pca-detail-form">
            <select
              className="v10-form-select"
              value={bindCg}
              onChange={(e) => setBindCg(e.target.value)}
              disabled={!bindOwnerEnabled || bind.busy}
              aria-label="Context graph to bind"
            >
              <option value="">Select a context graph…</option>
              {bindable.map((cg) => (
                <option key={cg.id} value={cg.id}>{cg.name ?? cg.id}</option>
              ))}
            </select>
            <button
              type="button"
              className="v10-pca-card-btn"
              onClick={runBind}
              disabled={!bindOwnerEnabled || bind.busy || !bindCg}
              title={bindOwnerTitle}
            >
              {bind.busy ? 'Binding…' : 'Bind context graph'}
            </button>
          </div>
        )}
        <ActionFeedback state={bind} explorer={explorer} />
      </section>

      {/* Lifecycle / danger */}
      <section className="v10-pca-detail-section">
        <h3 className="v10-pca-detail-section-title">Lifecycle</h3>
        {(health === 'expiring' || health === 'expired') && (
          <p className="v10-pca-card-warn">
            {formatRelativeExpiry(snapshot.expiresAtTimestamp)}. The lock period can’t be extended —
            Renew creates a fresh replacement account seeded from this one (the old TRAC stays locked
            until its own expiry).
          </p>
        )}
        {/* S2b — Renew = re-mint a REPLACEMENT (owner-signed create), emphasized as the
            account nears/passes expiry. Honest copy lives in the seeded create modal (#9). */}
        <button
          type="button"
          className={`v10-pca-card-btn${health === 'expiring' || health === 'expired' ? ' primary' : ''}`}
          data-testid="pca-renew-btn"
          onClick={() => setRenewOpen(true)}
          disabled={!ownerWritesEnabled}
          title={ownerTitle}
        >
          Renew — create a replacement PCA
        </button>
        <p className="v10-pca-detail-hint">
          ⓘ Transferring this account’s NFT to another wallet clears every approved publishing wallet —
          the new owner starts clean. (Out-of-band wallet op — no button here.)
        </p>
        <button type="button" className="v10-pca-card-btn" disabled title="Coming soon (not yet available from the node UI)">
          Re-point primary node — Coming soon
        </button>
      </section>

      {approveOpen && (
        <ApproveWalletsModal
          accountId={accountId}
          initialMode="self"
          onClose={() => { setApproveOpen(false); refresh(); refreshAgents(); }}
        />
      )}
      {/* S2b renew — the seeded create modal (re-mint replacement). */}
      {renewOpen && (
        <CreatePcaModal
          seed={{
            tokens: snapshot.committedTRACTrac,
            primaryNode:
              snapshot.primaryNode && snapshot.primaryNode !== '0' ? String(snapshot.primaryNode) : undefined,
            // LOW — distinguish "extended read failed" (null) from a genuine "none" ('0'),
            // so the modal can flag a silent fall-back to this node.
            primaryNodeUnknown: snapshot.primaryNode == null,
          }}
          replacingAccountId={accountId}
          initialOwnerKey={ownerMode === 'wallet' ? 'hardware' : 'hot'}
          onClose={() => setRenewOpen(false)}
          onApproveOwnWallets={onRenewSuccess}
          onManage={(newId) => { setRenewOpen(false); openTab({ id: `conviction:${newId}`, label: `PCA #${newId}`, closable: true }); }}
          onGetSponsored={() => setRenewOpen(false)}
        />
      )}
      {/* LOW#3 — brief in-flight state between the mint and the seeded re-approval. */}
      {renewChaining && (
        <div className="lazy-spinner" role="status" data-testid="pca-renew-chaining">
          Preparing re-approval…
        </div>
      )}
      {/* S2b renew — chained Approve, pre-seeded with the OLD account's agents, which it
          DEREGISTERS from the old account first (expiry doesn't free them — gate-HIGH). */}
      {renewApprove && (
        <ApproveWalletsModal
          accountId={renewApprove.newAccountId}
          initialMode="sponsor"
          seedBulk={renewApprove.seedBulk}
          deregisterFrom={accountId}
          seedAgentsResolved={renewApprove.agentsResolved}
          onClose={() => setRenewApprove(null)}
        />
      )}
    </div>
  );
}

function WalletProbeRow({
  accountId, wallet, ownerIsPrimary, ownerTitle, confirming, onAskRemove, onCancelRemove, onConfirmRemove, removeBusy,
}: {
  accountId: string;
  wallet: string;
  ownerIsPrimary: boolean;
  ownerTitle?: string;
  confirming: boolean;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
  removeBusy: boolean;
}) {
  const { data: snap, loading, error } = useFetch(() => fetchPca(accountId, wallet), [accountId, wallet]);
  const registered = snap?.probedKey?.registered;
  // M8: a settled probe that errored or returned 200-without-probedKey is
  // "couldn’t determine" — never silently stuck on "checking…" or false-negative.
  const probeUnknown = !loading && (error != null || (snap != null && registered == null));
  return (
    <div className="v10-pca-agent-row" data-testid="pca-agent-row">
      <WalletRow
        address={wallet}
        status={registered === true ? 'approved' : registered === false ? 'not approved' : probeUnknown ? 'couldn’t determine' : 'checking…'}
        statusTone={registered === true ? 'success' : registered === false ? 'danger' : 'neutral'}
        trailing={
          registered === true ? (
            confirming ? (
              <span className="v10-pca-agent-confirm">
                {/* D (#1357) — these degrade-path rows are ALL this node's own wallets, so
                    name that consequence explicitly (deregistering your own signer degrades
                    your own publishes). */}
                <span>This is one of this node’s own signing wallets — its publishes will pay the direct cost (and revert if it holds no TRAC). Remove?</span>
                <button type="button" className="v10-pca-card-btn" data-testid="pca-deregister-btn" aria-label={`Confirm removing ${wallet}`} onClick={onConfirmRemove} disabled={removeBusy}>
                  {removeBusy ? 'Removing…' : 'Yes, remove'}
                </button>
                <button type="button" className="v10-pca-card-btn" aria-label={`Cancel removing ${wallet}`} onClick={onCancelRemove} disabled={removeBusy}>Cancel</button>
              </span>
            ) : (
              <button
                type="button"
                className="v10-pca-card-btn"
                aria-label={`Remove ${wallet}`}
                onClick={onAskRemove}
                disabled={!ownerIsPrimary}
                title={ownerTitle}
              >
                Remove
              </button>
            )
          ) : undefined
        }
      />
    </div>
  );
}

function ActionFeedback({
  state,
  explorer,
  onRecheck,
}: {
  state: ActionState;
  explorer: string | null;
  onRecheck?: () => void;
}) {
  if (state.warning) {
    // W2 — ambiguous broadcast: role=alert, tx + recheck, NOT a benign "try again".
    const txUrl = explorer && state.warning.txHash ? `${explorer}/tx/${state.warning.txHash}` : undefined;
    return (
      <p className="v10-pca-create-warn" data-testid="pca-action-warning" role="alert">
        {state.warning.message}{' '}
        {state.warning.txHash &&
          (txUrl ? (
            <a href={txUrl} target="_blank" rel="noreferrer">{state.warning.txHash} ↗</a>
          ) : (
            <code>{state.warning.txHash}</code>
          ))}{' '}
        {onRecheck && (
          <button type="button" className="v10-pca-card-btn" onClick={onRecheck}>Recheck</button>
        )}
      </p>
    );
  }
  if (state.error) return <p className="v10-modal-error" role="alert">{state.error}</p>;
  if (!state.result) return null;
  const txUrl = explorer && state.result.txHash ? `${explorer}/tx/${state.result.txHash}` : undefined;
  return (
    <p className="v10-pca-detail-result" data-testid="pca-action-result" role="status">
      {state.result.message}{' '}
      {txUrl && <a href={txUrl} target="_blank" rel="noreferrer">tx ↗</a>}{' '}
      Still pending? You can close this and verify here.
    </p>
  );
}
