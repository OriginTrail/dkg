export interface FaucetResult {
  success: boolean;
  funded: string[];
  error?: string;
}

export async function requestFaucetFunding(
  faucetUrl: string,
  mode: string,
  wallets: string[],
  nodeName: string,
  _fetch = globalThis.fetch,
): Promise<FaucetResult> {
  const fundable = wallets.slice(0, 3);
  if (fundable.length === 0) return { success: false, funded: [], error: 'no wallets' };
  const safeNodeName = nodeName.replace(/[^\x20-\x7E]/g, '_');
  const res = await _fetch(faucetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `init-${mode}-${safeNodeName}-${[...fundable].sort().join(',')}`,
    },
    body: JSON.stringify({ mode, wallets: fundable, callerId: `dkg-node:${nodeName}` }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { success: false, funded: [], error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
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
  const success = (typeof summary?.success === 'number' && summary.success > 0) || amounts.length > 0;
  return { success, funded: amounts };
}
