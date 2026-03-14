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
      'Idempotency-Key': `init-${safeNodeName}-${Date.now()}`,
    },
    body: JSON.stringify({ mode, wallets: fundable, callerId: `dkg-node:${nodeName}` }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { success: false, funded: [], error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }
  const data = await res.json() as {
    summary?: { success?: number; failed?: number };
    results?: { chainId: string; amount: string; status: string }[];
  };
  const amounts = (data.results ?? [])
    .filter(r => r.status === 'success')
    .map(r => {
      const label = r.chainId.includes('eth') ? 'ETH' : 'TRAC';
      return `${r.amount} ${label}`;
    });
  return { success: (data.summary?.success ?? 0) > 0, funded: amounts };
}
