export const RUNTIME_BUILD_ROOTS = Object.freeze([
  '@origintrail-official/dkg-core',
  '@origintrail-official/dkg-storage',
  '@origintrail-official/dkg-query',
  '@origintrail-official/dkg-publisher',
  '@origintrail-official/dkg-chain',
  '@origintrail-official/dkg-epcis',
  '@origintrail-official/dkg-okf',
  '@origintrail-official/dkg-random-sampling',
  '@origintrail-official/dkg-semantic-runtime',
  '@origintrail-official/dkg-agent',
  '@origintrail-official/dkg-graph-viz',
  '@origintrail-official/dkg-node-ui',
  '@origintrail-official/dkg-adapter-openclaw',
  '@origintrail-official/dkg-adapter-hermes',
  '@origintrail-official/kafka-plugin',
  '@origintrail-official/dkg',
]);

// The chain package declares the EVM workspace as an optional dependency, but
// node hosts consume committed ABIs and must not compile Solidity at runtime.
export const RUNTIME_BUILD_EXCLUSIONS = Object.freeze([
  '@origintrail-official/dkg-evm-module',
]);

export function runtimeBuildFilterArgs() {
  return [
    '-r',
    ...RUNTIME_BUILD_ROOTS.flatMap((packageName) => ['--filter', `${packageName}...`]),
    ...RUNTIME_BUILD_EXCLUSIONS.flatMap((packageName) => ['--filter', `!${packageName}`]),
  ];
}

export function runtimeBuildPnpmArgs(operation = ['run', 'build']) {
  return [...runtimeBuildFilterArgs(), ...operation];
}
