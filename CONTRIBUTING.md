# Contributing to DKG V9

Thank you for your interest in contributing to the OriginTrail Decentralized Knowledge Graph!

## Getting Started

1. Fork this repository and clone your fork.
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Build all packages:
   ```bash
   pnpm build
   ```
4. Run tests:
   ```bash
   pnpm test
   ```

## Development Workflow

- Day-to-day work is merged to **`testnet-canary`** via pull requests, not to `main`.
  `testnet-canary` is promoted to `main` in periodic release PRs (see
  [Promoting `testnet-canary` to `main`](#promoting-testnet-canary-to-main)).
- All PRs must pass CI checks (build + tests) before merging.
- We use [Conventional Commits](https://www.conventionalcommits.org/) style messages:
  - `feat:` for new features
  - `fix:` for bug fixes
  - `docs:` for documentation changes
  - `refactor:` for code changes that neither fix bugs nor add features
  - `test:` for adding or updating tests
  - `chore:` for tooling, CI, or dependency changes

## Pull Request Process

1. Create a feature branch from `testnet-canary`:
   ```bash
   git fetch origin
   git checkout -b feat/your-feature origin/testnet-canary
   ```
2. Make your changes, ensuring tests pass locally.
3. Push and open a pull request against `testnet-canary`.
4. Fill in the PR template describing your changes.
5. Wait for at least one approval from a maintainer.

Keeping a long-lived branch current: **merge `testnet-canary` in, do not rebase.**
Rebasing re-anchors the commits a review was written against and orphans the
existing review threads.

```bash
git merge origin/testnet-canary
```

A branch that GitHub reports as `MERGEABLE / CLEAN` is only free of *textual*
conflicts. If its checks last ran hundreds of commits ago, they say nothing
about whether it still works — merge the base in and let CI re-run before
trusting a green tick.

## Promoting `testnet-canary` to `main`

`main` is the repository's default branch, and **GitHub only honours closing
keywords on a merge into the default branch.** A `Closes #123` in a PR that
targets `testnet-canary` therefore never fires: the fix ships, the issue stays
open, and nothing closes it retroactively when `testnet-canary` is later
promoted.

Left unattended this silently accumulates finished-but-open issues, which is
indistinguishable from a backlog of real bugs.

So the promotion PR body **must restate the closing keywords** for everything in
the promoted range. Generate the block with:

```bash
git fetch origin
for pr in $(git log --format=%s origin/main..origin/testnet-canary \
            | sed -nE 's/^Merge pull request #([0-9]+) .*/\1/p' | sort -un); do
  gh pr view "$pr" --repo OriginTrail/dkg --json number,body \
    --jq '"\(.number)\t\(.body // "" | gsub("\n";" "))"'
done | while IFS=$'\t' read -r num body; do
  printf '%s\n' "$body" \
    | grep -oiE '\b(clos(e|es|ed)|fix(e[sd])?|resolv(e|es|ed))[[:space:]]+#[0-9]+' \
    | grep -oE '[0-9]+' | sort -u | while read -r iss; do
        [ "$(gh issue view "$iss" --repo OriginTrail/dkg --json state --jq .state 2>/dev/null)" = "OPEN" ] \
          && echo "Closes #$iss  <!-- shipped in PR #$num -->"
      done
done | sort -u
```

Paste the output into the promotion PR description. Only still-open issues are
listed, so re-running it is safe. If a promotion has already merged without the
block, close those issues by hand and link the PR that fixed them.

## Monorepo Structure

This is a pnpm + Turborepo monorepo. Key commands:

```bash
pnpm build                          # Build all packages and the Node UI bundle
pnpm run build:packages             # Build workspace package outputs only; skips the Node UI bundle
pnpm run build -- --filter <pkg>    # Pass Turbo args through without the full Node UI bundle
pnpm test                           # Test all packages
pnpm --filter @origintrail-official/dkg-core test   # Test a specific package
```

See the [README](README.md) for the full package map.

## Reporting Bugs

Open a [GitHub Issue](https://github.com/OriginTrail/dkg-v9/issues/new) with:

- A clear title and description.
- Steps to reproduce.
- Expected vs actual behavior.
- Node version, OS, and DKG version (`dkg status`).

## Security Vulnerabilities

Please do **not** open public issues for security vulnerabilities. Instead, follow the [Security Policy](SECURITY.md).

## Code of Conduct

By participating in this project, you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
