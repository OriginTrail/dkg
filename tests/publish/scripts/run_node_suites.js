import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { join } from 'path';
import { getSuiteDefinition, CHAIN_SUITE_MANIFEST } from '../src/suite-manifest.js';

const publishRoot = fileURLToPath(new URL('..', import.meta.url));
const mochaBin = fileURLToPath(new URL('../node_modules/mocha/bin/mocha.js', import.meta.url));

function runMochaSuite({ spec, node }) {
  const result = spawnSync(
    process.execPath,
    [
      mochaBin,
      join(publishRoot, spec),
      '--reporter',
      'mochawesome',
      '--reporter-options',
      `reportFilename=${node.reportFilename}`,
      '--exit',
    ],
    {
      cwd: publishRoot,
      env: { ...process.env, NODE_TO_TEST: node.name },
      stdio: 'inherit',
    },
  );
  return { status: result.status, error: result.error?.message };
}

export function runNodeSuites(
  groupName,
  runSuite = runMochaSuite,
  logger = console,
  requestedNode = '',
) {
  let suite;
  try {
    suite = getSuiteDefinition(groupName);
  } catch (error) {
    logger.error(error.message);
    return 2;
  }

  const nodes = requestedNode
    ? suite.nodes.filter((node) => node.name === requestedNode)
    : suite.nodes;
  if (nodes.length === 0) {
    logger.error(`Unknown node "${requestedNode}" for ${groupName}. Choose: ${suite.nodes.map((node) => node.name).join(', ')}`);
    return 2;
  }

  const failures = [];
  for (const node of nodes) {
    logger.log(`\n▶ Running ${groupName} / ${node.name}`);
    const result = runSuite({ groupName, spec: suite.spec, node });
    if (result.error || result.status !== 0) {
      failures.push({ node: node.name, status: result.status, error: result.error });
    }
  }

  if (failures.length > 0) {
    logger.error('\n❌ One or more node suites failed:');
    for (const failure of failures) {
      logger.error(` - ${failure.node}: ${failure.error || `exit ${failure.status}`}`);
    }
    return 1;
  }

  logger.log(`\n✅ All ${nodes.length} node suite(s) passed`);
  return 0;
}

export { CHAIN_SUITE_MANIFEST };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runNodeSuites(process.argv[2], runMochaSuite, console, process.argv[3]);
}
