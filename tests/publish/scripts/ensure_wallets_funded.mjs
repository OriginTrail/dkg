// Pre-test funding gate (Base Sepolia). Discovers EVERY operational wallet
// from each test node's own /api/wallets (nodes rotate signers across their
// whole pool — funding only known wallets leaves rotation landing on drained
// pool-mates, the exact mainnet insufficient-funds bug). Falls back to the
// static list when a node is unreachable. Low wallets → faucet → re-check.
const NODES = [
  { name: 'TestNode1', url: process.env.TESTNET1_API_URL || 'http://100.99.142.87:9200',  token: process.env.V10_TOKEN_TESTNET1 },
  { name: 'TestNode2', url: process.env.TESTNET2_API_URL || 'http://100.70.65.41:9200',   token: process.env.V10_TOKEN_TESTNET2 },
  { name: 'TestNode3', url: process.env.TESTNET3_API_URL || 'http://100.120.12.74:9200', token: process.env.V10_TOKEN_TESTNET3 },
  { name: 'TestNode4', url: process.env.TESTNET4_API_URL || 'http://100.65.228.120:9200', token: process.env.V10_TOKEN_TESTNET4 },
];
const FALLBACK = (process.env.V10_TESTNET_WALLETS || '0x4c92AeE34BAd19c3C51B632A0d48872dbDb02495,0xE3808e734cC77F63369D59365ef2bB0E2Adb3B3f,0xac7089c953e213A0D4Bb03B7799Ae1E08046b4A4,0xc3252faBEb9Be99dfc4a0614E493bb6149eBBD60,0x6A0d08372b3889123EAf586F8cd29b4C8e698049,0x8cc06bC44815BC52f6f27eef2D74ae2A94DbBFcb,0xA218C803fc77a2f5d68cDf3919b3980d1B082Ea4,0x3DE7e0Ac72C0936EaF9C81eC004aEE163A6a4884,0xB5D93553a96793888234fAF481b2EFa7d137b92c,0xa441223110d8F8CE31aFB45231E05Bb693b76D6C,0x07FF950cbAF5c0b282B0D55fdD73668dd108366B,0x15eEC4304B28BffD90e7bd8BcA6E6b200813e03D,0x93d425f279f3D655Ec114eB985cA99616569439F,0xac801E2C5143c21dFe7026fF1E277312fcd4adff').split(',');
const RPC = process.env.V10_TESTNET_RPC || 'https://base-sepolia-rpc.publicnode.com';
const TRAC = process.env.V10_TESTNET_TRAC || '0x2A58BdD13176D85906D804cdbFFA0D9119282DC8';
const MIN_ETH = BigInt(process.env.V10_MIN_ETH_WEI || 5e14);
const MIN_TRAC = BigInt(process.env.V10_MIN_TRAC_WEI || 100n * 10n ** 18n);
const FAUCET = 'https://euphoria.origin-trail.network/faucet/fund';

// pull every 0x-address out of any /api/wallets response shape
const extractAddrs = (x, out = new Set()) => {
  if (typeof x === 'string') { const m = x.match(/^0x[0-9a-fA-F]{40}$/); if (m) out.add(x); }
  else if (Array.isArray(x)) x.forEach((v) => extractAddrs(v, out));
  else if (x && typeof x === 'object') Object.values(x).forEach((v) => extractAddrs(v, out));
  return out;
};

const wallets = new Set();
for (const n of NODES) {
  try {
    const r = await fetch(`${n.url}/api/wallets`, { headers: n.token ? { Authorization: `Bearer ${n.token}` } : {}, signal: AbortSignal.timeout(15000) });
    const found = [...extractAddrs(await r.json())];
    found.forEach((a) => wallets.add(a));
    console.log(`${n.name}: discovered ${found.length} wallet(s) from /api/wallets`);
  } catch (e) {
    console.log(`${n.name}: /api/wallets unreachable (${String(e.message).slice(0, 60)}) — using fallback list`);
  }
}
if (wallets.size === 0) FALLBACK.forEach((a) => wallets.add(a));
else FALLBACK.forEach((a) => wallets.add(a)); // union: never lose the known ones
console.log(`Checking ${wallets.size} wallet(s) total\n`);

const rpc = async (method, params) => {
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return BigInt((await r.json()).result ?? '0x0');
};
const fmt = (v) => (Number(v) / 1e18).toFixed(4);
const check = async () => {
  const low = [];
  for (const w of wallets) {
    const eth = await rpc('eth_getBalance', [w, 'latest']);
    const trac = await rpc('eth_call', [{ to: TRAC, data: '0x70a08231' + w.slice(2).toLowerCase().padStart(64, '0') }, 'latest']);
    const ok = eth >= MIN_ETH && trac >= MIN_TRAC;
    console.log(`${w}: ${fmt(eth)} ETH, ${fmt(trac)} TRAC ${ok ? '✅' : '❌ LOW'}`);
    if (!ok) low.push(w);
  }
  return low;
};

let low = await check();
if (low.length) {
  console.log(`\nFunding ${low.length} wallet(s) via faucet (batches of 4 — API cap)...`);
  for (let i = 0; i < low.length; i += 4) {
    const batch = low.slice(i, i + 4);
    const r = await fetch(FAUCET, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `v10-fund-${Date.now()}-${i}` },
      body: JSON.stringify({ mode: 'v10_base_sepolia', wallets: batch }) });
    console.log(`Faucet batch ${i / 4 + 1}: ${JSON.stringify((await r.json().catch(() => ({}))).summary || {}).slice(0, 150)}`);
  }
  await new Promise((r) => setTimeout(r, 30000));
  low = await check();
}
if (low.length) { console.error(`\n❌ Still underfunded: ${low.join(', ')}`); process.exit(1); }
console.log('\n✅ All wallets funded — tests may start.');
