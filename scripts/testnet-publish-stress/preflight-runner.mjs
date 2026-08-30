const DEFAULT_RUN_ID = '26may';

function bar(log, label) {
  log(`\n=== ${label} ===`);
}

/**
 * Run the publish-stress preflight without owning transport or process state.
 *
 * @param {object} options
 * @param {(method: string, path: string, body?: unknown) => Promise<{ok: boolean, status: number, json: any}>} options.apiCall
 * @param {string} options.expectedNetworkId
 * @param {string} [options.runId]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{exitCode: number, reason: string, resolvedCgId?: string | null, onChainId?: string | null}>}
 */
export async function runPreflight({
  apiCall,
  expectedNetworkId,
  runId = DEFAULT_RUN_ID,
  log = console.error,
}) {
  const cgShortId = `miles-publish-stress-${runId}`;
  const cgName = `Miles publish stress (${runId})`;
  const cgDescription =
    'Auto-created by scripts/testnet-publish-stress/preflight.mjs. ' +
    'Hosts a stream of Wikidata-music KCs published from Miles\' edge node ' +
    'against Base Sepolia (84532) to stress-test V10 publishing + give the ' +
    'on-chain RandomSampling prover something to sample.';

  bar(log, '1. Daemon status');
  const status = await apiCall('GET', '/api/status');
  if (!status.ok) {
    log(`status failed: HTTP ${status.status}`);
    return { exitCode: 1, reason: 'status_failed' };
  }
  const daemon = status.json;
  log(`name=${daemon.name} version=${daemon.version} role=${daemon.nodeRole} network=${daemon.networkName} identity=${daemon.identityId} (has=${daemon.hasIdentity}) peers=${daemon.connectedPeers}`);
  if (daemon.networkId !== expectedNetworkId) {
    log(`WARN: networkId=${daemon.networkId} expected ${expectedNetworkId} (DKG V10 Testnet). Aborting.`);
    return { exitCode: 2, reason: 'network_mismatch' };
  }

  bar(log, '2. Wallets');
  const wallets = await apiCall('GET', '/api/wallets/balances');
  if (!wallets.ok) {
    log(`wallets failed: HTTP ${wallets.status}`);
    return { exitCode: 1, reason: 'wallets_failed' };
  }
  for (const wallet of wallets.json.balances) {
    log(`  ${wallet.address}  ETH=${wallet.eth}  ${wallet.symbol}=${wallet.trac}`);
  }
  const tracTotal = wallets.json.balances.reduce((sum, wallet) => sum + parseFloat(wallet.trac), 0);
  const ethTotal = wallets.json.balances.reduce((sum, wallet) => sum + parseFloat(wallet.eth), 0);
  log(`  TOTAL  ETH=${ethTotal.toFixed(6)}  ${wallets.json.symbol}=${tracTotal.toFixed(4)}`);
  log(`  RPC: ${wallets.json.rpcUrl}  chain=${wallets.json.chainId}`);
  if (tracTotal < 50) {
    log('ERROR: total TRAC < 50; cannot proceed. Top up the operational wallets.');
    return { exitCode: 2, reason: 'insufficient_trac' };
  }

  bar(log, '3. List existing context graphs');
  let alreadyExists = false;
  let resolvedCgId = null;
  let onChainId = null;
  const contextGraphs = await apiCall('GET', '/api/context-graph/list');
  if (contextGraphs.ok && Array.isArray(contextGraphs.json.contextGraphs)) {
    const match = contextGraphs.json.contextGraphs.find(
      (cg) => cg.id === cgShortId || cg.id?.endsWith(`/${cgShortId}`),
    );
    if (match) {
      alreadyExists = true;
      resolvedCgId = match.id;
      onChainId = match.onChainId;
      log(`  Already present: id=${resolvedCgId} onChainId=${onChainId ?? '(local-only)'}`);
    } else {
      log(`  ${contextGraphs.json.contextGraphs.length} other CG(s) present; '${cgShortId}' not yet created.`);
    }
  } else {
    log('  (no /api/context-graph/list response — will attempt create anyway)');
  }

  if (!alreadyExists) {
    bar(log, '4. Create context graph + register on-chain');
    const create = await apiCall('POST', '/api/context-graph/create', {
      id: cgShortId,
      name: cgName,
      description: cgDescription,
      accessPolicy: 0,
      publishPolicy: 1,
      register: true,
    });
    if (!create.ok) {
      log(`create failed: HTTP ${create.status}: ${JSON.stringify(create.json).slice(0, 500)}`);
      return { exitCode: 1, reason: 'create_failed' };
    }
    if (create.json.registered === false) {
      log(`CG created LOCALLY only — on-chain register failed: ${create.json.registerError}`);
      log('Cannot publish without on-chain CG. Investigate before continuing.');
      return { exitCode: 2, reason: 'registration_failed' };
    }
    resolvedCgId = create.json.created;
    onChainId = create.json.onChainId;
    log(`  Created and registered: id=${resolvedCgId} onChainId=${onChainId} uri=${create.json.uri}`);
  }

  bar(log, '5. Resolved CG ID for publish-loop');
  log(`  CG short id : ${cgShortId}`);
  log(`  CG full id  : ${resolvedCgId}`);
  log(`  On-chain id : ${onChainId}`);
  log('');
  log('Plumb into publish-loop.mjs via:');
  log(`  export CG_ID=${resolvedCgId}`);
  log('');
  log('Next step:');
  log(`  CG_ID=${resolvedCgId} PHASE=calibrate node scripts/testnet-publish-stress/publish-loop.mjs`);

  return {
    exitCode: 0,
    reason: 'ready',
    resolvedCgId,
    onChainId,
  };
}
