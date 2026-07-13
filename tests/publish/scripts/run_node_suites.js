import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';

export const NODE_SUITE_GROUPS = {
  'base-mainnet': [
    'test:base:sbb:mainnet',
    'test:base:dmaast:mainnet',
  ],
  'gnosis-mainnet': [
    'test:gnosis:terminus:mainnet',
    'test:gnosis:rhodia:mainnet',
  ],
  'base-testnet': [
    'test:base:testnode1:testnet',
    'test:base:testnode2:testnet',
    'test:base:testnode3:testnet',
    'test:base:testnode4:testnet',
  ],
};

function runNpmScript(script) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCommand, ['run', script], {
    env: process.env,
    stdio: 'inherit',
  });
  return { status: result.status, error: result.error?.message };
}

export function runNodeSuites(groupName, runScript = runNpmScript, logger = console) {
  const scripts = NODE_SUITE_GROUPS[groupName];
  if (!scripts) {
    logger.error(`Unknown node-suite group "${groupName || ''}". Choose: ${Object.keys(NODE_SUITE_GROUPS).join(', ')}`);
    return 2;
  }

  const failures = [];
  for (const script of scripts) {
    logger.log(`\n▶ Running ${script}`);
    const result = runScript(script);
    if (result.error || result.status !== 0) {
      failures.push({ script, status: result.status, error: result.error });
    }
  }

  if (failures.length > 0) {
    logger.error('\n❌ One or more node suites failed:');
    for (const failure of failures) {
      logger.error(` - ${failure.script}: ${failure.error || `exit ${failure.status}`}`);
    }
    return 1;
  }

  logger.log(`\n✅ All ${scripts.length} node suites passed`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runNodeSuites(process.argv[2]);
}
