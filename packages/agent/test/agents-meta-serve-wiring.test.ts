import { afterEach, describe, expect, it } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';

// Wiring guard for the serve-skip predicate (#1233). `start()` builds the responder
// registration via the sync-layer factory `buildSyncResponderRegistration(deps)` and
// passes the result straight into `registerSyncHandler`, so the params that factory
// returns ARE what the responder receives. We drive the REAL factory with an
// explicit, typed deps object (no `prototype.call`, no partial-`DKGAgent` fake) and
// assert on the ACTUAL injected `shouldWithholdDurableMeta` — so a wiring regression
// (`() => false`, or dropping the predicate) is caught here. The env is injected via
// `serveAgentsMetaEnv`, exactly the seam `start()` fills with
// `() => process.env.DKG_SERVE_AGENTS_META`; the pure resolver's precedence
// (`shouldWithholdAgentsDurableMeta(cg, env)`) is covered in agents-meta-policy.test.ts.

import {
  buildSyncResponderRegistration,
  readServeAgentsMetaEnv,
  type SyncResponderRegistrationDeps,
} from '../src/sync/responder/sync-handler.js';

const AGENTS_CG = 'agents';
const USER_CG = 'user-cg';

// Pull the ACTUAL predicate the factory injects, with a controllable env reader.
// `store` / `parseSyncRequest` are pass-through-only deps the factory never invokes,
// so minimal placeholders keep the object typed without a real store.
function injectedPredicate(
  serveAgentsMetaEnv: () => string | undefined,
): (contextGraphId: string) => boolean {
  const deps: SyncResponderRegistrationDeps = {
    register: () => {},
    protocolSync: 'sync',
    syncDeniedResponse: 'denied',
    syncPageSize: 1,
    sharedMemoryTtlMs: 0,
    store: {} as unknown as TripleStore,
    peerId: 'test-peer',
    parseSyncRequest: (() => ({})) as SyncResponderRegistrationDeps['parseSyncRequest'],
    authorizeSyncRequest: async () => true,
    serveAgentsMetaEnv,
    logWarn: () => {},
    logDebug: () => {},
  };
  const predicate = buildSyncResponderRegistration(deps).shouldWithholdDurableMeta;
  // Also guards the "predicate dropped" regression — undefined here fails loudly.
  if (!predicate) throw new Error('factory did not inject shouldWithholdDurableMeta');
  return predicate;
}

describe('buildSyncResponderRegistration wires the serve-skip predicate (#1233)', () => {
  it('injects a predicate that withholds agents/_meta by default (env unset)', () => {
    expect(injectedPredicate(() => undefined)(AGENTS_CG)).toBe(true);
  });

  it('injects a predicate that serves agents/_meta when DKG_SERVE_AGENTS_META=1 (kill-switch)', () => {
    expect(injectedPredicate(() => '1')(AGENTS_CG)).toBe(false);
  });

  it('injects a predicate that never withholds a non-agents CG, flag set or not', () => {
    expect(injectedPredicate(() => undefined)(USER_CG)).toBe(false);
    expect(injectedPredicate(() => '1')(USER_CG)).toBe(false);
  });

  it('the injected predicate reads its reader FRESH per call (runtime-hot) — SAME captured instance flips', () => {
    // Capture the predicate ONCE over a MUTABLE reader. If the factory read the flag
    // at build time instead of per call, the 2nd/3rd asserts would fail — proving the
    // kill-switch is reversible at runtime with no node restart. (The reader itself,
    // `start()`'s injected `readServeAgentsMetaEnv`, is covered separately below.)
    let env: string | undefined;
    const predicate = injectedPredicate(() => env);
    expect(predicate(AGENTS_CG)).toBe(true); // unset ⇒ withhold
    env = '1';
    expect(predicate(AGENTS_CG)).toBe(false); // now serve — same instance, no rebuild
    env = undefined;
    expect(predicate(AGENTS_CG)).toBe(true); // back to withhold
  });
});

// The production reader `start()` injects as `serveAgentsMetaEnv` — the ONE place
// that names `DKG_SERVE_AGENTS_META` and reads it from `process.env`. Guarded here
// because `start()` itself is not unit-drivable (real libp2p/store), so without this
// a typo'd var name or a snapshot would silently disable the #1233 kill-switch.
describe('readServeAgentsMetaEnv (production serve-skip env reader)', () => {
  const original = process.env.DKG_SERVE_AGENTS_META;
  afterEach(() => {
    if (original === undefined) delete process.env.DKG_SERVE_AGENTS_META;
    else process.env.DKG_SERVE_AGENTS_META = original;
  });

  it('reads DKG_SERVE_AGENTS_META from process.env, fresh per call', () => {
    delete process.env.DKG_SERVE_AGENTS_META;
    expect(readServeAgentsMetaEnv()).toBeUndefined();
    process.env.DKG_SERVE_AGENTS_META = '1';
    expect(readServeAgentsMetaEnv()).toBe('1'); // same fn, re-read → runtime-hot
    process.env.DKG_SERVE_AGENTS_META = '0';
    expect(readServeAgentsMetaEnv()).toBe('0');
  });
});
