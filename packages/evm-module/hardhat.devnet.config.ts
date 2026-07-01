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
import config from './hardhat.node.config';

// hardhat.node.config exports a single-compiler MultiSolc config; narrow to it so we can
// override the version/EVM target without disturbing the optimizer/viaIR settings.
const solc = (config.solidity as { compilers: Array<{ version: string; settings: Record<string, unknown> }> })
  .compilers[0];
solc.version = '0.8.24';
solc.settings = { ...solc.settings, evmVersion: 'cancun' };

// The local Hardhat chain must also EXECUTE the mcopy bytecode at deploy time, so bump
// the in-process network hardfork from shanghai to cancun (else deploy txs revert).
(config.networks as { hardhat: { hardfork: string } }).hardhat.hardfork = 'cancun';

export default config;
