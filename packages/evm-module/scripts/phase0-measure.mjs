// Phase-0 measurement for the scalable-weighted-CG-sampling RFC.
// Read-only. Measures, against a live network:
//   cgCount   = ContextGraphStorage.getLatestContextGraphId()
//   D[cg]     = currentEpoch - ContextGraphValueStorage.cgLastFinalizedEpoch(cg)   (replay depth)
//   weight[cg]= ContextGraphValueStorage.getCGValueAtEpoch(cg, currentEpoch)
//   active[cg]= ContextGraphStorage.isContextGraphActive(cg)
// and cross-checks Sigma(weight) vs getTotalValueAtEpoch(currentEpoch).
//
// Usage: node scripts/phase0-measure.mjs            (defaults to base_sepolia_v10)
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const evmDir = path.resolve(__dirname, '..');
// .env resolution: explicit DOTENV_CONFIG_PATH wins, else the package-local .env. (A fresh
// worktree may have no .env — it's gitignored — so point DOTENV_CONFIG_PATH at your env file.)
for (const p of [process.env.DOTENV_CONFIG_PATH, path.join(evmDir, '.env')].filter(Boolean)) {
  if (fs.existsSync(p)) { dotenv.config({ path: p }); break; }
}

const NETWORK = process.env.PHASE0_NETWORK || 'base_sepolia_v10';
const RPC = process.env.RPC_BASE_SEPOLIA_V10;
if (!RPC) { console.error('Missing RPC_BASE_SEPOLIA_V10'); process.exit(1); }

const dep = JSON.parse(
  fs.readFileSync(path.join(evmDir, `deployments/${NETWORK}_contracts.json`)),
).contracts;
const addrOf = (n) => (typeof dep[n] === 'string' ? dep[n] : dep[n].evmAddress || dep[n].address);

const provider = new ethers.JsonRpcProvider(RPC);
const cgs = new ethers.Contract(addrOf('ContextGraphStorage'), [
  'function getLatestContextGraphId() view returns (uint256)',
  'function isContextGraphActive(uint256) view returns (bool)',
], provider);
const cgv = new ethers.Contract(addrOf('ContextGraphValueStorage'), [
  'function cgLastFinalizedEpoch(uint256) view returns (uint256)',
  'function getCGValueAtEpoch(uint256,uint256) view returns (uint256)',
  'function getTotalValueAtEpoch(uint256) view returns (uint256)',
], provider);
const chronos = new ethers.Contract(addrOf('Chronos'), [
  'function getCurrentEpoch() view returns (uint256)',
], provider);

const net = await provider.getNetwork();
const currentEpoch = await chronos.getCurrentEpoch();
const cgCountBn = await cgs.getLatestContextGraphId();
const N = Number(cgCountBn);
console.error(`network=${NETWORK} chainId=${net.chainId} currentEpoch=${currentEpoch} cgCount=${N}`);

const rows = new Array(N);
let next = 1;
const CONC = 16;
async function worker() {
  for (;;) {
    const cg = next++;
    if (cg > N) break;
    let lastFin = 0n, weight = 0n, active = false, err = '';
    try { lastFin = await cgv.cgLastFinalizedEpoch(cg); } catch { err += 'L'; }
    try { weight = await cgv.getCGValueAtEpoch(cg, currentEpoch); } catch { err += 'W'; }
    try { active = await cgs.isContextGraphActive(cg); } catch { err += 'A'; }
    rows[cg - 1] = { cg, D: Number(currentEpoch - lastFin), weight, active, err };
    if (cg % 200 === 0) console.error(`  ...${cg}/${N}`);
  }
}
await Promise.all(Array.from({ length: Math.min(CONC, Math.max(N, 1)) }, worker));

const valid = rows.filter(Boolean);
const Ds = valid.map((r) => r.D).sort((a, b) => a - b);
const pct = (p) => (Ds.length ? Ds[Math.min(Ds.length - 1, Math.floor((p / 100) * Ds.length))] : 0);
const sum = (a) => a.reduce((x, y) => x + y, 0n);
const totalW = sum(valid.map((r) => r.weight));
const activeW = sum(valid.filter((r) => r.active).map((r) => r.weight));
const nonzero = valid.filter((r) => r.weight > 0n).length;
const activeCnt = valid.filter((r) => r.active).length;
const errCnt = valid.filter((r) => r.err).length;
let globalTotal = 0n; try { globalTotal = await cgv.getTotalValueAtEpoch(currentEpoch); } catch {}

const bucket = (d) => (d === 0 ? '0' : d === 1 ? '1' : d <= 5 ? '2-5' : d <= 20 ? '6-20' : d <= 100 ? '21-100' : d <= 1000 ? '101-1000' : '1000+');
const histo = {};
for (const d of Ds) histo[bucket(d)] = (histo[bucket(d)] || 0) + 1;
const order = ['0', '1', '2-5', '6-20', '21-100', '101-1000', '1000+'];

const out = [];
out.push(`# Phase-0 measurement — RandomSampling weighted-CG sampling`);
out.push('');
out.push(`- **Network:** \`${NETWORK}\` (chainId ${net.chainId}) — pre-mainnet; no mainnet deployment exists yet`);
out.push(`- **currentEpoch:** ${currentEpoch}`);
out.push(`- **cgCount (getLatestContextGraphId):** ${N}`);
out.push(`- **active CGs:** ${activeCnt} / ${N}  (inactive: ${N - activeCnt})`);
out.push(`- **CGs with nonzero current-epoch weight:** ${nonzero}`);
out.push(`- **read errors:** ${errCnt}`);
out.push('');
out.push(`## D = currentEpoch − cgLastFinalizedEpoch  (per-CG SLOAD replay depth)`);
out.push('');
out.push(`min=${Ds[0] ?? 0}  p50=${pct(50)}  p90=${pct(90)}  p99=${pct(99)}  max=${Ds[Ds.length - 1] ?? 0}`);
out.push('');
out.push(`| D bucket | CGs |`);
out.push(`|---|---|`);
for (const b of order) if (histo[b]) out.push(`| ${b} | ${histo[b]} |`);
out.push('');
out.push(`## Weight (active TRAC/epoch) cross-check`);
out.push('');
out.push(`- Σ weight (all CGs):    ${totalW}`);
out.push(`- Σ weight (active CGs): ${activeW}`);
out.push(`- getTotalValueAtEpoch:  ${globalTotal}   ${activeW === globalTotal ? '✅ matches active Σ' : '⚠️ differs'}`);
out.push('');
out.push(`## Worst-case scan cost implied (status quo)`);
out.push(`Leading-order draw SLOADs ≈ R·2·Σ(1+(1+D)), R≤5. At N=${N} this is small; the cliff is in the projection to 5k–100k CGs with a growing D tail.`);
out.push('');

const mdPath = path.join(evmDir, '..', '..', 'docs', 'rfcs', 'phase0-measurement-base-sepolia.md');
fs.writeFileSync(mdPath, out.join('\n'));
console.error(`\nWrote ${mdPath}`);
console.log(out.join('\n'));
