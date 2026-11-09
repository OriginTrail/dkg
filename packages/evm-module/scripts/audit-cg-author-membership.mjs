#!/usr/bin/env node
/**
 * Read-only rollout audit for ContextGraphs 10.1.0 ("publishing requires
 * membership").
 *
 * After 10.1.0 a curated context graph binds a Knowledge Asset only when the
 * KA's attested author is a member: on the graph's participant roster, the
 * holder of its NFT, or (EOA / Safe curator mode) its curator. This script
 * lists, for every curated graph on a network, the authors of the KAs it
 * already holds (the author is `kaId >> 96`, OT-RFC-43) that the gate would
 * refuse on their next publish, so their graph's owner or curator can add them
 * to the roster before the Hub switches to the new facade.
 *
 * eth_call only: it uses no key and sends no transaction.
 *
 * Usage (from packages/evm-module):
 *   node scripts/audit-cg-author-membership.mjs <base_sepolia_v10|base_mainnet|gnosis_mainnet> [--rpc URL] [--json]
 * The endpoint defaults to RPC_<NETWORK> from the environment, then to the
 * network's public endpoint (as in hardhat.node.config.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const MODULE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NETWORKS = {
  base_sepolia_v10: { env: 'RPC_BASE_SEPOLIA_V10', rpc: 'https://sepolia.base.org' },
  base_mainnet: { env: 'RPC_BASE_MAINNET', rpc: 'https://mainnet.base.org' },
  gnosis_mainnet: { env: 'RPC_GNOSIS_MAINNET', rpc: 'https://rpc.gnosischain.com' },
};

const CONCURRENCY = 2;
const ATTEMPTS = 6;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Public endpoints throttle bursts, and some answer a throttled eth_call with a
 * bare revert. Retry anything but a revert that carries data (a real answer,
 * e.g. ERC721NonexistentToken), backing off from 0.5 s to 8 s.
 */
async function withRetry(read) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (err) {
      const revertData = err?.data && err.data !== '0x';
      if (revertData || attempt >= ATTEMPTS) throw err;
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
}

function parseArgs(argv) {
  const [network, ...rest] = argv;
  if (!NETWORKS[network]) {
    throw new Error(`usage: audit-cg-author-membership.mjs <${Object.keys(NETWORKS).join('|')}> [--rpc URL] [--json]`);
  }
  const rpcFlag = rest.indexOf('--rpc');
  const rpc = rpcFlag >= 0 ? rest[rpcFlag + 1] : process.env[NETWORKS[network].env] || NETWORKS[network].rpc;
  return { network, rpc, json: rest.includes('--json') };
}

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(MODULE_DIR, relative), 'utf8'));
}

/** Run `task` over `items` with at most CONCURRENCY in flight, keeping order. */
async function mapLimited(items, task) {
  const results = Array.from({ length: items.length });
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
}

const authorOf = (kaId) => ethers.getAddress(ethers.toBeHex(BigInt(kaId) >> 96n, 20));

async function auditGraph(storage, pcaNft, id) {
  let cg;
  try {
    cg = await withRetry(() => storage.getContextGraph(id));
  } catch (err) {
    return { id, unreadable: err.shortMessage ?? err.message };
  }
  const [owner, roster, , active, , accessPolicy, publishPolicy, authority, accountId] = cg;
  if (publishPolicy !== 0n) return { id, open: true, active };

  const members = new Set([owner, ...roster, ...(accountId === 0n ? [authority] : [])].map((a) => a.toLowerCase()));
  const kaIds = await withRetry(() => storage.getContextGraphKaList(id));
  const byAuthor = new Map();
  for (const kaId of kaIds) {
    const author = authorOf(kaId);
    byAuthor.set(author, (byAuthor.get(author) ?? 0) + 1);
  }
  const refused = [];
  for (const [author, kas] of byAuthor) {
    if (members.has(author.toLowerCase())) continue;
    // Is the refused author an agent of the graph's own PCA (the case the rule targets)?
    let agentOfGraphPca = false;
    if (accountId !== 0n && pcaNft) {
      agentOfGraphPca = (await withRetry(() => pcaNft.agentToAccountId(author))) === accountId;
    }
    refused.push({ author, kas, agentOfGraphPca });
  }
  return {
    id,
    active,
    accessPolicy: Number(accessPolicy),
    curator: accountId === 0n ? 'eoa-or-safe' : `pca:${accountId}`,
    rosterSize: roster.length,
    kaCount: kaIds.length,
    authors: byAuthor.size,
    refused,
  };
}

function summarize(network, latest, graphs) {
  const curated = graphs.filter((g) => !g.open && !g.unreadable);
  const affected = curated.filter((g) => g.refused.length > 0);
  const byCurator = {};
  for (const g of curated) {
    const key = g.curator === 'eoa-or-safe' ? 'eoa-or-safe' : 'pca';
    byCurator[key] ??= { graphs: 0, affectedGraphs: 0, refusedKas: 0, refusedAuthors: new Set(), refusedPcaAgents: new Set() };
    const row = byCurator[key];
    row.graphs += 1;
    if (g.refused.length > 0) row.affectedGraphs += 1;
    for (const r of g.refused) {
      row.refusedKas += r.kas;
      row.refusedAuthors.add(r.author);
      if (r.agentOfGraphPca) row.refusedPcaAgents.add(r.author);
    }
  }
  return {
    network,
    contextGraphs: latest,
    unreadable: graphs.filter((g) => g.unreadable).length,
    open: graphs.filter((g) => g.open).length,
    curated: curated.length,
    curatedWithKas: curated.filter((g) => g.kaCount > 0).length,
    affectedGraphs: affected.length,
    byCurator: Object.fromEntries(Object.entries(byCurator).map(([k, v]) => [k, {
      graphs: v.graphs,
      affectedGraphs: v.affectedGraphs,
      refusedKas: v.refusedKas,
      refusedAuthors: v.refusedAuthors.size,
      refusedAuthorsThatArePcaAgents: v.refusedPcaAgents.size,
    }])),
  };
}

async function main() {
  const { network, rpc, json } = parseArgs(process.argv.slice(2));
  const deployments = readJson(`deployments/${network}_contracts.json`).contracts;
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true });
  const storage = new ethers.Contract(
    deployments.ContextGraphStorage.evmAddress, readJson('abi/ContextGraphStorage.json'), provider,
  );
  const pcaNft = deployments.DKGPublishingConvictionNFT
    ? new ethers.Contract(
      deployments.DKGPublishingConvictionNFT.evmAddress, readJson('abi/DKGPublishingConvictionNFT.json'), provider,
    )
    : undefined;

  const latest = Number(await withRetry(() => storage.getLatestContextGraphId()));
  const ids = Array.from({ length: latest }, (_, i) => i + 1);
  const graphs = await mapLimited(ids, (id) => auditGraph(storage, pcaNft, id));
  const summary = summarize(network, latest, graphs);

  if (json) {
    console.log(JSON.stringify({ summary, graphs }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    return;
  }
  console.log(JSON.stringify(summary, null, 2));
  for (const g of graphs.filter((x) => x.refused?.length)) {
    console.log(
      `cg ${g.id} (${g.curator}, ${g.active ? 'active' : 'inactive'}, access ${g.accessPolicy}, roster ${g.rosterSize}): ` +
      g.refused.map((r) => `${r.author} ${r.kas} KA${r.kas === 1 ? '' : 's'}${r.agentOfGraphPca ? ' [agent of the graph\'s PCA]' : ''}`).join('; '),
    );
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
