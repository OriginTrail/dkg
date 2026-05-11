#!/usr/bin/env node
// One-shot devnet bootstrap that the user can run after `./scripts/devnet.sh start 6`.
//
//   1. Derives 10 delegator wallets from a deterministic mnemonic so the
//      operator can `Import wallet → secret recovery phrase` once into
//      MetaMask and see all 10 accounts.
//   2. Funds each wallet with 100 ETH (gas) + 25,000 TRAC (stake budget) via
//      Hardhat cheat-codes (no real mint waiting on chain).
//   3. Calls `DKGStakingConvictionNFT.createConviction(identityId, stake, tier)`
//      from each delegator across the 4 cores with a mixed tier spread so
//      the UI shows positions across the whole tier table (0/1/3/6/12).
//   4. Drives a small batch of named publishes through custodial agents on
//      core 1 + core 2 so RandomSampling actually has KCs to challenge
//      against — otherwise the prover loop just idles and the UI looks dead.
//   5. Writes `delegators.json` next to this script (mnemonic + per-wallet
//      privKey/address/identityId/tier/stake/tokenId/txHash) so the user has
//      a single artifact to grep through during UI testing.
//
// CJS so we can `require('ethers')` out of `packages/evm-module/node_modules/`
// without needing a per-experiment `pnpm install`.

const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '../..');
const EVM_PKG = path.join(REPO_ROOT, 'packages/evm-module');
const ethers = require(path.join(EVM_PKG, 'node_modules/ethers'));

const RPC = 'http://127.0.0.1:8545';
const DEVNET_DIR = path.join(REPO_ROOT, '.devnet');
const CONTRACTS_PATH = path.join(
  EVM_PKG,
  'deployments/localhost_contracts.json',
);
const OUT_PATH = path.join(__dirname, 'delegators.json');
const CONTEXT_GRAPH = 'devnet-test';

// Tier table baked into V10 ConvictionStakingStorage:
//   0 = no lock (1.0×)
//   1 = 1 month (1.5×)
//   3 = 3 months (2.0×)
//   6 = 6 months (3.0×)
//  12 = 12 months (5.0×)
// Rotate through all 5 so the UI shows every multiplier in use.
const TIERS = [0, 1, 3, 6, 12];
const NUM_DELEGATORS = 10;
const stakePerDelegatorTrac = (i) => 1000 + i * 250; // 1000, 1250, ..., 3250

// 5 publishes on core1, 5 on core2 — RS challenges land on at least
// two distinct provers without flooding the chain.
const PUBLISHES_CORE1 = 5;
const PUBLISHES_CORE2 = 5;

function log(msg) {
  console.log(`[bootstrap] ${msg}`);
}

function loadOrGenerateMnemonic() {
  if (fs.existsSync(OUT_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
      if (prev.mnemonic) {
        log(`Reusing mnemonic from ${OUT_PATH}`);
        return prev.mnemonic;
      }
    } catch {
      // fall through to fresh generation
    }
  }
  // 128-bit entropy → 12-word BIP39 mnemonic. ethers handles wordlist + checksum.
  const mnemonic = ethers.Mnemonic.fromEntropy(ethers.randomBytes(16)).phrase;
  log(`Generated fresh 12-word mnemonic`);
  return mnemonic;
}

function deriveWallet(mnemonic, index) {
  // Standard MetaMask path — m/44'/60'/0'/0/{index}.
  const hdPath = `m/44'/60'/0'/0/${index}`;
  return ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, hdPath);
}

async function nextNonceFor(provider, address) {
  const raw = await provider.send('eth_getTransactionCount', [address, 'pending']);
  return parseInt(raw, 16);
}

function readNodeConfig(num) {
  const home = path.join(DEVNET_DIR, `node${num}`);
  if (!fs.existsSync(home)) {
    throw new Error(`devnet node${num} home missing — start the devnet first`);
  }
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  let authToken = '';
  const tokenPath = path.join(home, 'auth.token');
  if (fs.existsSync(tokenPath)) {
    authToken =
      fs.readFileSync(tokenPath, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith('#')) || '';
  }
  return { num, home, apiPort: config.apiPort, authToken };
}

async function fetchIdentityId(node) {
  const res = await fetch(`http://127.0.0.1:${node.apiPort}/api/status`);
  if (!res.ok) throw new Error(`node${node.num} /api/status: ${res.status}`);
  const json = await res.json();
  return BigInt(json.identityId || 0);
}

// Mirror the v10-stress test: write the OZ ERC20 _balances slot directly
// (slot 1 on the production Token contract).
async function fundTokenBalance(provider, tokenAddress, recipient, amount) {
  const slotKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint256'],
      [recipient, 1n],
    ),
  );
  await provider.send('hardhat_setStorageAt', [
    tokenAddress,
    slotKey,
    ethers.zeroPadValue(ethers.toBeHex(amount), 32),
  ]);
}

async function main() {
  if (!fs.existsSync(CONTRACTS_PATH)) {
    throw new Error(
      `contracts deployment not found at ${CONTRACTS_PATH} — is the devnet running?`,
    );
  }
  const contractsJson = JSON.parse(fs.readFileSync(CONTRACTS_PATH, 'utf8'));
  const c = (name) => contractsJson.contracts && contractsJson.contracts[name] && contractsJson.contracts[name].evmAddress;

  const provider = new ethers.JsonRpcProvider(RPC, {
    chainId: 31337,
    name: 'localhost',
  });

  const tokenAddr = c('Token');
  const stakingV10Addr = c('StakingV10');
  const stakingNftAddr = c('DKGStakingConvictionNFT');
  const cssAddr = c('ConvictionStakingStorage');
  if (!tokenAddr || !stakingV10Addr || !stakingNftAddr || !cssAddr) {
    throw new Error('missing core contract addresses in localhost_contracts.json');
  }

  const token = new ethers.Contract(
    tokenAddr,
    [
      'function balanceOf(address) view returns (uint256)',
      'function approve(address,uint256) returns (bool)',
    ],
    provider,
  );
  const stakingNft = new ethers.Contract(
    stakingNftAddr,
    [
      'function createConviction(uint72,uint96,uint40) returns (uint256)',
      'function ownerOf(uint256) view returns (address)',
    ],
    provider,
  );
  const css = new ethers.Contract(
    cssAddr,
    ['function getNodeStakeV10(uint72) view returns (uint256)'],
    provider,
  );

  const cores = [];
  for (const n of [1, 2, 3, 4]) {
    const node = readNodeConfig(n);
    const idId = await fetchIdentityId(node);
    if (idId === 0n) {
      throw new Error(
        `core node ${n} has identityId=0 — devnet hasn't finished bootstrapping`,
      );
    }
    cores.push(Object.assign({}, node, { identityId: idId }));
  }
  log(`Cores: ${cores.map((cc) => `node${cc.num}@id=${cc.identityId}`).join(', ')}`);

  const mnemonic = loadOrGenerateMnemonic();
  const delegators = [];
  for (let i = 0; i < NUM_DELEGATORS; i++) {
    const hd = deriveWallet(mnemonic, i);
    const wallet = new ethers.Wallet(hd.privateKey, provider);
    const target = cores[i % cores.length];
    const tier = TIERS[i % TIERS.length];
    const stakeAmount = ethers.parseEther(String(stakePerDelegatorTrac(i)));
    delegators.push({
      index: i,
      address: wallet.address,
      privateKey: hd.privateKey,
      identityId: target.identityId.toString(),
      coreNum: target.num,
      tier,
      stakeAmount: stakeAmount.toString(),
      stakeAmountTRAC: stakePerDelegatorTrac(i),
      tokenId: null,
      stakeTxHash: null,
      _signer: wallet,
    });
  }

  log(`Funding ${NUM_DELEGATORS} delegators with 100 ETH + 25k TRAC each...`);
  const fundingTrac = ethers.parseEther('25000');
  for (const d of delegators) {
    await provider.send('hardhat_setBalance', [
      d.address,
      '0x' + ethers.parseEther('100').toString(16),
    ]);
    await fundTokenBalance(provider, tokenAddr, d.address, fundingTrac);
    const observedTrac = await token.balanceOf(d.address);
    if (observedTrac !== fundingTrac) {
      throw new Error(
        `funding ${d.address}: balance mismatch (got ${observedTrac}, want ${fundingTrac})`,
      );
    }
  }
  log(`  funded.`);

  log(`Staking — 10 createConviction calls across cores 1-4 (tier mix 0/1/3/6/12)...`);
  for (const d of delegators) {
    const w = d._signer;
    const stakeAmount = BigInt(d.stakeAmount);
    const approveTx = await token
      .connect(w)
      .approve(stakingV10Addr, stakeAmount, {
        nonce: await nextNonceFor(provider, w.address),
      });
    await approveTx.wait();
    const stakeTx = await stakingNft
      .connect(w)
      .createConviction(BigInt(d.identityId), stakeAmount, d.tier, {
        nonce: await nextNonceFor(provider, w.address),
      });
    const receipt = await stakeTx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`createConviction failed for delegator ${d.index}`);
    }
    const transferIface = new ethers.Interface([
      'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    ]);
    let tokenId = 0n;
    for (const lg of receipt.logs || []) {
      try {
        const parsed = transferIface.parseLog(lg);
        if (
          parsed && parsed.name === 'Transfer' &&
          parsed.args.from === '0x0000000000000000000000000000000000000000' &&
          parsed.args.to.toLowerCase() === w.address.toLowerCase()
        ) {
          tokenId = parsed.args.tokenId;
          break;
        }
      } catch {
        // skip non-Transfer
      }
    }
    if (tokenId === 0n) {
      throw new Error(`could not extract tokenId for delegator ${d.index}`);
    }
    d.tokenId = tokenId.toString();
    d.stakeTxHash = stakeTx.hash;
    log(
      `  #${d.index} → core${d.coreNum}@id=${d.identityId}, tier=${d.tier}, ` +
        `stake=${d.stakeAmountTRAC} TRAC, tokenId=${d.tokenId}`,
    );
  }

  log(`Reconciling per-core stake totals...`);
  const stakeByCore = {};
  for (const core of cores) {
    const s = await css.getNodeStakeV10(core.identityId);
    stakeByCore[`node${core.num}`] = ethers.formatEther(s) + ' TRAC';
  }

  log(`Driving demo publishes (${PUBLISHES_CORE1}+${PUBLISHES_CORE2}) for RS to chew on...`);
  const publishLog = [];
  for (const [coreIdx, count] of [
    [0, PUBLISHES_CORE1],
    [1, PUBLISHES_CORE2],
  ]) {
    const core = cores[coreIdx];
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      core.authToken ? { Authorization: `Bearer ${core.authToken}` } : {},
    );
    const agentName = `bootstrap-c${core.num}-${Date.now()}`;
    const regRes = await fetch(
      `http://127.0.0.1:${core.apiPort}/api/agent/register`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: agentName, framework: 'devnet-bootstrap' }),
      },
    );
    if (!regRes.ok) {
      throw new Error(
        `core${core.num} agent register failed: ${regRes.status} ${await regRes.text()}`,
      );
    }
    const agent = await regRes.json();
    const runTag = Math.random().toString(36).slice(2, 8);
    for (let i = 0; i < count; i++) {
      const name = `bootstrap-c${core.num}-${runTag}-${i}`;
      const ts = Date.now();
      const subject = `urn:bootstrap:c${core.num}:${name}`;
      const quads = [
        {
          subject,
          predicate: 'https://schema.org/name',
          object: `"${name}"`,
          graph: `did:dkg:context-graph:${CONTEXT_GRAPH}`,
        },
        {
          subject,
          predicate: 'https://schema.org/description',
          object: `"devnet bootstrap publish #${i} on core${core.num} @ ${ts}"`,
          graph: `did:dkg:context-graph:${CONTEXT_GRAPH}`,
        },
      ];
      const createRes = await fetch(
        `http://127.0.0.1:${core.apiPort}/api/assertion/create`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${agent.authToken}`,
          },
          body: JSON.stringify({
            name,
            contextGraphId: CONTEXT_GRAPH,
            quads,
            finalize: true,
            promote: true,
          }),
        },
      );
      if (!createRes.ok) {
        throw new Error(
          `create #${i} on core${core.num} failed: ${createRes.status} ${await createRes.text()}`,
        );
      }
      // 2s gap between back-to-back publishes — same workaround the
      // v10-stress test uses for the publisher nonce race.
      await new Promise((r) => setTimeout(r, 2000));
      const pubRes = await fetch(
        `http://127.0.0.1:${core.apiPort}/api/shared-memory/publish`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${agent.authToken}`,
          },
          body: JSON.stringify({
            contextGraphId: CONTEXT_GRAPH,
            assertionName: name,
          }),
        },
      );
      if (!pubRes.ok) {
        throw new Error(
          `publish #${i} on core${core.num} failed: ${pubRes.status} ${await pubRes.text()}`,
        );
      }
      let pubJson = await pubRes.json();
      if (pubJson.status === 'tentative' || pubJson.kcId === '0') {
        await new Promise((r) => setTimeout(r, 2000));
        const retry = await fetch(
          `http://127.0.0.1:${core.apiPort}/api/shared-memory/publish`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${agent.authToken}`,
            },
            body: JSON.stringify({
              contextGraphId: CONTEXT_GRAPH,
              assertionName: name,
            }),
          },
        );
        pubJson = await retry.json();
      }
      publishLog.push({
        core: core.num,
        name,
        kcId: pubJson.kcId || null,
        status: pubJson.status || 'unknown',
        author: pubJson.author || null,
      });
      log(
        `  publish core${core.num} #${i} → kcId=${pubJson.kcId || '?'}, status=${pubJson.status || '?'}`,
      );
    }
  }

  const out = {
    mnemonic,
    hdPath: "m/44'/60'/0'/0/{index}",
    delegators: delegators.map((d) => ({
      index: d.index,
      address: d.address,
      privateKey: d.privateKey,
      coreNum: d.coreNum,
      identityId: d.identityId,
      tier: d.tier,
      stakeAmountTRAC: d.stakeAmountTRAC,
      tokenId: d.tokenId,
      stakeTxHash: d.stakeTxHash,
    })),
    perCoreStake: stakeByCore,
    publishes: publishLog,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  log(`Wrote ${OUT_PATH}`);

  console.log('\n========================================================');
  console.log('  Devnet bootstrap complete');
  console.log('========================================================');
  console.log(`Mnemonic (import once into MetaMask, all 10 accounts appear):`);
  console.log(`  "${mnemonic}"`);
  console.log(`HD path: m/44'/60'/0'/0/{0..9}`);
  console.log('');
  console.log('Per-delegator stake:');
  for (const d of delegators) {
    console.log(
      `  #${d.index} ${d.address}  → core${d.coreNum}@id=${d.identityId}  ` +
        `tier=${d.tier}  stake=${d.stakeAmountTRAC} TRAC  tokenId=${d.tokenId}`,
    );
  }
  console.log('');
  console.log('Per-core total V10 stake:');
  for (const [k, v] of Object.entries(stakeByCore)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log('');
  console.log('Demo publishes (drives RS):');
  for (const p of publishLog) {
    console.log(
      `  core${p.core}  kcId=${p.kcId}  status=${p.status}  ${p.name}`,
    );
  }
  console.log('========================================================');
  console.log(`Full snapshot: ${OUT_PATH}`);
  console.log('========================================================\n');
}

main().catch((err) => {
  console.error('[bootstrap] FATAL:', err.stack || err.message || err);
  process.exit(1);
});
