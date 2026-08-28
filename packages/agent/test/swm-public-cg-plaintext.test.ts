/**
 * Regression coverage for the WM→SWM promote / publish gating bug on a
 * PUBLIC-on-chain context graph that carries a `DKG_ALLOWED_AGENT` list.
 *
 * On a public CG the allowedAgent list governs *publish authority*
 * (`publishPolicy`), not *read access*. The store-only recipient resolver
 * (`resolveWorkspaceAgentRecipients`) can't see chain truth, so it flags
 * any allowlisted CG as requiring encryption — which then bootstraps a
 * sender-key handshake that non-gated recipients reject ("not DKG-agent
 * gated"), surfacing as an HTTP 500 on promote (and later on publish).
 *
 * The fix gates the SWM-encryption decision on the CG's on-chain access
 * policy — but only AFTER a LIVE on-chain proof. A definitively-public,
 * LIVE CG (policy 0) takes the plaintext path regardless of any allowedAgent
 * list, while curated / invite-only / unknown / not-live CGs keep encrypting
 * (fail-closed). The liveness gate is essential: chain adapters return
 * access-policy 0 (= public) for UNKNOWN ids (Solidity default-zero), and
 * every local signal (policy cache, rehydrated subscription, persisted
 * `...OnChainId` triple, local `accessPolicy` literal) can be stale or
 * probe-poisoned after a devnet reset / partial registration.
 */
import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/dkg-agent.js';

// Hand-rolled call recorder: records every invocation's args and delegates to
// the real impl, replacing the DI-seam spies on this file's agent-like stub.
function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

type Policy = 0 | 1;

// Deterministic on-chain wire id (committed name-hash) for a cleartext CG id —
// mirrors registration, which ALWAYS commits keccak256(utf8(id)) (no
// hex-passthrough), matching the agent's localCgMatchesOnChainSlot derivation.
const wireId = (cgId: string): string =>
  ethers.keccak256(ethers.toUtf8Bytes(cgId)).toLowerCase();

function makeAgentLike(opts: {
  onChainId?: string | null;
  accessPolicy?: Policy;
  accessPolicyError?: Error;
  exposeAccessPolicy?: boolean;
  cache?: Map<string, number>;
  isPrivate?: boolean;
  onChainIdError?: Error;
  // chain.isContextGraphActiveOnChain liveness probe — the GATE that any
  // "public ⇒ plaintext" decision now depends on. `true` (default) → the slot
  // is registered & live; `false` → unknown / stale / not live; `'absent'` →
  // the probe isn't implemented (older chain adapter); Error → the probe throws.
  activeOnChain?: boolean | 'absent' | Error;
  // chain.getContextGraphNameHash — the on-chain committed identity anchor used
  // by the local-mapping identity binding. When OMITTED the getter is absent
  // (binding is a no-op: identity can't be disproven → proceeds to liveness).
  // Provide a hex string to assert a specific committed name-hash, `null` to
  // simulate the curator opting out of the on-chain commitment, or an Error to
  // simulate the getter rejecting.
  onChainNameHash?: string | null | Error;
  // Whether a LOCAL context graph with the queried id exists (binds
  // this.contextGraphExists). Used to prove that a numeric-named local CG which
  // isn't registered on-chain stays 'unregistered' (plaintext) rather than
  // being misread as a raw on-chain slot. OMITTED → the getter is absent (the
  // bare-decimal raw-slot path is taken, as before).
  localCgExists?: boolean;
  // Make this.contextGraphExists REJECT, to prove a flaked existence check
  // fails closed (→ 'unknown') instead of being read as "no local CG".
  localCgExistsError?: Error;
  // Stage a host-only/core wire-id-keyed subscription record (onChainHash === id
  // + reverse index pointing the wire id at itself) so localCgMatchesOnChainSlot
  // is licensed to accept this id's VERBATIM form against the committed
  // name-hash (#884 review GaZky). Without it a 0x+64-hex id is treated as
  // cleartext and must match keccak256(utf8(id)).
  wireKeyedLocalId?: string;
} = {}) {
  const log = {
    info: recorder(() => undefined),
    warn: recorder(() => undefined),
    error: recorder(() => undefined),
    debug: recorder(() => undefined),
  };
  const chain: Record<string, unknown> = {};
  if (opts.exposeAccessPolicy !== false) {
    chain.getContextGraphAccessPolicy = recorder(async (_id: bigint) => {
      if (opts.accessPolicyError) throw opts.accessPolicyError;
      return opts.accessPolicy ?? 0;
    });
  }
  if (opts.activeOnChain !== 'absent') {
    chain.isContextGraphActiveOnChain = recorder(async (_id: bigint) => {
      if (opts.activeOnChain instanceof Error) throw opts.activeOnChain;
      // Default true: a registered, live slot. Tests opt out with `false`.
      return opts.activeOnChain ?? true;
    });
  }
  if ('onChainNameHash' in opts) {
    chain.getContextGraphNameHash = recorder(async (_id: bigint) => {
      if (opts.onChainNameHash instanceof Error) throw opts.onChainNameHash;
      return opts.onChainNameHash ?? null;
    });
  }
  // The store resolver (resolveWorkspaceAgentRecipients) is the only consumer
  // of store.query on these paths; an empty result → no allowlist → it returns
  // requiresEncryption=false while still proving it WAS consulted (delegation).
  const storeQuery = recorder(async () => ({ type: 'bindings', bindings: [] as unknown[] }));
  const subscribedContextGraphs = new Map<string, { onChainHash?: string }>();
  const wireIdToLocalCgId = new Map<string, string>();
  if (opts.wireKeyedLocalId) {
    const lower = opts.wireKeyedLocalId.toLowerCase();
    subscribedContextGraphs.set(opts.wireKeyedLocalId, { onChainHash: lower });
    wireIdToLocalCgId.set(lower, opts.wireKeyedLocalId);
  }
  const agentLike: any = {
    log,
    chain,
    store: { query: storeQuery },
    subscribedContextGraphs,
    wireIdToLocalCgId,
    onChainAccessPolicyCache: opts.cache ?? new Map<string, number>(),
    getContextGraphOnChainId: recorder(async () => {
      if (opts.onChainIdError) throw opts.onChainIdError;
      // `undefined` opt → default to a resolvable numeric id; explicit
      // `null` → unresolvable (no local CG with this id).
      return opts.onChainId === undefined ? '1' : opts.onChainId;
    }),
    isPrivateContextGraph: recorder(async () => opts.isPrivate ?? false),
  };
  if ('localCgExists' in opts || opts.localCgExistsError) {
    agentLike.contextGraphExists = recorder(async () => {
      if (opts.localCgExistsError) throw opts.localCgExistsError;
      return opts.localCgExists ?? false;
    });
  }
  // Bind the prototype methods under test so `this` resolves to agentLike.
  agentLike.isContextGraphPublicOnChain = (DKGAgent.prototype as any).isContextGraphPublicOnChain;
  agentLike.resolveOnChainAccessPolicyState = (DKGAgent.prototype as any).resolveOnChainAccessPolicyState;
  agentLike.localCgMatchesOnChainSlot = (DKGAgent.prototype as any).localCgMatchesOnChainSlot;
  agentLike.isWireIdKeyedSubscription = (DKGAgent.prototype as any).isWireIdKeyedSubscription;
  agentLike.readLiveOnChainAccessPolicy = (DKGAgent.prototype as any).readLiveOnChainAccessPolicy;
  agentLike.raceChainPolicyRead = (DKGAgent.prototype as any).raceChainPolicyRead;
  agentLike.resolveWorkspaceRecipientsGated = (DKGAgent.prototype as any).resolveWorkspaceRecipientsGated;
  agentLike._resolveCuratedChainKeyContext = (DKGAgent.prototype as any)._resolveCuratedChainKeyContext;
  return agentLike;
}

const isPublic = (a: any, cgId = '0xCURATOR/experimental-music') =>
  (DKGAgent.prototype as any).isContextGraphPublicOnChain.call(a, cgId);

describe('DKGAgent.isContextGraphPublicOnChain', () => {
  it('preserves the legacy strict binding option while retryable strict reads propagate transport errors', async () => {
    const cgId = '0xCURATOR/experimental-music';
    const agentLike = makeAgentLike({ onChainId: '5', accessPolicy: 0 });
    const legacyBinding = (DKGAgent.prototype as any).localCgMatchesOnChainSlot;
    const retryableStrictBinding = (DKGAgent.prototype as any).requireLocalCgMatchesOnChainSlot;

    await expect(legacyBinding.call(agentLike, cgId, 'not-a-slot')).resolves.toBe(true);
    await expect(legacyBinding.call(
      agentLike,
      cgId,
      'not-a-slot',
      undefined,
      { bindingMode: 'chain-attested-repair' },
    )).resolves.toBe(false);

    delete agentLike.chain.getContextGraphNameHash;
    await expect(legacyBinding.call(agentLike, cgId, '5')).resolves.toBe(true);
    await expect(legacyBinding.call(
      agentLike,
      cgId,
      '5',
      undefined,
      { requireCommittedNameHash: true },
    )).resolves.toBe(false);
    await expect(legacyBinding.call(
      agentLike,
      cgId,
      '5',
      undefined,
      { bindingMode: 'chain-attested-repair' },
    )).resolves.toBe(false);
    await expect(legacyBinding.call(
      agentLike,
      cgId,
      '5',
      undefined,
      { requireCommittedNameHash: true, bindingMode: 'legacy-policy' },
    )).rejects.toThrow(/contradicts/u);

    const transportError = Object.assign(new Error('name-hash RPC unavailable'), {
      code: 'RPC_ENDPOINTS_EXHAUSTED',
    });
    agentLike.chain.getContextGraphNameHash = async () => { throw transportError; };
    await expect(legacyBinding.call(
      agentLike,
      cgId,
      '5',
      undefined,
      { bindingMode: 'chain-attested-repair' },
    )).rejects.toBe(transportError);
    await expect(retryableStrictBinding.call(agentLike, cgId, '5'))
      .rejects.toBe(transportError);
  });

  it('returns true for a LIVE CG whose on-chain access policy is public (0)', async () => {
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 0 });
    await expect(isPublic(agentLike)).resolves.toBe(true);
    expect((agentLike.chain.isContextGraphActiveOnChain as any).calls.at(-1)).toEqual([1n]);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls.at(-1)).toEqual([1n]);
    expect(agentLike.onChainAccessPolicyCache.get('1')).toBe(0);
  });

  it('returns false for a LIVE CG whose on-chain access policy is private (1)', async () => {
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 1 });
    await expect(isPublic(agentLike)).resolves.toBe(false);
    expect(agentLike.onChainAccessPolicyCache.get('1')).toBe(1);
  });

  it('does NOT trust a stale access-policy cache for the downgrade — reads FRESH (#884 review GZEqI)', async () => {
    // A value cached as public (0) on a prior devnet must NOT force a CG that
    // is now private onto the plaintext path. After the liveness proof the
    // policy is read FRESH from chain: cache says 0, chain says 1 (private) →
    // fail closed. The fresh value also replaces the stale cache entry.
    const cache = new Map<string, number>([['1', 0]]);
    const agentLike = makeAgentLike({ onChainId: '1', cache, accessPolicy: 1 });
    await expect(isPublic(agentLike)).resolves.toBe(false);
    expect((agentLike.chain.isContextGraphActiveOnChain as any).calls.at(-1)).toEqual([1n]);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls.at(-1)).toEqual([1n]);
    expect(agentLike.onChainAccessPolicyCache.get('1')).toBe(1);
  });

  it('IDENTITY-BINDS a locally-resolved id: on-chain name-hash MATCHES → public (#884 review GZEqF)', async () => {
    // The local mapping resolves cgId → on-chain id 5; the slot's committed
    // name-hash matches this CG's deterministic wire id, proving slot 5 still
    // IS this CG, so the live public policy is honored.
    const cgId = '0xCURATOR/experimental-music';
    const agentLike = makeAgentLike({ onChainId: '5', accessPolicy: 0, onChainNameHash: wireId(cgId) });
    await expect(isPublic(agentLike, cgId)).resolves.toBe(true);
    expect((agentLike.chain.getContextGraphNameHash as any).calls.at(-1)).toEqual([5n]);
  });

  it('fails closed when the locally-resolved slot commits a DIFFERENT name-hash (stale/reused slot) (#884 review GZEqF)', async () => {
    // After a devnet reset, the persisted mapping cgId → 5 points at a slot now
    // occupied by an UNRELATED public CG. Its committed name-hash differs from
    // this CG's wire id → stale mapping → fail closed BEFORE reading policy.
    const cgId = '0xCURATOR/experimental-music';
    const agentLike = makeAgentLike({ onChainId: '5', accessPolicy: 0, onChainNameHash: wireId('0xOTHER/unrelated-cg') });
    await expect(isPublic(agentLike, cgId)).resolves.toBe(false);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls).toEqual([]);
    expect(agentLike.log.warn.calls).toContainEqual([
      expect.anything(),
      expect.stringContaining('STALE'),
    ]);
  });

  it('preserves the compatibility self-address outside strict repair', async () => {
    // Existing publish/share and durable verification paths still accept a
    // local numeric self-address. Chain-attested metadata repair alone opts
    // into the stricter name-hash proof.
    const agentLike = makeAgentLike({ onChainId: '7', accessPolicy: 0, onChainNameHash: null });
    await expect(isPublic(agentLike, '7')).resolves.toBe(true);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls.at(-1)).toEqual([7n]);
    expect((agentLike.chain.getContextGraphNameHash as any).calls).toEqual([]);

    const retryableStrictBinding = (DKGAgent.prototype as any)
      .requireLocalCgMatchesOnChainSlot;
    await expect(retryableStrictBinding.call(agentLike, '7', '7')).resolves.toBe(true);
    expect((agentLike.chain.getContextGraphNameHash as any).calls).toEqual([]);
  });

  it('fails closed when a CLEARTEXT-mapped slot has NO committed name-hash (#884 review GaZk2)', async () => {
    // A locally-mapped slot with NO on-chain name commitment (null) is NOT an
    // identity proof: after a devnet reset the persisted mapping could point at a
    // DIFFERENT public CG that also never committed a name-hash. A downgrade
    // (encrypt→plaintext) decision must fail closed without an affirmative
    // binding, so the policy is never even read.
    const cgId = '0xCURATOR/experimental-music';
    const agentLike = makeAgentLike({ onChainId: '5', accessPolicy: 0, onChainNameHash: null });
    await expect(isPublic(agentLike, cgId)).resolves.toBe(false);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls).toEqual([]);
  });

  it('matches a HOST-MODE wire-id-keyed local CG whose committed hash IS the id itself (#884 review GaJf_/GaZky)', async () => {
    // Host-only/core subscriptions are keyed by the wire id (the 64-hex hash);
    // the local id ALREADY is the committed nameHash, so it must NOT be
    // re-hashed (that would force a legitimate public CG onto the encrypted path
    // forever). The verbatim form is accepted ONLY because local metadata
    // (onChainHash === id) affirmatively proves the subscription is wire-id keyed.
    const wireKeyedId = '0x' + 'ab'.repeat(32);
    const agentLike = makeAgentLike({
      onChainId: '5',
      accessPolicy: 0,
      onChainNameHash: wireKeyedId,
      wireKeyedLocalId: wireKeyedId,
    });
    await expect(isPublic(agentLike, wireKeyedId)).resolves.toBe(true);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls.at(-1)).toEqual([5n]);
  });

  it('fails closed for a hash-shaped id with NO wire-keyed metadata whose slot commits the verbatim hash (#884 review GaZky)', async () => {
    // A user-chosen id that merely LOOKS 0x+64-hex is cleartext; without the
    // affirmative wire-id-keyed signal the verbatim branch is NOT licensed, so a
    // reused/unrelated slot whose committed nameHash equals that raw string must
    // NOT impersonate this CG. Only keccak256(utf8(id)) is acceptable → mismatch
    // → fail closed before reading policy.
    const hexShaped = '0x' + 'ef'.repeat(32);
    const agentLike = makeAgentLike({ onChainId: '5', accessPolicy: 0, onChainNameHash: hexShaped });
    await expect(isPublic(agentLike, hexShaped)).resolves.toBe(false);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls).toEqual([]);
    expect(agentLike.log.warn.calls).toContainEqual([
      expect.anything(),
      expect.stringContaining('STALE'),
    ]);
  });

  it('matches a hex-SHAPED CLEARTEXT id committed as keccak256(utf8(id)) (#884 review GZumc)', async () => {
    // A user-chosen id that merely LOOKS like 0x+64-hex is still cleartext;
    // registration commits keccak256(utf8(id)). Identity is proven via the
    // cleartext derivation (the other acceptable form).
    const hexCleartext = '0x' + 'cd'.repeat(32);
    const committed = ethers.keccak256(ethers.toUtf8Bytes(hexCleartext)).toLowerCase();
    const agentLike = makeAgentLike({ onChainId: '5', accessPolicy: 0, onChainNameHash: committed });
    await expect(isPublic(agentLike, hexCleartext)).resolves.toBe(true);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls.at(-1)).toEqual([5n]);
  });

  it('keeps a hash-shaped cleartext subscription bound to keccak(utf8(id)), not its raw reverse-index key', async () => {
    const hexCleartext = '0x' + 'bc'.repeat(32);
    const committed = ethers.keccak256(ethers.toUtf8Bytes(hexCleartext)).toLowerCase();
    const matching = makeAgentLike({
      onChainId: '5',
      accessPolicy: 0,
      onChainNameHash: committed,
    });
    matching.subscribedContextGraphs.set(hexCleartext, {
      subscribed: true,
      synced: false,
    });
    // setContextGraphSubscription maintains this general reverse lookup for
    // every subscription. It is routing metadata, not proof that the local id
    // is host-only/wire-keyed.
    matching.wireIdToLocalCgId.set(hexCleartext, hexCleartext);
    await expect(isPublic(matching, hexCleartext)).resolves.toBe(true);

    const rawOnly = makeAgentLike({
      onChainId: '5',
      accessPolicy: 0,
      onChainNameHash: hexCleartext,
    });
    rawOnly.subscribedContextGraphs.set(hexCleartext, {
      subscribed: true,
      synced: false,
    });
    rawOnly.wireIdToLocalCgId.set(hexCleartext, hexCleartext);
    await expect(isPublic(rawOnly, hexCleartext)).resolves.toBe(false);
    expect((rawOnly.chain.getContextGraphAccessPolicy as any).calls).toEqual([]);
  });

  it('fails closed when the name-hash getter is PRESENT but REJECTS — identity unverifiable (#884 review GZ8L_)', async () => {
    // The adapter exposes getContextGraphNameHash, so an RPC rejection means we
    // cannot prove the local mapping still points at this CG. A transient flake
    // must NOT re-enable the plaintext downgrade for a possibly reused slot →
    // fail closed BEFORE the policy read.
    const cgId = '0xCURATOR/experimental-music';
    const agentLike = makeAgentLike({ onChainId: '5', accessPolicy: 0, onChainNameHash: new Error('name-hash rpc down') });
    await expect(isPublic(agentLike, cgId)).resolves.toBe(false);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls).toEqual([]);
  });

  it('fails closed when the name-hash read TIMES OUT — identity unverifiable (#884 review GZ8L_)', async () => {
    vi.useFakeTimers();
    try {
      const cgId = '0xCURATOR/experimental-music';
      const agentLike = makeAgentLike({ onChainId: '5', accessPolicy: 0, onChainNameHash: '0x' + '00'.repeat(32) });
      // Override with a hung read so the bounded race trips the timeout path.
      agentLike.chain.getContextGraphNameHash = recorder(() => new Promise(() => {}));
      const pending = isPublic(agentLike, cgId);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toBe(false);
      expect((agentLike.chain.getContextGraphAccessPolicy as any).calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT identity-bind a BARE-NUMERIC id (caller addresses the slot directly) (#884 review GZEqF)', async () => {
    // share('42') is the caller explicitly naming on-chain slot 42 — there is
    // no local CG identity to re-bind, so name-hash binding is skipped even if
    // a (mismatching) commitment exists. Liveness + fresh policy still gate it.
    const agentLike = makeAgentLike({ onChainId: null, accessPolicy: 0, onChainNameHash: wireId('mismatch') });
    await expect(isPublic(agentLike, '42')).resolves.toBe(true);
    expect((agentLike.chain.getContextGraphNameHash as any).calls).toEqual([]);
  });

  it('fails closed (false) when the on-chain id cannot be resolved', async () => {
    const agentLike = makeAgentLike({ onChainId: null });
    await expect(isPublic(agentLike)).resolves.toBe(false);
    expect((agentLike.chain.isContextGraphActiveOnChain as any).calls).toEqual([]);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls).toEqual([]);
  });

  it('fails closed (false) when the chain access-policy getter is missing', async () => {
    const agentLike = makeAgentLike({ onChainId: '1', exposeAccessPolicy: false });
    await expect(isPublic(agentLike)).resolves.toBe(false);
  });

  it('fails closed (false) when the chain RPC throws', async () => {
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicyError: new Error('rpc unavailable') });
    await expect(isPublic(agentLike)).resolves.toBe(false);
  });

  it('fails closed (false) when on-chain id resolution throws', async () => {
    const agentLike = makeAgentLike({ onChainIdError: new Error('store offline') });
    await expect(isPublic(agentLike)).resolves.toBe(false);
  });

  it('fails closed when the slot is NOT live on-chain — never reads (default-zero) policy (#884 review)', async () => {
    // The core safety gate. A resolvable id (local mapping or bare numeric)
    // that the chain reports as NOT active must NOT be trusted: an unregistered
    // id reads back access-policy 0 (Solidity default-zero) and would leak
    // plaintext. Liveness fails → fail closed, no policy read.
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 0, activeOnChain: false });
    await expect(isPublic(agentLike)).resolves.toBe(false);
    expect((agentLike.chain.isContextGraphActiveOnChain as any).calls.at(-1)).toEqual([1n]);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls).toEqual([]);
  });

  it('fails closed when no liveness probe is available (older chain adapter) (#884 review)', async () => {
    // Without isContextGraphActiveOnChain we cannot prove the slot is live, so
    // we never trust a (possibly default-zero / stale) access policy.
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 0, activeOnChain: 'absent' });
    await expect(isPublic(agentLike)).resolves.toBe(false);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls).toEqual([]);
  });

  it('fails closed when the liveness probe throws (#884 review)', async () => {
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 0, activeOnChain: new Error('rpc flake') });
    await expect(isPublic(agentLike)).resolves.toBe(false);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls).toEqual([]);
  });

  it('trusts a bare numeric on-chain id only after a LIVE proof — public CG stays plaintext (#884 numeric-id case)', async () => {
    // `getContextGraphOnChainId` returns null for a bare numeric id (no local
    // CG by that name). A public registered CG addressed by its numeric
    // on-chain id — e.g. share('42', ...) — must still be detected as public,
    // but ONLY because the chain confirms slot 42 is live & public.
    const agentLike = makeAgentLike({ onChainId: null, accessPolicy: 0, activeOnChain: true });
    await expect(isPublic(agentLike, '42')).resolves.toBe(true);
    expect((agentLike.chain.isContextGraphActiveOnChain as any).calls.at(-1)).toEqual([42n]);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls.at(-1)).toEqual([42n]);
    expect(agentLike.onChainAccessPolicyCache.get('42')).toBe(0);
  });

  it('does NOT trust an UNKNOWN numeric id (unregistered / not live) — fail-closed (#884 review)', async () => {
    // A local graph whose user-chosen id is numeric (e.g.
    // createContextGraph({ id: "42", private: true })) but is NOT registered
    // reports not-live on-chain. The bare-numeric path must fail closed even
    // though the chain would default an unknown id to policy 0.
    const agentLike = makeAgentLike({ onChainId: null, accessPolicy: 0, activeOnChain: false });
    await expect(isPublic(agentLike, '42')).resolves.toBe(false);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls).toEqual([]);
  });

  it('returns false for a LIVE numeric on-chain id whose policy is private (#884 fail-closed)', async () => {
    const agentLike = makeAgentLike({ onChainId: null, accessPolicy: 1, activeOnChain: true });
    await expect(isPublic(agentLike, '7')).resolves.toBe(false);
    expect((agentLike.chain.isContextGraphActiveOnChain as any).calls.at(-1)).toEqual([7n]);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls.at(-1)).toEqual([7n]);
  });

  it('resolves a REGISTERED numeric-named local CG to its mapped on-chain policy (#884 review)', async () => {
    // Local-id resolution is AUTHORITATIVE for ADDRESSING: a registered CG
    // whose user-chosen local id happens to be numeric ("42") maps to its
    // actual on-chain id (here "99"). The helper proves slot 99 is live, then
    // reads policy for that mapped id — it never regresses a genuinely-
    // registered local graph onto the encrypted path just because its local id
    // looks like a number, nor reads policy for the wrong (bare "42") slot.
    const agentLike = makeAgentLike({ onChainId: '99', accessPolicy: 0, activeOnChain: true });
    await expect(isPublic(agentLike, '42')).resolves.toBe(true);
    expect(agentLike.getContextGraphOnChainId.calls.at(-1)).toEqual(['42']);
    expect((agentLike.chain.isContextGraphActiveOnChain as any).calls.at(-1)).toEqual([99n]);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls.at(-1)).toEqual([99n]);
  });

  it('logs a diagnostic (not silent) when a lookup flakes before failing closed (#884 review 🟡)', async () => {
    const agentLike = makeAgentLike({ accessPolicyError: new Error('rpc unavailable') });
    await expect(isPublic(agentLike)).resolves.toBe(false);
    // Operators get a signal explaining WHY the public override was skipped.
    expect(agentLike.log.warn.calls).toContainEqual([
      expect.anything(),
      expect.stringContaining('isContextGraphPublicOnChain'),
    ]);
  });

  it('bounds the liveness read — a HUNG RPC fails closed instead of hanging (#884 review)', async () => {
    vi.useFakeTimers();
    try {
      const agentLike = makeAgentLike({ onChainId: '1' });
      // Liveness probe hangs (never resolves / never rejects) instead of failing.
      agentLike.chain.isContextGraphActiveOnChain = recorder(() => new Promise(() => {}));
      const pending = isPublic(agentLike);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toBe(false);
      expect(agentLike.log.warn.calls).toContainEqual([
        expect.anything(),
        expect.stringContaining('timed out'),
      ]);
      // A hung liveness read must never reach the policy read.
      expect((agentLike.chain.getContextGraphAccessPolicy as any).calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the access-policy read — a HUNG RPC fails closed instead of hanging (#884 review)', async () => {
    vi.useFakeTimers();
    try {
      const agentLike = makeAgentLike({ onChainId: '1' });
      // Liveness resolves (live), but the policy read hangs.
      agentLike.chain.getContextGraphAccessPolicy = recorder(() => new Promise(() => {}));
      const pending = isPublic(agentLike);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toBe(false);
      expect(agentLike.log.warn.calls).toContainEqual([
        expect.anything(),
        expect.stringContaining('timed out'),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DKGAgent.resolveWorkspaceRecipientsGated (gate-before)', () => {
  it('returns plaintext for a LIVE public CG WITHOUT resolving recipient keys', async () => {
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 0 });
    const resolution = await (DKGAgent.prototype as any).resolveWorkspaceRecipientsGated.call(
      agentLike,
      { contextGraphId: '0xCURATOR/experimental-music' },
    );
    expect(resolution).toEqual({ requiresEncryption: false, recipients: [] });
    // The store resolver MUST be skipped — a public CG never resolves
    // recipient keys (which would otherwise throw "Missing public
    // encryption key" for an allowlisted agent whose key isn't local).
    expect(agentLike.store.query.calls).toEqual([]);
  });

  it('delegates to the store resolver for a non-public (curated) CG', async () => {
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 1 });
    const resolution = await (DKGAgent.prototype as any).resolveWorkspaceRecipientsGated.call(
      agentLike,
      { contextGraphId: '0xCURATOR/curated-cg' },
    );
    // Empty store bindings → no allowedAgents → store resolver returns
    // requiresEncryption=false, but it WAS consulted (delegation path).
    expect(resolution.requiresEncryption).toBe(false);
    expect(agentLike.store.query.calls.length).toBeGreaterThan(0);
  });

  it('delegates to the store resolver when the policy is unknown (fail-closed to encrypted path)', async () => {
    const agentLike = makeAgentLike({ onChainId: null });
    await (DKGAgent.prototype as any).resolveWorkspaceRecipientsGated.call(
      agentLike,
      { contextGraphId: '0xCURATOR/unknown-cg' },
    );
    expect(agentLike.store.query.calls.length).toBeGreaterThan(0);
  });

  it('delegates (encrypted path) when the on-chain probe cannot prove the CG is live — NO local-metadata bypass (#884 review)', async () => {
    // A local accessPolicy="public" literal (or any local signal) must NOT
    // override a failed on-chain liveness proof: a pre-registration / stale
    // local graph would otherwise leak allowlisted traffic in plaintext. With
    // liveness false we delegate to the store resolver (encrypted path).
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 0, activeOnChain: false });
    await (DKGAgent.prototype as any).resolveWorkspaceRecipientsGated.call(
      agentLike,
      { contextGraphId: '0xCURATOR/not-yet-live' },
    );
    expect(agentLike.store.query.calls.length).toBeGreaterThan(0);
  });

  it('returns plaintext for a LIVE public CG addressed by its numeric on-chain id WITHOUT the store resolver (#884)', async () => {
    // The end-to-end shape of the bug: share('42', ...) on a public,
    // registered & live CG must take the plaintext path. Pre-fix, the numeric
    // id didn't resolve, isContextGraphPublicOnChain returned false, and this
    // fell through to resolveWorkspaceAgentRecipients (the encrypted/gated
    // path that triggered the HTTP 500).
    const agentLike = makeAgentLike({ onChainId: null, accessPolicy: 0, activeOnChain: true });
    const resolution = await (DKGAgent.prototype as any).resolveWorkspaceRecipientsGated.call(
      agentLike,
      { contextGraphId: '42' },
    );
    expect(resolution).toEqual({ requiresEncryption: false, recipients: [] });
    expect(agentLike.store.query.calls).toEqual([]);
  });
});

describe('DKGAgent publish-inline gating respects on-chain public policy', () => {
  const resolveInline = (agentLike: any, cgId: string) =>
    (DKGAgent.prototype as any)._resolveEncryptInlinePayload.call(agentLike, cgId, undefined, undefined, undefined);

  it('keeps a public-on-chain CG on the plaintext path even when the allowlist heuristic marks it private', async () => {
    // `isPrivateContextGraph` returns true (its allowlist-implies-private
    // heuristic fires for a public CG with a publish-authority allowlist),
    // but the on-chain policy is public & live — the override must win.
    const agentLike = makeAgentLike({ onChainId: '1', accessPolicy: 0, isPrivate: true });
    await expect(resolveInline(agentLike, '0xCURATOR/experimental-music')).resolves.toBeUndefined();
    expect(agentLike.isPrivateContextGraph.calls).toEqual([]);
  });

  it('a REGISTERED local CG whose liveness cannot be proven fails CLOSED (throws) — not plaintext (#884 review GZh-c)', async () => {
    // getContextGraphOnChainId resolves the CG → slot 5 (it IS registered),
    // but the liveness probe reports not-live (devnet flake / mid-reset). The
    // shared resolver returns 'unknown' (NOT 'unregistered'), and with no local
    // curated signal the publish path must REFUSE rather than silently emit
    // plaintext for a CG that may be private on-chain. Pre-fix, the boolean
    // gate collapsed this UNKNOWN to "not public" and the non-numeric branch
    // defaulted to the plaintext-inline path.
    const agentLike = makeAgentLike({ onChainId: '5', accessPolicy: 1, activeOnChain: false, isPrivate: false });
    await expect(resolveInline(agentLike, '0xCURATOR/experimental-music')).rejects.toThrow(
      /publish access-policy is unknown/,
    );
  });

  it('a REGISTERED local CG with an UNKNOWN policy but a positive local curated signal stays curated (safe) (#884 review GZh-c)', async () => {
    // Same unprovable-liveness case, but the local allowlist-implies-private
    // heuristic fires. Encrypting is never a leak, so probeIsCurated returns
    // curated=true instead of refusing — proving 'unknown' does NOT blanket-
    // reject when a safe positive signal exists. It then proceeds PAST the
    // policy probe into the sender-key bootstrap, which this lightweight
    // harness doesn't stub, so it rejects with a NON-"unknown" error.
    const agentLike = makeAgentLike({ onChainId: '5', activeOnChain: false, isPrivate: true });
    let err: unknown;
    try {
      await resolveInline(agentLike, '0xCURATOR/experimental-music');
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect((err as Error).message).not.toMatch(/publish access-policy is unknown/);
    expect(agentLike.isPrivateContextGraph.calls.length).toBeGreaterThan(0);
  });

  it('keeps a NUMERIC-named LOCAL CG that is not yet registered on the plaintext path — NOT a raw slot (#884 review GZumY)', async () => {
    // createContextGraph({ id: "42" }) that hasn't been registered on-chain:
    // getContextGraphOnChainId('42') → null and the slot is not live, but a
    // LOCAL CG named "42" exists. The bare-decimal raw-slot path must NOT fire
    // (that would yield 'unknown' → throw); local existence proves it's a pure-
    // local CG → 'unregistered' → plaintext-inline (publish proceeds, no throw).
    const agentLike = makeAgentLike({ onChainId: null, activeOnChain: false, localCgExists: true });
    await expect(resolveInline(agentLike, '42')).resolves.toBeUndefined();
    expect(agentLike.contextGraphExists.calls.at(-1)).toEqual(['42']);
    // It never reached the on-chain liveness/policy reads (no raw-slot probe).
    expect((agentLike.chain.isContextGraphActiveOnChain as any).calls).toEqual([]);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls).toEqual([]);
  });

  it('still treats a bare numeric id with NO local CG as a raw on-chain slot (share(\'42\')) (#884 review GZumY)', async () => {
    // The complementary case: no local CG named "42", so "42" IS the caller
    // addressing on-chain slot 42 directly. A live public slot → plaintext.
    const agentLike = makeAgentLike({ onChainId: null, accessPolicy: 0, activeOnChain: true, localCgExists: false });
    await expect(resolveInline(agentLike, '42')).resolves.toBeUndefined();
    expect((agentLike.chain.isContextGraphActiveOnChain as any).calls.at(-1)).toEqual([42n]);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls.at(-1)).toEqual([42n]);
  });

  it('fails CLOSED when the local-existence check for a bare numeric id FLAKES — never the raw-slot guess (#884 review GZ8L5)', async () => {
    // contextGraphExists('42') rejects. We must NOT fall through to the raw-slot
    // path (slot 42 could be a live public CG and we'd force the WRONG graph
    // onto plaintext). The publish path refuses ('unknown' → throws) rather than
    // guessing.
    const agentLike = makeAgentLike({ onChainId: null, accessPolicy: 0, activeOnChain: true, localCgExistsError: new Error('store offline') });
    await expect(resolveInline(agentLike, '42')).rejects.toThrow(/publish access-policy is unknown/);
    expect((agentLike.chain.isContextGraphActiveOnChain as any).calls).toEqual([]);
    expect((agentLike.chain.getContextGraphAccessPolicy as any).calls).toEqual([]);
  });
});
