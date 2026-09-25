// Devnet/E2E-ONLY Hardhat config. Used solely by the throwaway local devnet that the
// node-ui Playwright suite boots via scripts/devnet.sh -- never for production deploys.
//
// Why it exists: @openzeppelin/contracts is pinned to 5.4.0 (pnpm-lock.yaml). Its
// utils/Bytes.sol declares `pragma solidity ^0.8.24` and emits the `mcopy` opcode
// (EIP-5656), so compiling + executing the deployed bytecode needs a >=0.8.24 solc on
// the Cancun EVM. Production contracts stay pinned to solc 0.8.20 / london in
// hardhat.node.config.ts (deployed-bytecode stability); this file overrides that ONLY
// for the disposable devnet.
//
// solc 0.8.24 is the correct target: it satisfies OZ's ^0.8.24 + mcopy AND -- unlike
// 0.8.26/0.8.27/0.8.28 -- compiles KnowledgeAssetsLifecycle.sol without hitting
// "stack too deep by 1 slot", a solc-0.8.26 IR-codegen regression at the same source
// site. Previously the Jenkins pipeline sed-patched hardhat.node.config.ts at build
// time; this config version-controls that workaround so CI no longer needs the hack.
import baseConfig from './hardhat.node.config';

// This file is nothing more than the base config plus ONE devnet override
// (solc 0.8.24 + cancun EVM target for the compiler). The in-process chain's
// hardfork is deliberately NOT overridden: it is INHERITED from the base config
// so the devnet chain can never silently drift behind the unit-test chain (it
// used to pin `cancun`, which was a bump while the base was `shanghai` and
// became a downgrade once the base moved to `prague`). mcopy (EIP-5656) is what
// the devnet actually needs at EXECUTION time, and every fork from cancun onward
// executes it -- asserted below rather than assumed. It is COMPOSED from clones
// -- the imported base config object is never mutated -- so loading both configs
// in one process can never cross-contaminate them.
//
// The base config's relevant shape is asserted at load time instead of being
// silently assumed: if hardhat.node.config ever moves to multiple compilers,
// an overrides-only `solidity` shape, or drops the in-process hardhat network,
// this file THROWS with instructions rather than quietly overriding whichever
// object happens to sit at `compilers[0]`.
const baseSolidity = baseConfig.solidity as
  | { compilers?: Array<{ version: string; settings?: Record<string, unknown> }> }
  | undefined;
if (!baseSolidity?.compilers || baseSolidity.compilers.length !== 1) {
  throw new Error(
    'hardhat.devnet.config.ts expects hardhat.node.config.ts to export exactly ONE solc ' +
      `compiler (found ${baseSolidity?.compilers?.length ?? 'none'}). The devnet override ` +
      'retargets that single compiler to solc 0.8.24/cancun -- update this file to mirror ' +
      'the new base `solidity` shape before booting the devnet.',
  );
}
const [baseCompiler] = baseSolidity.compilers;

const baseHardhatNetwork = (baseConfig.networks as { hardhat?: Record<string, unknown> } | undefined)
  ?.hardhat;
if (!baseHardhatNetwork) {
  throw new Error(
    'hardhat.devnet.config.ts expects hardhat.node.config.ts to define `networks.hardhat` ' +
      '(the in-process devnet chain that must execute the mcopy bytecode this config ' +
      'compiles). Update this file to mirror the new base `networks` shape before booting ' +
      'the devnet.',
  );
}
// Forks that implement mcopy (EIP-5656). An unknown name fails CLOSED: the
// devnet would deploy bytecode the chain cannot execute, which surfaces as an
// opaque deploy-time revert rather than a config error.
const MCOPY_CAPABLE_HARDFORKS = ['cancun', 'prague', 'osaka'];
const baseHardfork = baseHardhatNetwork.hardfork;
if (typeof baseHardfork !== 'string' || !MCOPY_CAPABLE_HARDFORKS.includes(baseHardfork)) {
  throw new Error(
    `hardhat.devnet.config.ts inherits the in-process chain's hardfork from ` +
      `hardhat.node.config.ts, which currently sets ${String(baseHardfork)}. The devnet ` +
      'compiles OZ 5.4.0 to the cancun EVM target and needs a fork that executes mcopy ' +
      `(one of ${MCOPY_CAPABLE_HARDFORKS.join(', ')}). Raise the base hardfork, or add the ` +
      'newer fork name to MCOPY_CAPABLE_HARDFORKS here.',
  );
}

export default {
  ...baseConfig,
  solidity: {
    ...baseSolidity,
    compilers: [
      {
        ...baseCompiler,
        version: '0.8.24',
        // Keep the base optimizer/viaIR settings; only retarget the EVM.
        settings: { ...baseCompiler.settings, evmVersion: 'cancun' },
      },
    ],
  },
  // The in-process chain is taken from the base config verbatim -- including its
  // hardfork, asserted mcopy-capable above.
  networks: { ...baseConfig.networks },
  // Isolate the devnet's compile outputs so the 0.8.24/cancun bytecode this
  // config produces never overwrites the production 0.8.20/london artifacts in
  // the shared checkout: a UI-test devnet boot must not leave stale/foreign
  // build-info + artifacts that a later non-devnet `hardhat` task would pick up
  // (otReviewAgent #1403 P3). Only cache/artifacts are redirected; sources,
  // tests and deploy roots stay on the base paths.
  paths: {
    ...((baseConfig as { paths?: Record<string, unknown> }).paths ?? {}),
    cache: './cache-devnet',
    artifacts: './artifacts-devnet',
  },
};
