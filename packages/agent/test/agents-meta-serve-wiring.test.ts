import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Wiring guard for the serve-skip production call site (#1233,
// dkg-agent-lifecycle.ts::start → registerSyncHandler). The pure resolver
// (`shouldWithholdAgentsDurableMeta`) is unit-tested in agents-meta-policy.test.ts,
// and the responder branch that CONSUMES the injected predicate is tested in
// sync-responder-agents-meta-serve-skip.test.ts. This test closes the gap
// BETWEEN them: it exercises the REAL seam that `start()` binds into
// `registerSyncHandler` (`this.shouldWithholdDurableMeta.bind(this)`) and asserts
// (a) it wires the agents-CG policy and (b) it reads `DKG_SERVE_AGENTS_META`
// FRESH per call (runtime-hot). A revert to a module-load-cached flag, or dropping
// the agents-CG check, fails here.

import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';

const AGENTS_CG = 'agents';
const USER_CG = 'user-cg';

// Reproduce EXACTLY the value the call site injects into registerSyncHandler:
// `this.shouldWithholdDurableMeta.bind(this)`. The method does not touch `this`
// (it delegates to the pure resolver + reads process.env), so a bare fake agent
// stands in — matching the fake-`this` pattern in agents-meta-sync-wiring.test.ts.
// Testing this single bound instance IS testing the injected predicate, and
// re-using ONE instance across env flips is what proves runtime-hot.
function fakeAgent(): any {
  return {};
}
const injectedPredicate: (contextGraphId: string) => boolean =
  LifecycleSyncMethods.prototype.shouldWithholdDurableMeta.bind(fakeAgent());

describe('LifecycleSyncMethods.shouldWithholdDurableMeta — serve-skip call-site wiring', () => {
  const originalEnv = process.env.DKG_SERVE_AGENTS_META;

  beforeEach(() => {
    delete process.env.DKG_SERVE_AGENTS_META;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DKG_SERVE_AGENTS_META;
    else process.env.DKG_SERVE_AGENTS_META = originalEnv;
  });

  it('withholds the agents CG _meta when DKG_SERVE_AGENTS_META is unset (default)', () => {
    expect(injectedPredicate(AGENTS_CG)).toBe(true);
  });

  it('serves the agents CG _meta when DKG_SERVE_AGENTS_META=1 (kill-switch)', () => {
    process.env.DKG_SERVE_AGENTS_META = '1';
    expect(injectedPredicate(AGENTS_CG)).toBe(false);
  });

  it('never withholds a non-agents CG, flag set or not', () => {
    expect(injectedPredicate(USER_CG)).toBe(false);
    process.env.DKG_SERVE_AGENTS_META = '1';
    expect(injectedPredicate(USER_CG)).toBe(false);
  });

  it('reads the env FRESH per call — flipping the flag on the SAME predicate flips the result (runtime-hot)', () => {
    // ONE bound predicate instance across all three calls; only the env changes.
    // If the flag were captured at bind / module-load time, the 2nd/3rd asserts
    // would fail — proving the kill-switch is reversible without a node restart.
    expect(injectedPredicate(AGENTS_CG)).toBe(true); // unset ⇒ withhold
    process.env.DKG_SERVE_AGENTS_META = '1';
    expect(injectedPredicate(AGENTS_CG)).toBe(false); // now serve, no rebind/restart
    delete process.env.DKG_SERVE_AGENTS_META;
    expect(injectedPredicate(AGENTS_CG)).toBe(true); // back to withhold
  });
});
