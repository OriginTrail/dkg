# `src/archive/` — V8/V9 source snapshots (read-only)

Files in this directory are **NOT imported anywhere** in the live build.
They are point-in-time snapshots of EVMChainAdapter / MockChainAdapter /
NoChainAdapter methods that were archived during the V10-only migration
(issue 0004 of `archive-non-v10-contracts`).

Why keep them around at all?
- Reviewers can diff future V10 NFT-backed surfaces against the V9 PCA /
  V8 Staking shapes without spelunking the git history.
- The `.ai/decisions.md` ADR for "kill V8/V9 back-compat" links these
  snapshots as evidence of the surface that was removed.

The chain `tsconfig.json` excludes this directory from the TS compile so
the snapshots never participate in `pnpm -r build`. Each file carries
`// @ts-nocheck` defensively in case the exclude is forgotten.

If you find yourself wanting to import from here: don't. Open a feature
PR to re-add the surface in V10 shape instead — see PRD §6 followups for
the explicit list of V10 NFT-backed methods that still need adapter
coverage.
