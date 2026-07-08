import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Wiring guard for the serve-skip PRODUCTION call site (#1233). `start()` passes
// `this.buildSyncResponderRegistration()` straight into `registerSyncHandler`, so
// the params object that builder returns IS what the responder receives. We drive
// the REAL builder (via the LifecycleSyncMethods prototype with a minimal fake
// `this`, mirroring the fetch-wiring test's `syncFromPeerDetailed` pattern) and
// assert on the ACTUAL injected `shouldWithholdDurableMeta` — so a call-site
// regression (`() => false`, or dropping the option entirely) is caught here, not
// just a separately-rebuilt predicate. The pure resolver's precedence
// (`shouldWithholdAgentsDurableMeta(cg, env)`) is covered in agents-meta-policy.test.ts.

import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';

const AGENTS_CG = 'agents';
const USER_CG = 'user-cg';

// Minimal fake agent: `buildSyncResponderRegistration` only EAGERLY reads
// `this.config` (for sharedMemoryTtlMs) and binds parseSyncRequest /
// authorizeSyncRequest; router / store / peerId / log are captured inside arrows
// this test never invokes. Matches the fake-`this` pattern in
// agents-meta-sync-wiring.test.ts.
function fakeAgent(): any {
  return {
    config: {},
    parseSyncRequest: () => ({}),
    authorizeSyncRequest: async () => true,
  };
}

// Pull the ACTUAL predicate the call site injects out of the builder's params.
function injectedPredicate(): (contextGraphId: string) => boolean {
  const params = LifecycleSyncMethods.prototype.buildSyncResponderRegistration.call(fakeAgent());
  const predicate = params.shouldWithholdDurableMeta;
  // Also guards the "option dropped" regression — undefined here fails loudly.
  if (!predicate) throw new Error('call site did not inject shouldWithholdDurableMeta');
  return predicate;
}

describe('buildSyncResponderRegistration wires the serve-skip predicate (#1233)', () => {
  const originalEnv = process.env.DKG_SERVE_AGENTS_META;

  beforeEach(() => {
    delete process.env.DKG_SERVE_AGENTS_META;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DKG_SERVE_AGENTS_META;
    else process.env.DKG_SERVE_AGENTS_META = originalEnv;
  });

  it('injects a predicate that withholds agents/_meta by default (env unset)', () => {
    expect(injectedPredicate()(AGENTS_CG)).toBe(true);
  });

  it('injects a predicate that serves agents/_meta when DKG_SERVE_AGENTS_META=1 (kill-switch)', () => {
    process.env.DKG_SERVE_AGENTS_META = '1';
    expect(injectedPredicate()(AGENTS_CG)).toBe(false);
  });

  it('injects a predicate that never withholds a non-agents CG, flag set or not', () => {
    expect(injectedPredicate()(USER_CG)).toBe(false);
    process.env.DKG_SERVE_AGENTS_META = '1';
    expect(injectedPredicate()(USER_CG)).toBe(false);
  });

  it('the injected predicate reads env FRESH per call (runtime-hot) — SAME captured instance flips with the flag', () => {
    // Capture the predicate ONCE (env unset). If the boundary read the flag at
    // build/module-load time instead of per call, the 2nd/3rd asserts would fail —
    // proving the kill-switch is reversible at runtime with no node restart.
    const predicate = injectedPredicate();
    expect(predicate(AGENTS_CG)).toBe(true); // unset ⇒ withhold
    process.env.DKG_SERVE_AGENTS_META = '1';
    expect(predicate(AGENTS_CG)).toBe(false); // now serve — same instance, no rebuild
    delete process.env.DKG_SERVE_AGENTS_META;
    expect(predicate(AGENTS_CG)).toBe(true); // back to withhold
  });
});
