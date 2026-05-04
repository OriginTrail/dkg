export interface FaucetResult {
  success: boolean;
  funded: string[];
  fundedWallets?: string[];
  failedWallets?: string[];
  error?: string;
}

const EXPECTED_FAUCET_TRANSFERS_PER_WALLET = 2;

export async function requestFaucetFunding(
  faucetUrl: string,
  mode: string,
  wallets: string[],
  nodeName: string,
  _fetch = globalThis.fetch,
): Promise<FaucetResult> {
  const batches: string[][] = [];
  for (let i = 0; i < wallets.length; i += 3) {
    batches.push(wallets.slice(i, i + 3));
  }
  if (batches.length === 0) return { success: false, funded: [], error: 'no wallets' };

  const safeNodeName = nodeName.replace(/[^\x20-\x7E]/g, '_');
  const funded: string[] = [];
  const fundedWallets = new Set<string>();
  const failedWallets = new Set<string>();
  const errors: string[] = [];
  let sawSuccess = false;

  for (const batch of batches) {
    try {
      const res = await _fetch(faucetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `init-${mode}-${safeNodeName}-${[...batch].sort().join(',')}`,
        },
        body: JSON.stringify({ mode, wallets: batch, callerId: `dkg-node:${nodeName}` }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        errors.push(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        for (const wallet of batch) failedWallets.add(wallet);
        continue;
      }
      const data = await res.json() as Record<string, unknown>;
      const results = Array.isArray(data.results) ? data.results : [];
      const amounts = results
        .filter((r: any) => r && typeof r.status === 'string' && r.status === 'success' && typeof r.chainId === 'string')
        .map((r: any) => {
          const label = String(r.chainId).includes('eth') ? 'ETH' : 'TRAC';
          return `${r.amount ?? '?'} ${label}`;
        });
      const summary = data.summary && typeof data.summary === 'object' ? data.summary as Record<string, unknown> : null;
      const batchSuccess = (typeof summary?.success === 'number' && summary.success > 0) || amounts.length > 0;
      sawSuccess ||= batchSuccess;
      funded.push(...amounts);
      const summarySuccessCount = typeof summary?.success === 'number' ? summary.success : 0;
      const successfulTransferCount = Math.max(summarySuccessCount, amounts.length);
      const expectedTransferCount = batch.length * EXPECTED_FAUCET_TRANSFERS_PER_WALLET;
      const batchFullyFunded = successfulTransferCount >= expectedTransferCount;

      const resultStatusesByAddress = new Map<string, string[]>();
      for (const result of results) {
        if (!result || typeof result !== 'object') continue;
        const record = result as Record<string, unknown>;
        if (typeof record.address !== 'string' || typeof record.status !== 'string') continue;
        const key = record.address.toLowerCase();
        const statuses = resultStatusesByAddress.get(key) ?? [];
        statuses.push(record.status);
        resultStatusesByAddress.set(key, statuses);
      }

      if (resultStatusesByAddress.size > 0) {
        for (const wallet of batch) {
          const statuses = resultStatusesByAddress.get(wallet.toLowerCase()) ?? [];
          if (
            statuses.length >= EXPECTED_FAUCET_TRANSFERS_PER_WALLET &&
            statuses.every((status) => status === 'success')
          ) {
            fundedWallets.add(wallet);
            failedWallets.delete(wallet);
          } else {
            failedWallets.add(wallet);
            fundedWallets.delete(wallet);
          }
        }
      } else if (batchFullyFunded) {
        for (const wallet of batch) {
          fundedWallets.add(wallet);
          failedWallets.delete(wallet);
        }
      } else {
        for (const wallet of batch) {
          failedWallets.add(wallet);
          fundedWallets.delete(wallet);
        }
      }
    } catch (err) {
      if (!sawSuccess && funded.length === 0 && fundedWallets.size === 0) {
        throw err;
      }
      errors.push(`Faucet request failed: ${err instanceof Error ? err.message : String(err)}`);
      for (const wallet of batch) {
        failedWallets.add(wallet);
        fundedWallets.delete(wallet);
      }
    }
  }

  if (failedWallets.size > 0 && errors.length === 0) {
    errors.push(`Faucet did not fund all wallets: ${Array.from(failedWallets).join(', ')}`);
  }

  if (errors.length > 0) {
    return {
      success: sawSuccess,
      funded,
      fundedWallets: Array.from(fundedWallets),
      failedWallets: Array.from(failedWallets),
      error: errors.join('; '),
    };
  }
  return {
    success: sawSuccess,
    funded,
    fundedWallets: Array.from(fundedWallets),
    failedWallets: Array.from(failedWallets),
  };
}
