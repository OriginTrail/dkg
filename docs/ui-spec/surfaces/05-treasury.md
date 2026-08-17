# Surface 05 — Treasury (one balance over many tabs)

Purpose: OpenRouter's credits feel, without hiding the tab reality.
Refs: `or-credits.png`.

## Wireframe
```
        ╭────────╮   Available to spend
        │ 1.9992 │   $0.56        [Top up]
        ╰────────╯   ring = wallet + refundable
Every µ accounted for: 1,000,000 = 761 + 999,239 ✓
────────────────────────────────────────────────
Tab            Provider   Refundable  Billed  ▸
tab_1dfe28cb   0x9A21…    999,239 µ   761 µ   [Close][Take money back]
```

## Components
BalanceRing (--gauge-radial-size) · ConservationLine (`treasury.conservation`;
plain gloss primary, exact figures inline mono) · TabList (per-tab mini-bars:
billed vs refundable) · TopUpFlow (amount → policy allocates; each on-chain
step human-gated with amount/from/to restated) · RefundFlow → Basescan link.

## Data bindings
ring = wallet + Σ refundable across open tabs (live ledger projection) ·
conservation line recomputed client-side from the same projection — if lhs≠rhs
the line goes `--state-blocked` and links a diagnostic (never hide a break) ·
tab rows ← ledger; actions call close/refund paths.

## States
empty (`empty.tabs`) · topup-pending (chain confirms) · refund-pending ·
conservation-broken (red line + diagnostic — must exist in gallery even
though it should never occur live).

## Acceptance
- [ ] The single number provably equals wallet + Σ refundable (unit test + UI).
- [ ] Conservation line live, exact, and turns red on injected fixture break.
- [ ] Refund produces a Basescan link in-row on completion.
- [ ] Top-up restates amount/from/to at the human gate.
