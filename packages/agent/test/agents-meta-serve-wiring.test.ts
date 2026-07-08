import { describe, expect, it } from 'vitest';

// Wiring guard for the serve-skip predicate (#1233). `start()` passes
// `createAgentsDurableMetaWithholdPredicate(() => process.env.DKG_SERVE_AGENTS_META)`
// directly as `registerSyncHandler`'s `shouldWithholdDurableMeta`. We drive that
// SAME small factory here with a controllable env reader — the only dependency the
// behavior actually varies — so a regression in the predicate (wrong default,
// non-agents withholding, or a stale/snapshotted read) is caught. The factory stays
// environment-agnostic (reader injected); the pure resolver's precedence
// (`shouldWithholdAgentsDurableMeta(cg, env)`) is covered in agents-meta-policy.test.ts.

import { createAgentsDurableMetaWithholdPredicate } from '../src/sync/agents-meta-policy.js';

const AGENTS_CG = 'agents';
const USER_CG = 'user-cg';

describe('createAgentsDurableMetaWithholdPredicate wires the serve-skip predicate (#1233)', () => {
  it('withholds agents/_meta by default (env unset)', () => {
    expect(createAgentsDurableMetaWithholdPredicate(() => undefined)(AGENTS_CG)).toBe(true);
  });

  it('serves agents/_meta when DKG_SERVE_AGENTS_META=1 (kill-switch)', () => {
    expect(createAgentsDurableMetaWithholdPredicate(() => '1')(AGENTS_CG)).toBe(false);
  });

  it('never withholds a non-agents CG, flag set or not', () => {
    expect(createAgentsDurableMetaWithholdPredicate(() => undefined)(USER_CG)).toBe(false);
    expect(createAgentsDurableMetaWithholdPredicate(() => '1')(USER_CG)).toBe(false);
  });

  it('reads its env reader FRESH per call (runtime-hot) — SAME instance flips with the flag', () => {
    // Capture the predicate ONCE over a MUTABLE reader. If it read the flag at build
    // time instead of per call, the 2nd/3rd asserts would fail — proving the
    // kill-switch is reversible at runtime with no node restart. `start()` injects
    // `() => process.env.DKG_SERVE_AGENTS_META`, so the same freshness applies to the
    // real env in production.
    let env: string | undefined;
    const predicate = createAgentsDurableMetaWithholdPredicate(() => env);
    expect(predicate(AGENTS_CG)).toBe(true); // unset ⇒ withhold
    env = '1';
    expect(predicate(AGENTS_CG)).toBe(false); // now serve — same instance, no rebuild
    env = undefined;
    expect(predicate(AGENTS_CG)).toBe(true); // back to withhold
  });
});
