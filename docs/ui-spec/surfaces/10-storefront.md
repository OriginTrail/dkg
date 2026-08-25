# Surface 10 — Node storefront (the second discovery axis)

Purpose: a page per node — everything it serves across ⛓/☁ classes and query
offerings, its asks and next-cycle changes, reputation, uptime,
statement-verified volume. Where pin-this-node preferences live.
Refs: `or-rankings.png` (table anatomy), fixtures `p5.storefront`, `p5.asks`.

## Wireframe
```
okf-mainnet ⛓☁                    99.2% responding · last 30 d
2.4M statement-verified units this epoch
[Subscribe to this node's shelf]
────────────────────────────────────────────────────────
OFFERING              CLASS  ASK            NEXT CYCLE
Qwen2.5 14B Instruct  ⛓     ~$0.17/1M      —
Qwen2.5 7B Instruct   ⛓     ~$0.10/1M      0.32 µ/tok
gpt-5.x               ☁     ~$0.31/1M      —
okf knowledge         query  15.24 µ/unit   —
  Answers queries over: neurosymbolic-marketplace, odysseus
  Priced by the published cost schedule — both sides can
  recompute every unit
```

## Components
NodeHeader (identity, provenance classes served, uptime `store.uptime`,
volume `store.volume` — statement-verified only, tooltip carries the
`catalog.volume.tip` doctrine) · ShelfTable (ask + `store.ask.next` when an
edit is queued) · QueryOfferingRow (`store.query.covers` +
`store.query.schedule`, links the Cost Schedule KA) · SubscribeShelfCTA ·
ReputationBlock (statement history: agreed/disputed counts — `model.rep`
pattern).

## Data bindings
shelf ← node's verified offer KAs · volume ← published statement KAs only ·
uptime ← buyer-local probe history (labeled as local observation) ·
next-cycle ask ← AskCommitment queue.

## States
reachable · unreachable (`model.uptime.down`, rows stay browsable, subscribe
disabled) · no-statements-yet (volume line absent, not zero).

## Acceptance
- [ ] Volume figure sourced exclusively from statement KAs; tooltip says so.
- [ ] Queued ask change renders as next-cycle, current ask unchanged.
- [ ] Query offering names its CGs and links the schedule KA.
- [ ] Unreachable node keeps the shelf readable and disables only actions.
- [ ] 390 px: table becomes stacked cards without losing the NEXT CYCLE field.
