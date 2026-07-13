# PR #1564 review-fix validation (2026-07-10)

## Scope

This receipt covers the follow-up fixes added after review of PR #1564:

- active libp2p connections are included in the ACK candidate pool;
- async-promote queue reads share the queue lock with mutations;
- devnet process discovery and planned restart handling are deterministic;
- create/share validation keeps plans and accumulated responses file-backed;
- host-mode ciphertext stripping is gated by cached curation classification at
  both legacy and chunked dispatch boundaries;
- zero-row SWM promotion is reported as an advisory no-op rather than a share.

Validated code commits:

- `e8d1c36fe12a85d579d1868e4f2123c09d38e339`
- `6dc851d527fcc1382134fa5c87fcb8ba61d4f887`
- `a9ba702b7ea37d3b2aca37e207b52a78bf688089`
- `8e913f093dc157831f9c7ff3fcd5a7b094c4e68e`
- `da67392322853b1a709f83d02371d7418bcaf510`
- `3a8c77bd8a74ba0e9d52d98cf9f8fd5535d80086`

## Automated checks

| Check | Result |
| --- | --- |
| Agent unit suite | PASS: 33 files, 362 tests |
| Publisher async-promote queue suite | PASS: 65 tests |
| CLI helper and promote-route focused suites | PASS: 2 files, 6 tests |
| CLI knowledge-asset smoke suite, isolated | PASS: 13 tests |
| Large create/share helper fixture | PASS: 96 roots with about 2.3 MB accumulated response data |
| Agent build | PASS |
| CLI build | PASS |
| Modified shell scripts, `bash -n` | PASS |
| `git diff --check` | PASS |

The broad CLI unit invocation reported five suite setup errors because its
shared Hardhat context file was absent, plus one help-test timeout under the
concurrent load. The help suite passed all 13 tests when rerun in isolation;
the focused suites and builds above are the checks that exercise this patch.

## Six-node devnet

The review scenarios ran against a fresh isolated directory:

```text
DEVNET_DIR=/private/tmp/dkg-v9-storageack-priority-lane/.devnet-review1564
NUM_CORE_NODES=4
Hardhat: RUNNING on 8545
Nodes 1-6: RUNNING on APIs 9201-9206
```

### RFC49 catalog sampling

`scripts/devnet-test-rfc49-catalog-sampling.sh`: **PASS**

- publish confirmed with a nonzero on-chain catalog root and four leaves;
- the publisher emitted one private ciphertext chunk;
- member edge node 6 retained private data;
- strip-enabled core nodes 1-3 retained zero ciphertext rows and four catalog
  triples;
- strip-disabled core node 4 retained one ciphertext row as the discriminator;
- a random sampling proof was submitted;
- curated update retained the catalog root and leaf count, and members
  reconverged.

### SWM ownership restart

`scripts/devnet-test-swm-ownership-restart.sh`: **PASS**

- node 2 retained owner metadata through restart while node 1 was offline;
- cross-owner promotion returned the advisory no-share contract:
  `swmShared=false`, `promotedCount=0`, `sealed=false`, and
  `publishReady=false`;
- WM retained the attacker's draft while SWM retained the owner's value;
- the attacker's value was absent from SWM and ownership metadata was
  unchanged;
- the test cleanup restarted node 1.

## Receipt disposition

`2026-07-09-full-devnet.md` is retained as a pre-fix baseline and failed-run
diagnostic. It must not be read as post-fix validation for these commits.

The generated local deployment file and `.devnet-review1564/` runtime state
are intentionally excluded from version control.
