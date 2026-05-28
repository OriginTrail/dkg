# @origintrail-official/dkg-evm-module

DKG smart contracts and deployment scripts for the current V10 node. This is a Hardhat project — it compiles Solidity, runs tests, and deploys to EVM chains.

## Features

- **Solidity contracts** — Knowledge Collection registry, contextGraph management, staking, token contracts, and access control
- **ABI exports** — compiled contract ABIs available at `./abi/*.json` for use by `@origintrail-official/dkg-chain`
- **Hardhat deployment** — deploy scripts for localhost, testnet (Base Sepolia), and other EVM chains
- **Test suite** — unit and integration tests via Hardhat's testing framework

## Usage

This package is consumed as an ABI source by `@origintrail-official/dkg-chain`. You don't need to interact with it directly unless you're modifying or deploying contracts.

```bash
# Compile contracts
pnpm build

# Run tests
pnpm test

# Deploy to localhost (requires a running Hardhat node)
pnpm deploy:localhost

# Deploy to testnet
pnpm deploy:testnet
```

## ABI Imports

```typescript
import HubAbi from '@origintrail-official/dkg-evm-module/abi/Hub.json';
import ContextGraphAbi from '@origintrail-official/dkg-evm-module/abi/ContextGraph.json';
```

## Committed ABIs are the runtime contract surface

The files under `abi/*.json` are checked into git and consumed at runtime by
`@origintrail-official/dkg-chain`. **Nodes never run `hardhat compile` during
install or auto-update** — neither `install.sh` nor `packages/cli/src/daemon/auto-update.ts`
invoke any `hardhat` command. This makes node updates fast and removes the most
failure-prone step (cold solc on small VPS / ARM64 used to OOM and abort the
slot swap).

That contract is enforced by the `abi-freshness` job in
`.github/workflows/ci.yml`: every PR that touches `contracts/`, `hardhat.*`,
or `package.json` runs `npx hardhat compile` (default config — picks up
`hardhat-abi-exporter`) and then `git diff --exit-code -- packages/evm-module/abi/`.
Any drift fails the PR with an explicit remediation message.

> Note: the package's `pnpm build` script intentionally runs Hardhat with
> `--config hardhat.node.config.ts`, which does **not** load
> `hardhat-abi-exporter`. Use `npx hardhat compile` (no `--config`) when you
> need to regenerate `abi/*.json`.

If you change a `.sol` file, regenerate and commit ABIs in the same change:

```bash
cd packages/evm-module && npx hardhat compile && cd -
git add packages/evm-module/abi/
```

## Static analysis

Three layered scanners run as informational checks in CI (`tornado-static-analysis` job in `.github/workflows/ci.yml`) and are wired up as local pnpm scripts. Findings surface in the GitHub **Security → Code scanning** tab; the CI lane is currently non-blocking so we can build a triage baseline before deciding what to ratchet.

| Tool | Purpose | Install |
|---|---|---|
| **Slither** | Mature Solidity static analyzer (Trail of Bits). Detects reentrancy, uninitialized storage, dangerous delegatecall, etc. | `pip install slither-analyzer` (Python). Requires `solc` 0.8.20 — install via [`solc-select`](https://github.com/crytic/solc-select) or rely on hardhat's bundled compiler. |
| **Aderyn** | Cyfrin's Rust-based analyzer, complementary detector set. | Already a devDep (`@cyfrin/aderyn`). `pnpm install` fetches the platform binary. |
| **solhint** | Solidity linter — style + a lightweight security ruleset. | Already a devDep (`solhint`). |

### Running locally

All scripts run from this package directory.

```bash
cd packages/evm-module

pnpm compile                  # populate cache/ + artifacts/ for Slither

pnpm slither                  # full Slither run (uses slither.config.json)
pnpm slither:reentrancy       # reentrancy-focused detector subset
pnpm slither:storage-layout   # printer: storage layout for upgrade-safety review
pnpm slither:sarif            # writes slither.sarif (what CI uploads)

pnpm aderyn                   # full Aderyn run, writes report.md
pnpm aderyn:sarif             # writes report.sarif (what CI uploads)

pnpm lint:sol                 # solhint (defaults stylish format)
pnpm lint:sol:fix             # solhint --fix
```

### Configuration files

- [`slither.config.json`](./slither.config.json) — pins solc 0.8.20 and excludes vendored deps (`contracts/.deps/`), archived contracts (`contracts/archive/`), mocks, and the standalone `tokens/` ERC1155Delta variants. **Do not** add `compile_force_framework: "hardhat"` — there's a known crytic-compile bug ([crytic/crytic-compile#570](https://github.com/crytic/crytic-compile/issues/570)) that breaks framework-forcing in projects with vendored deps.
- [`aderyn.toml`](./aderyn.toml) — same exclude paths.
- [`.solhint.json`](./.solhint.json) — `solhint:recommended` with `compiler-version: ^0.8.20` and a few overrides matching the V8 fork's tuning (allow inline assembly, don't warn on `block.timestamp`, etc.).
- [`.solhintignore`](./.solhintignore) — same exclude paths plus `Identity.sol` (excluded for the same viaIR-stack-depth reason it's excluded from `solidity-coverage` instrumentation in [`.solcover.js`](./.solcover.js)).

### Troubleshooting

- **`pnpm slither` errors on SlithIR translation under viaIR.** Hardhat's [own docs](https://v2.hardhat.org/hardhat-runner/docs/reference/solidity-support) caveat that viaIR integration "is less reliable" — Slither relies on Hardhat's compile output, so edge cases can leak through. Workaround: run with `pnpm slither -- --skip-assembly` (skips assembly-block analysis, which is where most viaIR stack-trace mismatches live). If that helps, switch the CI lane's `crytic/slither-action` step to pass `slither-args: --skip-assembly` and document which contract triggered it.
- **`pnpm aderyn` complains it can't find sources.** Aderyn auto-detects the project layout from `hardhat.config.ts`. If it can't, add `--src contracts/` explicitly. The hardhat config we ship works out of the box for Aderyn 0.6.x.
- **Adding new vendored deps under `contracts/.deps/` (or new mocks)** — update the same regex in `slither.config.json` (`filter_paths`), `.solhintignore`, and `aderyn.toml`. Slither's `filter_paths` is a regex, so escape `.` as `\\.`.

## Internal Dependencies

None — standalone Solidity/Hardhat project. Consumed by `@origintrail-official/dkg-chain`.
