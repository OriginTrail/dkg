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

- Work is merged to `main` via pull requests.
- All PRs must pass CI checks (build + tests) before merging.
- We use [Conventional Commits](https://www.conventionalcommits.org/) style messages:
  - `feat:` for new features
  - `fix:` for bug fixes
  - `docs:` for documentation changes
  - `refactor:` for code changes that neither fix bugs nor add features
  - `test:` for adding or updating tests
  - `chore:` for tooling, CI, or dependency changes

## Pull Request Process

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feat/your-feature
   ```
2. Make your changes, ensuring tests pass locally.
3. Push and open a pull request against `main`.
4. Fill in the PR template describing your changes.
5. Wait for at least one approval from a maintainer.

## Monorepo Structure

This is a pnpm + Turborepo monorepo. Key commands:

```bash
pnpm build                          # Build all packages
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
