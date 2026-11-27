/**
 * The one PCA read both the Overview (usePcaOverview) and Get added (GetSponsoredPanel)
 * use: read the account, then probe each of this node's wallets against it. It returns
 * data only. What to say, whether to offer Retry and whether to track the PCA stay
 * with each caller.
 */
import { fetchPca, HttpError, type PcaSnapshot } from '../api.js';
import { classifyCoverage } from './coverage.js';
import type { CoverageProbe } from './walletCoverage.js';

export type PcaAccountRead =
  /** The account was read; one probe per wallet, in wallet order. */
  | { ok: true; snapshot: PcaSnapshot; probes: CoverageProbe[] }
  /** The account itself couldn't be read, so no wallet was probed. */
  | { ok: false; error: unknown; notFound: boolean };

export interface ReadPcaAccountOptions {
  /** Read the account with the extended fields (the Overview needs them; Get added doesn't). */
  extended?: boolean;
}

/** Probe each wallet on the account. A failed probe is inconclusive, never a capability gap. */
export function probeWallets(accountId: string, wallets: string[]): Promise<CoverageProbe[]> {
  return Promise.all(
    wallets.map((wallet) =>
      fetchPca(accountId, wallet, { extended: true })
        // The single canonical classifier (#1344, reads snap.probedKey). An adapter that
        // couldn't answer (adapterSupported === false) is inconclusive, not unregistered.
        .then((snap): CoverageProbe => ({ wallet, coverage: classifyCoverage(snap) }))
        // A transport failure couldn't determine coverage; a retry may resolve it.
        .catch((): CoverageProbe => ({ wallet, coverage: { outcome: 'inconclusive', registered: null, adapterUnsupported: false } })),
    ),
  );
}

/** Read the account, then (only if it was read) probe every wallet. Zero wallets probes nothing. */
export async function readPcaAccount(
  accountId: string,
  wallets: string[],
  { extended = false }: ReadPcaAccountOptions = {},
): Promise<PcaAccountRead> {
  let snapshot: PcaSnapshot;
  try {
    snapshot = extended ? await fetchPca(accountId, undefined, { extended: true }) : await fetchPca(accountId);
  } catch (error) {
    return { ok: false, error, notFound: error instanceof HttpError && error.status === 404 };
  }
  return { ok: true, snapshot, probes: await probeWallets(accountId, wallets) };
}
