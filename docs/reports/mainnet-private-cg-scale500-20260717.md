# Mainnet private-CG scale test: 500 Knowledge Assets

Status: **PASS — 10.0.8 RELEASE CANDIDATE ACCEPTED**
Run ID: `mainnet-blackbox-scale500-20260717`

## Test contract

- Network: DKG V10 Gnosis mainnet
- Curator: Computer A, edge peer `12D3KooWNHKr6idks2tTAzCwcLhWvfoAoiY2j23MCHJep2ywSFg2`
- Late joiner: Computer B, edge peer `12D3KooWSRXGkxN6fM2BJU5shzfw3cuZoVuezxiEBdqrQCqVm7Ta`
- Private Context Graph: `0x9277a1a194fCadBB60d8DF0c472E7909ead50e33/blackbox-mainnet-scale500-20260717001549`
- CG on-chain ID: `13`; PCA account ID: `8`
- Workload: 500 KAs, split into 250 retained SWM KAs followed by 250 VM KAs
- Late-join condition: B remains outside the allowlist until all 500 KAs are finalized; enrollment is opened only for B's signed request, accepted by `autoApprove`, then closed immediately
- Success condition: B reaches a terminal successful durable-sync state and independently verifies all 500 exact KA graphs, the expected memory layer, every quad count, and every canonical digest; non-member privacy evidence must remain intact

## Corpus

- Source: `~/Downloads/prod-threats-400k.json`
- Source SHA-256: `8d46bd868166de5f09d5952e71c350217326750ff1bce4f93d97c90862e07a8c`
- Source records: 460,000
- Batch shape: 500 batches of 920 records
- Raw mapped RDF quads: 5,337,792
- Exact RDF-set contract after canonical duplicate removal: 5,337,721 unique quads (71 exact duplicates removed)
- Canonical JSON payload bytes: 786,850,576 bytes (418,589,381 SWM; 368,261,195 VM)
- Batch manifest SHA-256: `f01e1a58bf10b9317e0eab4709995bdc12efe8560d5497d1b0a83233b4b0f665`
- Published stage manifest SHA-256: `c84c6b3029cedebd7ba4ef138ce976df448debe7e4235d994e6b7cf0ca1474bc`

## Pre-scale baseline

The immediately preceding 20 SWM + 20 VM mainnet test passed end-to-end from A to B: 40/40 KAs and 505,666/505,666 quads matched exact digests. B's durable fetch took 37 seconds, but legacy partition verification took 283 seconds and materialization took 22 seconds, for approximately 342 seconds of measured sync work. The verification bottleneck was an unnecessary legacy subject-partition pass over rootless V10 batches.

## 10.0.8 candidate fixes under test

1. Rootless durable batches skip legacy root-entity partitioning.
2. Rootless SWM/VM lifecycle descriptors derive the canonical graph from `contentScopeVersion: 2` and the deterministic reserved UAL when an explicit assertion graph is absent.
3. Async VM preflight now fails closed unless `/api/status.asyncPublisher.available` is exactly `true`, with reason-specific operator guidance.
4. Async-all publishing applies a configurable `KC_VM_MAX_INFLIGHT` ceiling (12 in this run) before accepting more paid jobs.
5. Async terminal-status polling uses the same bounded worker pool instead of launching one poller per KA.
6. The stage-manifest builder supports the full expected batch count rather than the earlier 40-KA harness ceiling.
7. The catch-up API can run a strictly durable-only round (`includeSharedMemory: false`) so an already-complete SWM phase is not restarted or overlapped with VM recovery.
8. A fatal durable batch-integrity result cannot fall through into per-graph verification and mask the real mismatch as a misleading `0 metadata owners` error.
9. Chain-ordinal reconciliation maps packed rootless IDs back to their canonical author/KA-number UAL while retaining contract/token-id addressing for legacy read-only KAs.
10. Durable checkpoints persist the responder snapshot session ID and its sliding expiry, allowing a verified prefix to resume safely across receiver restarts and multiple bounded recovery calls.
11. The catch-up route threads its bounded per-peer durable budget into the agent; a requested 300-second operation now receives a 299-second internal deadline instead of silently inheriting the fixed 120-second default.
12. The responder preserves every valid non-negative safe-integer row cursor; it no longer clamps offsets above one million or replays the one-million-row boundary.
13. An intrinsically oversized responder snapshot keeps its typed store-bounded-fallback marker alive with a sliding TTL while the same immutable session is actively paging.
14. A resumed requester retains its last certified checkpoint/session when that same token delivered at least one valid page before a later transport drop; explicit supersession and zero-page generic aborts still rotate the session fail-safely.
15. A responder-declared expired or superseded session is rotated immediately even at offset zero, rather than being re-saved locally until its requester-side expiry.
16. A durable data round interrupted after valid pages returns its received prefix to the existing exact graph-boundary verifier; complete KAs are committed and checkpointed while the trailing incomplete KA remains unacknowledged for replay.
17. Durable streams for the same peer and Context Graph serialize across automatic/manual callers even when their budgets differ, and the HTTP recovery route awaits exact verification plus atomic store settlement before declaring a terminal result.

Local regression state before the scale run: 88 agent test files / 1,100 tests passed; focused publisher integration tests passed; A and B retained their original identities after hotpatching. The final candidate-suite closure is recorded below.

## Live findings

### Finding 1: async-publisher readiness false-pass

The first VM attempt returned HTTP 503 because the node's async publisher was disabled and had no configured publisher wallets. The old preflight queried queue counters only, so an all-zero response was incorrectly treated as readiness. No paid VM transaction was submitted by the rejected attempt. The node was configured with three existing authorized operational wallets, the daemon was restarted with the same identity, and the new availability guard now reproduces and blocks this configuration error in the integration test.

### Finding 2: unbounded producer outran durable finalization

The initial async-all producer reached 36 active jobs while Oxigraph's temporary RocksDB footprint rose to 8.4 GB. Pausing only the producer allowed the durable queue to keep finalizing and Oxigraph to compact to 4.7 GB without losing or duplicating a job. The producer was then resumed with a 12-job ceiling. Under the bound the queue remains saturated, failed jobs remain zero, and compaction continues to recover space during the run.

### Finding 3: private content is hidden, but CG catalog metadata is discoverable

Before membership, B remained unjoined and unsubscribed. The private CG appeared in catalog discovery as metadata, but a scoped content query returned zero bindings and zero private quads. This passes the current content-confidentiality gate. If product requirements treat the existence/name of a private CG as confidential, catalog filtering is a separate follow-up; it is not a KA-content leak.

### Finding 4: RDF inputs are sets, but the original harness counted duplicate array entries

The source mapping emitted 5,337,792 array entries, including 71 byte-identical RDF triples repeated within their target batches. A graph store correctly collapses those duplicates, so a verifier that expects array length would report a false loss even when the graph is exact. The harness now canonicalizes each batch as an RDF set before payload construction, commitments, manifest generation, and verification. The immutable receiver contract is therefore 5,337,721 unique quads; the manifest also records both the source count and duplicates removed.

### Finding 5: a stale direct peer address masked a healthy relay path

After the workload was ready, A could receive traffic from B over an existing limited relay connection but could not send the manifest or control messages back: the protocol router saw a stale direct address in the peer store and refused to reuse the healthy relay after the direct dial failed. The 10.0.8 candidate preserves the normal direct/DCUtR preference, then permits a subsequent retry to fall back to an already-live limited relay connection. Focused protocol-router tests, the complete core unit suite (82 files / 1,233 tests), and a live A-to-B inbox delivery all passed after the patch. A and B retained the same peer identities across installation.

### Finding 6: the bounded enrollment controller needed transient API retries

The first admission attempt safely restored the CG to manual enrollment after the local A API briefly reset a connection while being polled. The one-shot controller now retries network and 5xx responses while preserving its fail-closed cleanup. On retry it opened a two-member/two-approval ceiling, B signed one request, `autoApprove` admitted the expected agent, and the controller restored manual enrollment. The final allowlist contains exactly A and B.

### Finding 7: stale test subscriptions can starve an explicit private catch-up

Both edge nodes still had the earlier smoke/fan-out CGs subscribed. On peer reconnect, automatic sync repeatedly replayed the old fan-out graph from several peers even though it had already been marked synced. Those background jobs filled B's two active and four queued sync slots and made A's responder/store scheduler reject or delay the scale500 requests. The observed symptom looked like a weak relay, but the underlying contention was unrelated legacy/on-connect work. Unsubscribing exactly the two obsolete test CGs on A and B preserved their graph data and left the scale500 membership/subscription intact. For 10.0.8, explicit post-approval/private catch-up should have admission priority over stale/background reconciliation, and already-synced subscriptions should not trigger repeated full durable replay on every peer connection.

### Finding 8: a timed-out SWM phase continued underneath the next durable round

After B had already recovered all 250 SWM KAs, the generic catch-up endpoint still started SWM before VM. The caller's SWM deadline expired, but the underlying request work was not cancelled; a subsequent durable request then overlapped it and aborted under shared scheduler pressure. The scoped 10.0.8 fix adds an explicit durable-only route option. Focused CLI route tests pass 4/4, and the receiver can now resume from its committed VM checkpoint without restarting SWM. This removes the immediate overlap safely; end-to-end cancellation propagation remains a resilience follow-up.

### Finding 9: fatal batch integrity was hidden by a secondary graph-level error

One durable attempt correctly detected a batch mismatch, but the fatal branch returned graph names that had only passed individual checks. The caller therefore continued into materialization and surfaced `0 metadata owners`, hiding the actionable batch failure. Fatal batch verification now returns no verified graphs, forcing the real integrity failure to remain terminal for that attempt. Focused rootless verification tests pass 28/28 and the complete agent unit suite remains green (88 files / 1,100 tests).

### Finding 10: rootless on-chain IDs were reconstructed as legacy UALs

The chain-driven reconciler read each packed rootless KA ID, but built `storage-contract/packed-id` UALs. The actual local VM graphs are `author/KA-number`, so even curator A could not recognize data it already held and launched active catch-up against every connected peer. This caused needless RPC reads, store scans, relay traffic, and peer-wide sync pressure. The fix unpacks the high 160 author bits and low 96 KA-number bits for rootless IDs, while IDs with no author bits keep legacy contract/token addressing for read-only compatibility. Two new integration cases pass inside the 60-test core-gap suite, the agent build passes, and live A evidence immediately changed from `fetch/defer` on legacy UALs to `already` on canonical UALs with zero post-hotfix fetches.

### Finding 11: an offset alone cannot resume a retained responder snapshot

B safely persisted VM offsets, including 805,075 and later 573,235 triples, but the matching responder snapshot token existed only in process memory. After restart, expiry, or a bounded call ending before graph-level verification, the next request could not bind that offset to the original immutable snapshot and correctly reset to zero. Raw transport completion also cleared the token before the higher layer had certified and committed the full rootless snapshot. The 10.0.8 candidate persists the responder session ID and expiry beside the offset, reloads it after restart, slides the requester expiry after every successful page to mirror the responder, and retains it until verified store commit deletes the checkpoint. Missing, expired, or superseded sessions still fail safe by restarting from zero. Focused page-fetch tests pass 26/26, node-UI database and messenger tests pass 127/127, and the complete node-UI suite passes 2,167 tests with 38 skipped.

### Finding 12: the HTTP recovery budget did not reach the sync engine

The recovery route accepted `perPeerDurableBudgetMs: 300000` and held the HTTP request open for five minutes, but `syncFromPeer` still constructed its internal graph deadline from the fixed 120-second constant. The remaining time was therefore mostly idle wrapper time and could not improve progress. The fix passes a separately clamped total budget into the durable lane, includes that budget in single-flight identity, and leaves one second of headroom for the HTTP response. Normal/background callers retain the two-minute default and untrusted values are capped at five minutes. Focused agent tests pass 18/18, focused CLI route tests pass 4/4, and both packages build with type tests.

### Finding 13: a one-million-row responder clamp replayed data indefinitely

B resumed the VM stream at offset 518,035 and received valid graph-aligned data until its requested cursor crossed 1,000,000. The responder then silently rewrote every higher offset back to exactly 1,000,000. This repeatedly served a slice beginning inside graph `/496`: B observed 183,515 rows for `/496` and 92,928 for `/497`, although each manifest count is 10,120. The exact integrity gate rejected all 206 affected KAs, left the safe checkpoint and 86 already-materialized VM KAs unchanged, and committed no duplicated data. The responder now accepts every non-negative safe-integer cursor; an exact-graph plan already turns an offset beyond its total into a bounded empty response. A regression exercises offset 1,000,005 and passes in the focused 32-test responder suite. Agent build and type tests pass, and curator A retained the same peer identity plus exact `/496`, `/497`, and `_meta` counts after the hotfix restart.

### Finding 14: the store-bounded fallback marker did not share the session's sliding lifetime

After the cursor fix, B safely resumed one immutable VM snapshot through checkpoints 440,755, 1,157,176, and 1,738,808. The responder token, requester checkpoint, and exact-graph plan all refreshed their ten-minute lifetimes on successful pages, but the typed `snapshot_rows` rejection used to select graph-by-graph store paging retained its original fixed cleanup timer. At that original boundary the marker disappeared; the next nonzero-offset request therefore reported `Durable data sync session snapshot expired before page completion`. B discarded only the unusable offset/session, preserved all already-materialized KAs, and reported no digest or integrity rejection. The fix now touches that typed fallback marker on every same-session page, matching the other sliding session components. A focused fake-time regression remains on the same fallback past its original TTL and passes in the 25-test snapshot-cache suite; the agent build and type tests pass. Curator A loaded the hotfix in a six-second restart with the same peer identity and healthy relay connectivity.

### Finding 15: a late transport drop discarded a demonstrably valid resume session

The fourth post-hotfix automatic flow resumed the certified 1,920,735-row checkpoint and A accepted that token through offset 2,387,679. A transient `peer-closed-stream` followed by `All multiaddr dials failed` then terminated the flow. The requester correctly kept every already-materialized graph, but its older anti-supersession rule deleted the durable checkpoint on *any* error in a resumed round because an immediate responder supersession used to collapse into the same generic stream reset. In this case the successful pages proved that the responder had accepted the exact token, so deleting the checkpoint was unnecessary replay. The fix now invalidates a generic resumed session only when it failed before accepting any page. If at least one page succeeded, it retains the prior certified offset/session and slides the token lifetime; an explicit supersession still invalidates immediately, while a supersession after an accepted page costs at most one extra retry before the following zero-page failure rotates it. The focused requester suite passes 27/27 and the agent build/type checks pass. Commit `c1f6da851` is pushed for live B validation.

### Finding 16: an expired offset-zero token could consume repeated no-progress rounds

After B's controlled restart, its safe data checkpoint was still offset zero but referenced a responder snapshot that had expired while the node was offline. The responder returned the explicit `Durable data sync session snapshot expired before page completion` sentinel, yet the generic catch path re-saved the same terminal token until the requester-side timestamp elapsed. Two bounded calls therefore failed immediately without risking or deleting any materialized KA. The fix recognizes responder-declared `expired` and `superseded` session errors before the generic retention rule and rotates both token and checkpoint immediately, including at offset zero. The focused requester suite passes 28/28 and the agent build/type checks pass. Commit `4af26f25b` is included in the live candidate.

### Finding 17: a transport drop discarded a large valid raw prefix before verification

Once the stale token naturally expired, B opened a fresh immutable responder snapshot and received 229,376 data rows before the relay path again ended with peer-stream resets and failed multiaddress dials. No complete graph was corrupted and the exact receiver state remained 250 SWM plus 186 VM KAs, but `fetchSyncPages` threw before the rootless graph-boundary planner could inspect the received rows. Consequently, even complete KAs inside that prefix could not be certified, stored, or used to advance the safe cursor. The candidate now maps only backoff-worthy durable data interruptions with at least one accepted page into the same bounded incomplete-result contract used by deadlines. The existing manifest planner then keeps complete leading graphs, discards a trailing partial graph, verifies exact digests, stores atomically, and advances only to the last certified row. Denials, parser/integrity failures, metadata, recovery, and zero-page errors retain fail-closed throw semantics. The transport/session regression passes 28/28, related durable graph-boundary and checkpoint suites pass 71/71, and the agent build/type checks pass. Live rounds subsequently preserved and certified 650,515 rows and then 1,400,056 rows from bounded prefixes without digest loss or unsafe trailing-graph acknowledgement.

### Finding 18: the HTTP timeout declared completion before verification/store settlement

The first `fea4cda51` recovery round fetched 659,456 raw rows and hit its 300-second HTTP wrapper at `06:27:05Z`. The route returned HTTP 200 with `inserted=0`, but this did not cancel the agent operation: exact graph-boundary verification and atomic materialization correctly continued until `06:28:28Z`, certified 56 complete leading graphs, and advanced the safe cursor to 650,515. An automatic 120-second recovery began at `06:28:00Z`, overlapping the final 28 seconds because different timeout budgets intentionally had different single-flight keys. The data remained exact, but the API response was a false terminal and the overlap could supersede the same responder session. The fix preserves distinct caller operations while serializing their physical durable streams by peer plus Context Graph outside global admission, so different budgets never race. The durable route no longer races correctness-critical verification/store settlement against a timer that cannot cancel it; it returns the real terminal result after the internally bounded network fetch settles. Focused serialization tests pass 16/16, route tests pass 5/5, and agent/CLI build plus type checks pass. Live validation recorded zero physical overlap for the target peer/CG: differently budgeted automatic and operator calls queued behind the same gate, and every settled checkpoint remained exact through 500/500 completion.

### Finding 19: the test controller still imposed the old five-minute caller timeout

The first `578571543` live round proved that physical durable streams were serialized and that verification plus store settlement completed before the node operation became terminal. It fetched 1,400,832 raw rows, certified a 1,400,056-row prefix covering 128 complete graphs, and settled safely. However, the external harness aborted its HTTP client after 301 seconds while the queued/network/store operation required approximately 474 seconds from node start to terminal settlement. This was a controller timeout rather than a DKG route timeout or data failure: the node completed the work and retained the certified checkpoint after the caller disconnected. Scale recovery controls now keep their outer HTTP timeout at least 900 seconds while preserving the bounded per-peer network budget. Production clients should likewise treat the route as a potentially longer settlement operation and rely on its terminal response or operation status instead of assuming that the network-fetch budget bounds total verification and commit time.

### Finding 20: an all-peer durable failure could be reported as a successful zero-result no-op

After two automatic streams completed sequentially, an explicit durable-only call correctly waited for the per-peer/CG gate, then failed to dial every selected peer at offset zero. The agent result contained the durable error, but the HTTP route still returned status 200 with `ok: true` and zero inserted items. This did not corrupt or remove data, yet it made a retryable network failure indistinguishable from an already-complete no-op. The candidate now returns retryable HTTP 503 with `DURABLE_CATCHUP_ALL_PEERS_FAILED` when every selected peer in a durable-only call reports a durable or general error; a genuine successful zero-result call remains HTTP 200. The focused CLI route suite passes 7/7, the CLI build passes, and commit `94c2accde` is pushed on the 10.0.8 candidate branch.

### Finding 21: restart issued one obsolete, zero-payload recovery probe after completion

After the complete VM checkpoint had been committed and its database row cleared, B's controlled restart launched one automatic durable attempt. It ran for three seconds, fetched zero target data, and terminated on the already-expired responder snapshot token. The exact 500-KA state remained unchanged, no operator recovery was started, and A's recovery-authorization counter did not increase. This is low-severity control-plane noise rather than a correctness or bandwidth failure, so it is not a release blocker. A later improvement should distinguish a fully consumed watermark from a stale resumable session at startup while still allowing the subscriber to discover genuinely new VM ordinals published after its prior completion.

## Results

### Curator SWM publication checkpoint

- 250/250 SWM KAs completed with zero batch errors from `2026-07-17T00:18:17Z` to `00:39:25Z` (approximately 21 minutes 9 seconds, or 5.1 seconds/KA).
- Across 84 fifteen-second resource samples, whole-machine CPU busy averaged 32.6%, reached p95 44.3%, and peaked at 56.3%.
- DKG RSS peaked at 1.11 GB; Oxigraph RSS peaked at 2.29 GB. Oxigraph CPU reached 269% briefly, while whole-machine capacity remained available.
- Memory-pressure-free percentage reached a minimum of 33%. The host swapped during the run, but did not enter a terminal pressure condition.
- Network interface errors remained zero. Approximately 0.97 GB was received and 0.83 GB transmitted during the SWM window; this includes ambient DKG traffic and is not an isolated payload-byte measurement.
- Disk-delta interpretation is contaminated by a deliberate cleanup of disposable package/browser caches during this window; minimum observed free space was approximately 36.2 GiB and the run continued safely.

### Curator VM publication

- All 250 VM KAs reached the `finalized` state with 250 unique publisher job IDs and 250 unique transaction hashes; failed jobs remained zero.
- The first accepted async job was enqueued at `2026-07-17T00:43:24Z`; the final job reached terminal finalization at `01:21:02Z`, a wall-clock window of approximately 37 minutes 38 seconds.
- The producer used a 12-job in-flight ceiling after the initial readiness and queue-pressure findings. A daemon restart around batch 425 was recovered by durable job adoption without a duplicate paid publish.
- The completed manifest contains 250 SWM graphs with 2,822,010 unique quads and 250 VM graphs with 2,515,711 unique quads. A independently read every graph back from its store: 500/500 graphs and all 5,337,721 unique quads matched the canonical per-KA digests and expected memory layers.

### Late-join admission and live sync checkpoint

- B signed its join request at `2026-07-17T01:43:08Z`; `autoApprove` accepted it immediately. A observed membership two seconds later and restored manual enrollment.
- B's durable receiver job is `mro9ym2b-5wao0w`. At `01:50:45Z` it was still running, with 42/250 VM graphs exposed, 515,193 verified triples committed, and SWM recovery round 2 at 59/250 KAs.
- At that checkpoint B reported two target retries, three recoverable phase timeouts, zero terminal failures, peak process RSS of approximately 2.42 GB, and no blocker. A continued serving roughly 7.3 authorized recovery requests per second with no target-CG warning or failure.
- By recovery round 9, B had verified 166/250 SWM KAs, exposed 70/250 VM graphs, and advanced the VM-safe offset to 805,075/2,515,711. It then safely deferred under scheduler pressure rather than claiming readiness.
- Investigation showed the pressure came from two obsolete test subscriptions, not scale500 resource saturation. Before cleanup B's scheduler was at 2/2 active and 4/4 queued; after exact unsubscription the old data remained stored and the target was the only active user subscription.
- Before the persisted-session fix, a restart preserved the receiver identity, stores, membership, all 250 SWM KAs, and 70 committed VM graphs, but subsequent bounded calls could not safely reuse the responder snapshot and eventually lost the offset checkpoint. No committed VM graph was deleted. The controlled restart with the complete candidate retained all 250 SWM KAs, advanced from 86 to 100 committed VM KAs during automatic startup recovery, preserved the same peer and agent identities, and passed SQLite, membership, subscription, and relay health checks.
- With the cursor fix installed, consecutive automatic A-target rounds committed checkpoints 440,755 and 1,157,176, then advanced to 1,738,808 without replay, duplicate inflation, or integrity rejection. This live run crossed the former one-million-row boundary before exposing the independent fixed-lifetime fallback marker.
- After the fallback-lifetime hotfix and curator restart, B's first automatic round fetched 663,552 raw rows, certified 57 complete VM graphs, and committed a safe 661,555-row checkpoint with no integrity or digest signal. A second automatic round resumed the same immutable session at 661,555, certified 63 more complete VM graphs, and committed 1,319,096/2,515,711 at `05:24:21Z`. A third certified another 66 complete graphs and committed 1,920,735/2,515,711 at `05:30:26Z`. The cursor crossed the original ten-minute fallback expiry without expiring or replaying, which live-validates the sliding-marker fix. Manual recovery remains a non-overlapping fallback only; normal automatic convergence retains priority.
- A later fresh session transferred 229,376 additional raw rows before a relay interruption. Under the pre-`fea4cda51` runtime the round could not expose that prefix to exact graph-boundary verification, so B deliberately retained its already-certified state at 250 SWM and 186 VM KAs (4,742,745 exact quads) and committed no unsafe cursor. This is the live failure being used to validate partial-prefix recovery.
- With `fea4cda51` installed, the first explicit round fetched 659,456 raw rows, selected 56 complete graph-aligned assets, and committed safe offset 650,515. This live-validates partial-prefix preservation: the exact KA count remained 186 only because these were leading graphs B had already materialized during earlier replay, but the durable cursor now records that certified work and the next round resumes beyond it. The HTTP wrapper's early return and a 28-second automatic overlap are tracked separately in Finding 18.
- With the serialized-settlement candidate installed, the next large round certified a 1,400,056-row prefix without a competing target stream. Subsequent automatic rounds resumed the same immutable snapshot and advanced the safe cursor through 1,950,175, 2,025,155, 2,261,791, and finally 2,515,711/2,515,711. The last operation fetched and certified 253,920 rows covering 23 complete graphs with zero transport errors. Completion atomically cleared the durable data checkpoint.
- At `2026-07-17T07:13:21Z`, B independently observed all 250 SWM graphs (2,822,010 quads) and all 250 VM graphs (2,515,711 quads): 500/500 KAs and 5,337,721/5,337,721 unique quads. A strict authorized verifier then checked all 500 graph digests and lifecycle descriptors from `07:13:27Z` to `07:14:37Z` (70.325 seconds) and passed with no mismatch.
- During the large serialized recovery round, B's DKG process peaked at approximately 2.57 GiB RSS and 248.8% CPU. A later continuation peaked at approximately 2.12 GiB RSS and 163.4% CPU. These are multi-core process percentages; neither result indicates whole-host CPU saturation.

### Final restart, reconnect, privacy, and exactness certificate

- B stopped cleanly at `07:15:31Z` and was reachable again over the normal DKG relay path at `07:15:57Z`, a 26-second reconnect interval.
- The same data home and pinned runtime were used. Peer ID `12D3KooWSRXGkxN6fM2BJU5shzfw3cuZoVuezxiEBdqrQCqVm7Ta` and agent address `0xD61c661570a3B6D79d52DeE1a37Ed3fdE3D0927F` were unchanged, and the SQLite quick check passed.
- Post-restart status was healthy on `mainnet-gnosis`: 12 connected peers, 11 direct connections, two relayed connections, relay connected, and three circuit addresses.
- Membership remained an active `join-approved` participant; the node remained an active subscriber with `subscribed`, `synced`, `metaSynced`, `sharedMemorySynced`, and scoped-sync flags true. The reconciled chain ordinal was 250.
- A's owner-side view remained fail-closed/manual and contained exactly the owner plus B in the allowlist. B observed the same two-agent allowlist. An unauthenticated private query returned HTTP 401 and exposed zero triples; the earlier pre-membership scoped content query also returned zero private bindings.
- B's strict post-restart verifier ran from `07:18:50Z` to `07:19:57Z` (67.031 seconds) and again passed all 500 graph digests, all lifecycle descriptors, and all 5,337,721 quads. Its final exact observation at `07:21:26Z` remained 250 SWM plus 250 VM KAs.
- The one automatic post-completion attempt fetched zero data. A observed no increase in durable-recovery authorization and no target payload replay; the exact receiver state remained unchanged.

### Curator resources during late-join sync and investigation

The A-side receiver window spans `01:43:11Z` through `07:21:19Z` (1,308 samples over 5 hours 38 minutes). It intentionally includes retries, controlled restarts, diagnostics, and local candidate builds, so it is a worst-case test-session envelope rather than a clean steady-state transfer benchmark.

- Whole-host CPU busy averaged 29.9%, reached p95 45.4%, and peaked at 77.5%; one-minute load averaged 4.55.
- A's DKG process averaged 25.9% CPU, reached p95 52.3%, and peaked at 185% CPU. RSS averaged 449 MiB, reached p95 822 MiB, and peaked at 1.79 GiB.
- The sampled target store averaged 18.9% CPU, reached p95 22.3%, and peaked at 206.2% CPU. RSS averaged 198 MiB, reached p95 446 MiB, and peaked at 2.22 GiB. Store samples are incomplete across hotpatch restarts, so the 840 available samples are reported explicitly.
- macOS memory-pressure-free never fell below 33%. The long mixed workload used compression and swap, but neither the DKG process nor store was terminated for pressure.
- Disk available remained at least 44.1 GiB during this window and ended approximately 0.91 GiB lower than it began. Earlier deliberate cache cleanup and repeated local builds mean this is not a pure DKG-store growth figure.
- The active interface recorded approximately 9.83 GB received and 17.54 GB transmitted, with zero input or output errors. These totals include ambient network traffic, repeated diagnostic/recovery rounds, Git/build traffic, and inbox control traffic; they are not the wire size of the 786.9 MB canonical KA payload.
- Connected peers stayed between 11 and 14 (mean 12.8); direct connections were 10–12 and relayed connections 0–7. Two RPC failovers occurred and no RPC exhaustion was recorded.

### Receiver resources and post-run storage snapshot

B's original sampler covered `00:15:35Z` through `07:24:16Z`: 1,694 samples across ten process-root segments and nine completed restart handoffs. Its schema sampled the combined DKG worker plus its direct-child Oxigraph process, rather than host and process components separately. This limitation is preserved in the evidence instead of reconstructing unavailable historical values.

- Across the 1,622 samples with an active process tree, combined CPU averaged 34.7%, reached p95 117.3%, and peaked at 297.5%. Combined RSS averaged 1,219.9 MiB, reached p95 2,434.3 MiB, and peaked at 3,211.0 MiB.
- Sampling was nominally every 15 seconds. The mean gap was 15.19 seconds, p95 was 15.01 seconds, the maximum was 143.53 seconds, and four gaps exceeded 22.5 seconds. Seventy-two samples intentionally recorded no tracked process during controlled stops/build handoffs.
- B's sampler did not record historical whole-host CPU/load, memory pressure/swap, disk deltas, interface deltas/rates, separate DKG/store process series, or peer-count series. Those test-window metrics therefore cannot be claimed for B. The corresponding A-side series is complete above, and B supplied a labeled post-run snapshot for capacity context.
- At `07:27:14Z`, B's data volume had 994.66 GB total and 164.48 GB available at 83% capacity. Logical regular-file sizes were 5.08 GB for the complete DKG home, including 4.62 GB for Oxigraph data; node-UI SQLite was 21.57 MB and its WAL was 4.15 MB.
- In that point-in-time snapshot, the DKG worker used 6.8% CPU and 265.3 MiB RSS; Oxigraph used 94.4% CPU and 675.6 MiB RSS. The high store CPU is a single post-run observation, consistent with background compaction, not a window average.
- B's active `en0` counters were 45.48 GB received and 15.86 GB transmitted since interface counter origin, with zero RX/TX errors and zero collisions. Because no baseline was sampled, these are explicitly not presented as test-transfer deltas.
- Final B status remained 12 connected peers, 11 direct and two relayed connections, relay connected, and three circuit addresses. The sampler stopped cleanly at `07:26:50Z`; the DKG node remains running.

### End-to-end timing interpretation

- Curator publication of the 250 SWM KAs took approximately 21 minutes 9 seconds. The 250 VM KAs took approximately 37 minutes 38 seconds from first accepted async job to final finalization. The complete publication window from first SWM start to last VM finalization was approximately 1 hour 2 minutes 45 seconds, including the transition between phases.
- B joined at `01:43:08Z` and first reached the exact 500-KA state at `07:13:21Z`, approximately 5 hours 30 minutes later. This is a fault-discovery/hotfix campaign, not expected steady-state 10.0.8 sync latency: it includes every reproduced bug, multiple candidate builds and restarts, deliberately bounded recovery rounds, relay interruptions, and repeated exact verification.
- After the final serialized-settlement runtime was installed and restarted at `06:45:54Z`, B retained 436 already-materialized KAs and reached 500/500 at `07:13:21Z`—27 minutes 27 seconds later. That tail covered 64 remaining KAs and 594,976 remaining exact quads while also validating checkpoint replay, session resumption, serialization, and terminal settlement.
- The current protocol still pays a request, authorization, response framing, and store-page cost for each bounded page. The highest-value throughput follow-up is a long-lived authorized stream carrying multiple graph-aligned chunks per libp2p stream with rolling certified checkpoints; this removes most per-page round trips without coupling the design to Oxigraph, Blazegraph, or another store.

### Clean-run throughput estimate

The fault-discovery campaign is not a clean throughput benchmark, and no fresh 500-from-zero receiver was provisioned after the final hotfix. The strongest post-fix segment transferred and settled the remaining 64 KAs, 594,976 quads, and 87,530,883 canonical payload bytes in 27 minutes 27 seconds. Linear scaling by quads or payload yields approximately 4 hours 6 minutes for this 500-KA corpus on the current bounded-page protocol. The responsible planning range is therefore 3.5–4.5 hours, followed by approximately 70 seconds for strict exact verification. This is an evidence-based projection, not a directly measured clean-run result.

### Final candidate-suite closure

The prepared code is branch `fix/10.0.8-sync-materialization`, with product candidate head `94c2accde` (`fix(sync): surface all-peer durable catchup failures`). The complete live convergence and restart certificate exercised the data path through `578571543`; the final `94c2accde` change only corrects HTTP error classification for an all-peer failure and is covered by focused route tests plus the complete candidate suites.

- `@origintrail-official/dkg-agent` unit suite: **88/88 files and 1,105/1,105 tests passed**.
- `@origintrail-official/dkg` full package suite with its Hardhat test context: **197 files passed, 2 skipped; 2,817 tests passed, 12 skipped**.
- Core regression suite: **82 files / 1,233 tests passed**.
- Node-UI regression suite: **2,167 tests passed, 38 skipped**.
- Focused publisher integration tests, candidate package builds, and type checks passed.
- Final worktree inspection found no uncommitted product-code changes.

## Release decision

**PASS for 10.0.8 candidate integration and the standard version/package/CI/release workflow.** The gate proves the 20+20 baseline and the production-shaped 500-KA private-CG workload, exact SWM and VM convergence, auto-approved late joining, normal relay delivery, fail-closed content privacy, durable recovery across transport failures, and restart persistence without duplicate or missing graphs.

The following are non-blocking follow-ups rather than contradictions of this result:

1. Replace bounded page/request churn with a long-lived authorized graph-aligned stream and rolling certified checkpoints; current clean 500-KA sync is projected at roughly four hours.
2. Suppress the single zero-payload stale-session probe after a fully completed restart while preserving discovery of newly published ordinals.
3. Decide whether private Context Graph names/catalog entries, rather than only their contents, must be hidden from non-members.
4. Extend the receiver sampler before the next benchmark so B records historical host CPU/load, memory pressure, separate DKG/store series, disk deltas, and interface deltas instead of only combined process samples and a post-run capacity snapshot.

This report is sealed against the immutable corpus, batch manifest, published stage manifest, exact receiver certificates, and final suite results above.
