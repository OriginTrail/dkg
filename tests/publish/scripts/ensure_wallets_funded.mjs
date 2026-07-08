// Pre-test funding gate (Base Sepolia): check ETH + TRAC on the publish
// wallets; if any is low, call the team faucet, wait, re-check. Exit 0 only
// when every wallet is funded — the Jenkins test stages run after this.
const WALLETS = (process.env.V10_TESTNET_WALLETS || '0x457759127Ff49F1668141FD69E16277560bF20Aa,0xb1D15B17e6766e05A4f583ccE92B357f96015737,0x92c6db7e977F782101d794A7e1222acc95630617').split(',');
const RPC = process.env.V10_TESTNET_RPC || 'https://base-sepolia-rpc.publicnode.com';
const TRAC = process.env.V10_TESTNET_TRAC || '0x2A58BdD13176D85906D804cdbFFA0D9119282DC8';
const MIN_ETH = BigInt(process.env.V10_MIN_ETH_WEI || 5e14);   // 0.0005 ETH
const MIN_TRAC = BigInt(process.env.V10_MIN_TRAC_WEI || 100n * 10n ** 18n); // 100 TRAC
const FAUCET = 'https://euphoria.origin-trail.network/faucet/fund';

const rpc = async (method, params) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return BigInt((await r.json()).result ?? '0x0');
};
const balances = async (w) => ({
  eth: await rpc('eth_getBalance', [w, 'latest']),
  trac: await rpc('eth_call', [{ to: TRAC, data: '0x70a08231' + w.slice(2).toLowerCase().padStart(64, '0') }, 'latest']),
});
const fmt = (v) => (Number(v) / 1e18).toFixed(4);
const check = async () => {
  const low = [];
  for (const w of WALLETS) {
    const b = await balances(w);
    const ok = b.eth >= MIN_ETH && b.trac >= MIN_TRAC;
    console.log(`${w}: ${fmt(b.eth)} ETH, ${fmt(b.trac)} TRAC ${ok ? '✅' : '❌ LOW'}`);
    if (!ok) low.push(w);
  }
  return low;
};

let low = await check();
if (low.length) {
  console.log(`\nFunding ${low.length} wallet(s) via faucet...`);
  const r = await fetch(FAUCET, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `v10-fund-${Date.now()}` },
    body: JSON.stringify({ mode: 'v10_base_sepolia', wallets: low }) });
  const res = await r.json().catch(() => ({}));
  console.log(`Faucet: ${JSON.stringify(res.summary || res).slice(0, 200)}`);
  await new Promise((r) => setTimeout(r, 30000)); // let txs mine
  low = await check();
}
if (low.length) { console.error(`\n❌ Still underfunded after faucet: ${low.join(', ')}`); process.exit(1); }
console.log('\n✅ All wallets funded — tests may start.');
