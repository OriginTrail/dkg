/**
 * the public `DKGService`
 * surface was widened to expose `persistChatTurn` / `onChatTurn`
 * as split user-turn / assistant-reply overloads so that downstream
 * TypeScript callers see the runtime contract at COMPILE TIME
 * instead of discovering it via a runtime `throw`.
 *
 * These tests pin two things:
 *
 *   1. The runtime behaviour is unchanged — well-typed callers still
 *      route through `persistChatTurnImpl` and get the same
 *      `{ tripleCount, turnUri, kcId }` result shape.
 *
 *   2. The type-level contract itself is enforced — a well-typed
 *      user-turn caller that forgets `message.id` fails to compile,
 *      and a well-typed assistant-reply caller that forgets
 *      `options.userMessageId` fails to compile. The `ts-expect-error`
 *      directives embedded below do exactly that — if a future
 *      refactor ever loosens the overloads, these lines will flip
 *      from "suppressing a real error" to "suppressing nothing"
 *      and the file will fail to compile, which `pnpm build` will
 *      surface in CI.
 *
 * Runtime-level pinning of the underlying persister semantics
 * (user-turn vs assistant-reply branching, ID fabrication guard,
 * URI collisions, etc.) lives in `actions-behavioral.test.ts` and
 * `plugin.test.ts` and remains the source of truth for behaviour.
 * This file deliberately focuses on the *type* contract the bot
 * flagged.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { _dkgServiceLoose, dkgService, dkgServiceLegacy } from '../src/service.js';
import type {
  AssistantReplyChatTurnOptions,
  ChatTurnPersistResult,
  DKGService,
  DKGServiceLoose,
  UserTurnChatTurnOptions,
} from '../src/service.js';
import type { IAgentRuntime, Memory, PersistableMemory, State } from '../src/types.js';

function makeRuntime(): IAgentRuntime {
  return {
    character: { name: 'r18-2-test' },
    getSetting: () => undefined,
  };
}

function makePersistableMemory(): PersistableMemory {
  return {
    id: 'msg-r18-2-persistable',
    userId: 'user-r18-2',
    agentId: 'agent-r18-2',
    roomId: 'room-r18-2',
    content: { text: 'user turn' },
    createdAt: Date.now(),
  };
}

function makePlainMemoryWithoutId(): Memory {
  return {
    userId: 'user-r18-2',
    agentId: 'agent-r18-2',
    roomId: 'room-r18-2',
    content: { text: 'assistant reply' },
    createdAt: Date.now(),
  };
}

describe('DKGService overload contract', () => {
  it('exposes the runtime object under the narrowed DKGService interface', () => {
    // Sanity: the exported symbol carries the right `name` and the
    // two method hooks. Using `typeof` here also keeps TypeScript's
    // structural check honest — if the export lost either method
    // the line below wouldn't compile.
    const svc: DKGService = dkgService;
    expect(svc.name).toBe('dkg-node');
    expect(typeof svc.persistChatTurn).toBe('function');
    expect(typeof svc.onChatTurn).toBe('function');
  });

  it('the user-turn overload requires a PersistableMemory (message.id: string) at COMPILE TIME', async () => {
    const runtime = makeRuntime();
    const userMsg = makePersistableMemory();
    const userOpts: UserTurnChatTurnOptions = { mode: 'user-turn' };

    // Positive control: well-typed user-turn call compiles and
    // routes through to the persister (which then rejects because
    // no agent is wired up — expected).
    await expect(
      dkgService.persistChatTurn(runtime, userMsg, {} as State, userOpts),
    ).rejects.toThrow(/DKG node not started/);

    // r18-2 negative control: a plain `Memory` WITHOUT a stable
    // `id` must NOT be assignable to `PersistableMemory`. This is
    // the one-line type assertion — the directive is on the line
    // immediately above the offending assignment, which is how
    // `@ts-expect-error` is scoped.
    const plainMemory: Memory = makePlainMemoryWithoutId();
    // @ts-expect-error r18-2: plain `Memory` cannot be assigned to
    // `PersistableMemory` because `id` is optional on the former
    // and required on the latter. If TS stops flagging this, the
    // type narrowing has regressed.
    const shouldFail: PersistableMemory = plainMemory;
    expect(shouldFail).toBeDefined();
  });

  it('the assistant-reply overload requires options.userMessageId at COMPILE TIME', async () => {
    const runtime = makeRuntime();
    const assistantMsg = makePlainMemoryWithoutId();
    // `userTurnPersisted` is now mandatory on the typed
    // assistant-reply overload. Explicit `false` is the safe default
    // a caller should pick when it genuinely doesn't know whether
    // the user-turn hook succeeded — it routes the persister
    // through the full-envelope branch which produces a readable
    // reply regardless.
    const replyOpts: AssistantReplyChatTurnOptions = {
      mode: 'assistant-reply',
      userMessageId: 'msg-r18-2-user-parent',
      userTurnPersisted: false,
    };

    // Happy path: mode + userMessageId + userTurnPersisted all
    // present. Compiles, rejects at runtime because no agent is
    // wired up — expected.
    await expect(
      dkgService.persistChatTurn(runtime, assistantMsg, {} as State, replyOpts),
    ).rejects.toThrow(/DKG node not started/);

    // @ts-expect-error r18-2: mode='assistant-reply' WITHOUT
    // userMessageId (and userTurnPersisted) is rejected because the
    // persister cannot reconstruct the parent turn key without it.
    const missingUserMsgId: AssistantReplyChatTurnOptions = { mode: 'assistant-reply' };
    // Reference the value so TS doesn't elide the check.
    expect(missingUserMsgId).toBeDefined();
  });

  it('the assistant-reply overload ALSO requires options.userTurnPersisted at COMPILE TIME', () => {
    // the typed
    // assistant-reply overload made `userMessageId` mandatory but
    // left `userTurnPersisted` optional. That reintroduced the
    // unreadable-reply footgun r13-1 closed: if a caller knew the
    // parent id but didn't know whether the user-turn hook
    // actually persisted, `persistChatTurnImpl` would infer
    // `userTurnPersisted=true` from the presence of `userMessageId`
    // alone (the legacyInference branch) and take the cheap
    // append-only path — which produces an orphan
    // `hasAssistantMessage` edge on a turn URI whose type quads
    // were never written, so the reader silently drops the reply.
    //
    // @ts-expect-error r19-2: the typed overload MUST reject this
    // call. If TS stops flagging it, the overload has regressed
    // and the append-only bug is back.
    const missingUserTurnPersisted: AssistantReplyChatTurnOptions = {
      mode: 'assistant-reply',
      userMessageId: 'msg-r19-2-user-parent',
    };
    expect(missingUserTurnPersisted).toBeDefined();

    // Positive control: explicit `false` compiles cleanly and
    // signals the safe full-envelope path.
    const safeDefault: AssistantReplyChatTurnOptions = {
      mode: 'assistant-reply',
      userMessageId: 'msg-r19-2-user-parent',
      userTurnPersisted: false,
    };
    expect(safeDefault.userTurnPersisted).toBe(false);

    // Positive control: explicit `true` also compiles (the in-process
    // ElizaOS hook chain that round 16 introduced knows the user
    // turn just persisted and opts into the cheap append path).
    const inProcessOptimised: AssistantReplyChatTurnOptions = {
      mode: 'assistant-reply',
      userMessageId: 'msg-r19-2-user-parent',
      userTurnPersisted: true,
    };
    expect(inProcessOptimised.userTurnPersisted).toBe(true);
  });

  it('onChatTurn mirrors persistChatTurn overloads (user-turn narrowing holds here too)', async () => {
    const runtime = makeRuntime();
    const userMsg = makePersistableMemory();

    // User-turn happy path via the hook alias. Same runtime-reject
    // pattern as the persistChatTurn tests above — we're locking
    // the TYPE contract, not the persister semantics.
    await expect(
      dkgService.onChatTurn(runtime, userMsg),
    ).rejects.toThrow(/DKG node not started/);

    // r18-2 negative control: the `onChatTurn` hook alias must
    // share the narrowed user-turn contract. Asserting the alias
    // signature is `typeof dkgService.persistChatTurn` locks the
    // two in lockstep so a future refactor that loosens one can't
    // silently leave the other with stricter types (or vice versa).
    const persistChatTurn: typeof dkgService.persistChatTurn = dkgService.onChatTurn;
    expect(typeof persistChatTurn).toBe('function');
  });

  // service.ts:133/180).
  //
  // History:
  //   - Pre-r30-8: `DKGService` carried a public `Record<string,
  //     unknown>` catch-all overload "for backwards compat". The
  //     catch-all silently accepted `{ mode: 'assistant-reply' }`
  //     literals missing the mandatory `userMessageId` /
  //     `userTurnPersisted` fields, defeating the typed overloads
  //     (r18-2 + r19-2). The runtime guard in `persistChatTurnImpl`
  //     still threw, but only AFTER the type check let the bad call
  //     through.
  //   - r30-8: the catch-all was REMOVED from the public surface and
  //     moved to the internal `DKGServiceLoose` handle (which the
  //     plugin uses for genuine framework-shaped routing). Source-
  //     breaking change for downstream TS consumers building options
  //     bags dynamically.
  //   - r31-2: the catch-all was RESTORED on the public surface as
  //     a `@deprecated` THIRD overload (sitting AFTER the strict
  //     overloads in declaration order, so the assumption was that
  //     well-typed callers would still bind to the strict contracts
  //     and only opaque dynamic-bag callers would fall through).
  //   - r31-3: the bot called THAT out as still reopening the
  //     smuggling hole. TypeScript's overload resolution algorithm
  //     reports an error only when NO declared signature matches —
  //     a `{ mode: 'assistant-reply' }` literal that fails the
  //     strict reply overload (missing `userMessageId` /
  //     `userTurnPersisted`) STILL satisfies the `Record<string,
  //     unknown>` catch-all on the same interface, so the call
  //     compiles. Declaration order doesn't fix that — TypeScript
  //     doesn't pick "the closest match"; it picks "any match",
  //     and a wide catch-all matches everything.
  //
  // Final shape: `DKGService` carries ONLY the two typed
  // overloads. The compile-time tolerance for dynamic-bag callers
  // moves to a SEPARATELY NAMED `dkgServiceLegacy` export (also
  // `@deprecated`, also routes to the same runtime impl). Callers
  // who legitimately can't narrow at the call site explicitly
  // import `dkgServiceLegacy` instead of `dkgService` — that
  // import-site choice is the new opt-out signal, replacing the
  // implicit "smuggle through the catch-all" path.
  describe('deprecated catch-all relocated from `DKGService` to `dkgServiceLegacy`', () => {
    it('`dkgService.persistChatTurn` REJECTS `{ mode: "assistant-reply" }` without `userMessageId` at COMPILE TIME (smuggling hole closed)', () => {
      // The crucial r31-3 property: the public `dkgService` surface
      // does NOT compile the smuggling shape. If TS stops flagging
      // this, the catch-all has been re-added to `DKGService` (or
      // one of the typed overloads has been weakened) and the
      // r30-8/r31-3 hole is back open.
      const runtime = makeRuntime();
      const assistantMsg: Memory = makePlainMemoryWithoutId();
      const malformed: Record<string, unknown> = { mode: 'assistant-reply' };
      // @ts-expect-error r31-3: `dkgService.persistChatTurn`
      // overload 2 requires `userMessageId` + `userTurnPersisted`;
      // overload 1 requires `PersistableMemory`. Neither matches
      // a `Record<string, unknown>` options bag, so the call is
      // rejected. There is intentionally NO catch-all overload.
      const pending = dkgService.persistChatTurn(runtime, assistantMsg, undefined, malformed);
      void (pending as Promise<unknown>).catch(() => {});
      expect(typeof (pending as Promise<unknown>)).toBe('object');
    });

    it('`dkgServiceLegacy.persistChatTurn` ACCEPTS the same `Record<string, unknown>` options bag (compile-time tolerance preserved on the deprecated handle)', async () => {
      const runtime = makeRuntime();
      const assistantMsg: Memory = makePlainMemoryWithoutId();
      // Identical payload to the previous test — moved through the
      // deprecated handle. TypeScript editor tooling (TSServer / VS
      // Code / WebStorm) surfaces the @deprecated annotation on
      // `dkgServiceLegacy` as a strikethrough at the import site,
      // which is the intended migration UX. The runtime path is
      // identical to `dkgService` — same `persistChatTurnImpl`,
      // same defence-in-depth runtime guard.
      const legacyOpts: Record<string, unknown> = {
        mode: 'assistant-reply',
        userMessageId: 'msg-r31-3-user-parent',
        userTurnPersisted: false,
      };
      // No @ts-expect-error — this MUST compile via the legacy handle.
      await expect(
        dkgServiceLegacy.persistChatTurn(runtime, assistantMsg, undefined, legacyOpts),
      ).rejects.toThrow(/DKG node not started/);
    });

    it('`dkgServiceLegacy` and `_dkgServiceLoose` reference the SAME runtime impl as `dkgService` (zero behavioural drift across handles)', () => {
      // All three handles publish the same underlying object so the
      // runtime guard in `persistChatTurnImpl` is the single source
      // of truth regardless of which handle the caller picked.
      // Pinning the identity here means a future refactor that
      // accidentally creates parallel impls (e.g. wrapping
      // `dkgServiceLegacy` in a proxy that strips `as any`) will
      // fail this assertion before users discover behavioural drift.
      expect(dkgServiceLegacy).toBe(_dkgServiceLoose);
      expect((dkgServiceLegacy as { persistChatTurn: unknown }).persistChatTurn)
        .toBe((dkgService as { persistChatTurn: unknown }).persistChatTurn);
      expect((dkgServiceLegacy as { onChatTurn: unknown }).onChatTurn)
        .toBe((dkgService as { onChatTurn: unknown }).onChatTurn);
    });

    it('the runtime guard in `persistChatTurnImpl` is still the single source of truth for malformed payloads routed via `dkgServiceLegacy`', async () => {
      // The whole point of declaring `dkgServiceLegacy` `@deprecated`
      // (rather than dropping all guards) is that the runtime
      // protection from r18-2 / r19-2 / r30-8 still fires — a
      // caller who smuggles `{ mode: 'assistant-reply' }` without
      // the mandatory fields gets a loud throw at runtime even
      // though the compiler accepts the call. We can't directly
      // exercise the missing-userMessageId rejection path here
      // because the agent isn't started (the "DKG node not
      // started" check fires first), but we CAN pin that the
      // legacy handle routes to the same impl path as the strict
      // overloads — anything that breaks that wiring would be
      // visible as a different error message.
      const runtime = makeRuntime();
      const msg: Memory = makePlainMemoryWithoutId();
      const malformed: Record<string, unknown> = { mode: 'assistant-reply' };
      await expect(
        dkgServiceLegacy.persistChatTurn(runtime, msg, undefined, malformed),
      ).rejects.toThrow(/DKG node not started/);
    });

    it('the deprecated catch-all does NOT relax DIRECT assignments to typed option interfaces (literal shape check still fires)', () => {
      // r31-3 only restores tolerance at the function-call overload
      // resolution level for the SEPARATELY NAMED `dkgServiceLegacy`
      // handle. If the caller writes the literal AS the typed
      // interface, the strict structural check still fires
      // (TypeScript validates the assignment against the declared
      // type, not against any service overload). This matters
      // because well-behaved callers SHOULD type their options
      // bag explicitly when they can — and they get the typed
      // contract back automatically.
      // @ts-expect-error r31-3: literal `{ mode: 'assistant-reply' }`
      // assigned to `AssistantReplyChatTurnOptions` still fails the
      // structural check (`userMessageId` and `userTurnPersisted`
      // are mandatory). The legacy handle does NOT widen
      // `AssistantReplyChatTurnOptions` itself — it just exposes a
      // wider call signature.
      const badAssistantReplyOpts: AssistantReplyChatTurnOptions = { mode: 'assistant-reply' };
      expect(badAssistantReplyOpts).toBeDefined();
    });

    it('the internal `_dkgServiceLoose` handle still accepts the wide `Record<string, unknown>` shape (unchanged from r30-8)', async () => {
      // The internal escape hatch is unchanged: the plugin in
      // `src/index.ts` legitimately routes framework-shaped options
      // through here, and `dkgServiceLegacy` now offers downstream
      // consumers the same compile-time tolerance with an explicit
      // import-site opt-out signal.
      const runtime = makeRuntime();
      const msg: Memory = makePlainMemoryWithoutId();
      const looseOpts: Record<string, unknown> = {
        mode: 'assistant-reply',
        userMessageId: 'msg-r30-8-user-parent',
        userTurnPersisted: false,
      };
      await expect(
        _dkgServiceLoose.persistChatTurn(runtime, msg, undefined, looseOpts),
      ).rejects.toThrow(/DKG node not started/);
      const loose: DKGServiceLoose = _dkgServiceLoose;
      expect(typeof loose.persistChatTurn).toBe('function');
      expect(typeof loose.onChatTurn).toBe('function');
    });

    it('well-typed callers on `dkgService` still bind to the strict typed overloads (no behavioural drift from r18-2 / r19-2)', () => {
      // Sanity that the strict overloads on `dkgService` still
      // resolve correctly for well-typed callers. A `UserTurnChatTurnOptions`
      // literal MUST compile and route through the persister;
      // anything else would mean a typed overload regressed.
      const runtime = makeRuntime();
      const userMsg = makePersistableMemory();
      const strictOpts: UserTurnChatTurnOptions = {
        mode: 'user-turn',
        contextGraphId: 'agent-context',
      };
      // No @ts-expect-error — this MUST compile cleanly via the
      // user-turn overload. Runtime throws "DKG node not started"
      // because the service isn't initialised; we swallow that so
      // vitest doesn't surface it as an unhandled rejection.
      const pending = dkgService.persistChatTurn(runtime, userMsg, undefined, strictOpts);
      void (pending as Promise<unknown>).catch(() => {});
      expect(typeof (pending as Promise<unknown>)).toBe('object');
    });

    // packages/adapter-elizaos/src/service.ts:359).
    //
    // r31-3 introduced `dkgServiceLegacy` as a separate `@deprecated`
    // export on `service.ts` for downstream `as any` callers. The bot
    // pointed out that the package entrypoint (`src/index.ts`) only
    // re-exported `dkgService` — `dkgServiceLegacy` was not visible to
    // consumers importing from `@origintrail-official/dkg-adapter-elizaos`,
    // so the catch-all overload removal on `DKGService` remained a
    // breaking change with no in-package migration alias.
    //
    // r31-4 re-exports `dkgServiceLegacy` (and the `DKGServiceLoose`
    // type) from `src/index.ts`. These tests pin that the public
    // entrypoint actually exposes the migration alias.
    it('[r31-4] `dkgServiceLegacy` is re-exported from the package entrypoint (`src/index.ts`)', async () => {
      const indexExports = (await import('../src/index.js')) as Record<
        string,
        unknown
      >;
      // Runtime check: the alias is reachable from the public barrel.
      expect(indexExports.dkgServiceLegacy).toBeDefined();
      // Identity pin: the entrypoint export is the SAME runtime
      // object as the `service.ts` export (no double-wrapping that
      // could subtly drift the `@deprecated` annotation away from
      // the actual handle consumers use).
      expect(indexExports.dkgServiceLegacy).toBe(dkgServiceLegacy);
      // And consequently the same impl as `dkgService` (because
      // `dkgServiceLegacy === _dkgServiceLoose === dkgService`'s impl
      // — pinned in the r31-3 identity test above).
      expect(indexExports.dkgServiceLegacy).toBe(_dkgServiceLoose);
    });

    it('[r31-4] importing `dkgServiceLegacy` from the package barrel routes through the same `persistChatTurnImpl` as the strict `dkgService`', async () => {
      // Cross-handle wiring pin: a malformed `Record<string, unknown>`
      // payload routed through the BARREL-exported `dkgServiceLegacy`
      // hits the same runtime guard as the `service.ts`-exported
      // handle. Anything that breaks this wiring (e.g. accidentally
      // re-exporting a stale snapshot) would surface as a different
      // error message or a different rejection shape.
      const { dkgServiceLegacy: barrelLegacy } = (await import(
        '../src/index.js'
      )) as { dkgServiceLegacy: typeof dkgServiceLegacy };
      const runtime = makeRuntime();
      const msg: Memory = makePlainMemoryWithoutId();
      const malformed: Record<string, unknown> = {
        mode: 'assistant-reply',
        userMessageId: 'msg-r31-4-user-parent',
        userTurnPersisted: false,
      };
      await expect(
        barrelLegacy.persistChatTurn(runtime, msg, undefined, malformed),
      ).rejects.toThrow(/DKG node not started/);
    });

    it('[r31-4] the public entrypoint exposes BOTH the strict `dkgService` and the deprecated `dkgServiceLegacy` (consumers can pick their migration speed)', async () => {
      // Anti-removal guard: a future refactor that strips
      // `dkgServiceLegacy` from the entrypoint reintroduces the
      // exact breaking change es. Pin both names at the
      // package boundary so the deprecation path stays observable
      // until the next major bump.
      const indexExports = (await import('../src/index.js')) as Record<
        string,
        unknown
      >;
      expect(typeof indexExports.dkgService).toBe('object');
      expect(typeof indexExports.dkgServiceLegacy).toBe('object');
      // Type-only re-export sanity: `DKGServiceLoose` is type-only
      // (no runtime presence), but its source-level re-export is
      // checked by the source guard below.
    });

    it('[r31-4] `src/index.ts` source re-exports BOTH `dkgService` and `dkgServiceLegacy` (anti-drift guard for the public surface)', () => {
      // Source-level pin: the re-export line in `src/index.ts` MUST
      // carry both names. If a future refactor accidentally strips
      // `dkgServiceLegacy` from the re-export (e.g. an auto-import
      // tidy-up), this assertion fails before users hit the
      // breaking change.
      const indexPath = new URL('../src/index.ts', import.meta.url).pathname;
      const src = readFileSync(indexPath, 'utf-8');
      expect(src).toMatch(
        /export\s*\{\s*[^}]*\bdkgService\b[^}]*\bdkgServiceLegacy\b[^}]*\}\s*from\s*['"]\.\/service\.js['"]/,
      );
      // And the `DKGServiceLoose` type re-export is present too.
      expect(src).toMatch(
        /export\s+type\s*\{[^}]*\bDKGServiceLoose\b[^}]*\}\s*from\s*['"]\.\/service\.js['"]/,
      );
    });

    it('the user-turn-shaped legacy options bag still routes correctly when narrowed (preferred path for new code)', async () => {
      // The strict typed overloads remain the recommended call
      // pattern for new code — narrow at the call site to get the
      // compile-time field-level enforcement.
      const runtime = makeRuntime();
      const userMsg = makePersistableMemory();
      const dynamicOpts: Record<string, unknown> = {
        mode: 'user-turn',
        contextGraphId: 'agent-context',
      };
      const narrowed = dynamicOpts as UserTurnChatTurnOptions;
      await expect(
        dkgService.persistChatTurn(runtime, userMsg, undefined, narrowed),
      ).rejects.toThrow(/DKG node not started/);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  //
  // r31-6 plumbed `options.userMessageId` through the user-turn write
  // path (so a host can pre-mint an id and have the persisted-turn
  // cache key + the on-disk turn URI converge), and the wrapper sets
  // `assistantSupersedesCanonical: true` on the assistant-reply path
  // when the user-turn embedded a provisional reply that the final
  // text supersedes. Both behaviours were RUNTIME-only — the public
  // typed surface (`UserTurnChatTurnOptions` / `AssistantReplyChatTurnOptions`)
  // declared `userMessageId?: never` on the user-turn path AND had no
  // `assistantSupersedesCanonical` field anywhere, so direct
  // `dkgService.persistChatTurn(...)` integrations couldn't use either
  // without dropping to `as any` / `dkgServiceLegacy`. r31-9 promotes
  // both knobs to the typed surface so the declared API and the
  // runtime behaviour stay aligned.
  // ─────────────────────────────────────────────────────────────────
  describe('typed surface aligns with r31-6 runtime contract', () => {
    it('UserTurnChatTurnOptions ACCEPTS userMessageId (pre-mint flow now type-checks without `as any`)', async () => {
      // Positive control: a typed user-turn caller that pre-mints
      // its `userMessageId` MUST compile against `UserTurnChatTurnOptions`.
      // this required `as any` (or routing through
      // `dkgServiceLegacy`) because the field was declared `?: never`.
      const runtime = makeRuntime();
      const userMsg = makePersistableMemory();
      const preMintedOpts: UserTurnChatTurnOptions = {
        mode: 'user-turn',
        userMessageId: 'msg-r31-9-pre-minted-user-id',
        contextGraphId: 'agent-context',
      };
      // Must compile cleanly (no @ts-expect-error). Runtime throws
      // because no agent is wired up — that's the routing proof.
      await expect(
        dkgService.persistChatTurn(runtime, userMsg, undefined, preMintedOpts),
      ).rejects.toThrow(/DKG node not started/);
      // Field is observable on the literal — pin the runtime shape too
      // so a future regression that drops the field at the type level
      // surfaces here even if the assignment line is auto-elided.
      expect(preMintedOpts.userMessageId).toBe('msg-r31-9-pre-minted-user-id');
    });

    it('UserTurnChatTurnOptions allows OMITTING userMessageId (default user-turn path unaffected)', async () => {
      // Negative-side anti-regression: the r31-9 widening must NOT
      // make `userMessageId` mandatory on the user-turn path. The
      // overwhelmingly common case (host hasn't pre-minted, persister
      // derives the id from `message.id`) still has to compile.
      const runtime = makeRuntime();
      const userMsg = makePersistableMemory();
      const defaultOpts: UserTurnChatTurnOptions = { mode: 'user-turn' };
      await expect(
        dkgService.persistChatTurn(runtime, userMsg, undefined, defaultOpts),
      ).rejects.toThrow(/DKG node not started/);
      expect(defaultOpts.userMessageId).toBeUndefined();
    });

    it('AssistantReplyChatTurnOptions EXPOSES assistantSupersedesCanonical so direct callers can opt into the supersede branch', async () => {
      // Positive control: a typed assistant-reply caller that wants
      // the headless-supersede branch (the wrapper's )
      // can now express it through the public type without `as any`.
      // the field didn't exist on the public surface so a
      // direct integration that detected stale-provisional vs final
      // text in its own caching had no way to opt in, and the
      // canonical assistant message ended up with stacked
      // `schema:text` triples (the bot's H2fh repro).
      const runtime = makeRuntime();
      const assistantMsg = makePlainMemoryWithoutId();
      const supersedeOpts: AssistantReplyChatTurnOptions = {
        mode: 'assistant-reply',
        userMessageId: 'msg-r31-9-user-parent',
        userTurnPersisted: false,
        assistantSupersedesCanonical: true,
      };
      // Must compile cleanly. Runtime throws because no agent is wired up.
      await expect(
        dkgService.persistChatTurn(runtime, assistantMsg, undefined, supersedeOpts),
      ).rejects.toThrow(/DKG node not started/);
      expect(supersedeOpts.assistantSupersedesCanonical).toBe(true);
    });

    it('AssistantReplyChatTurnOptions assistantSupersedesCanonical is OPTIONAL (legacy callers compile unchanged)', () => {
      // Anti-regression for the optional contract: existing typed
      // assistant-reply callers (e.g. the r19-2 happy-path literals
      // earlier in this file) must NOT be required to set the new
      // field. If a future refactor accidentally promotes the
      // optional `?` to required, this assertion fails to compile.
      const omitted: AssistantReplyChatTurnOptions = {
        mode: 'assistant-reply',
        userMessageId: 'msg-r31-9-user-parent',
        userTurnPersisted: true,
      };
      expect(omitted.assistantSupersedesCanonical).toBeUndefined();
    });

    it('source-level pin: `userMessageId?: never` is GONE from UserTurnChatTurnOptions (anti-drift guard for the r31-9 widening)', () => {
      // The fix is the type-level removal of `?: never`. A future
      // refactor that re-narrows the field would re-introduce the
      // exact compile-time vs runtime divergence the bot called out.
      // Pin the source so that regression surfaces here.
      const servicePath = new URL('../src/service.ts', import.meta.url).pathname;
      const src = readFileSync(servicePath, 'utf-8');
      // Locate the UserTurnChatTurnOptions declaration body.
      const ifaceIdx = src.indexOf('export interface UserTurnChatTurnOptions');
      expect(ifaceIdx).toBeGreaterThan(-1);
      const bodyClose = src.indexOf('}', ifaceIdx);
      expect(bodyClose).toBeGreaterThan(ifaceIdx);
      const ifaceBody = src.slice(ifaceIdx, bodyClose);
      // The interface body MUST declare `userMessageId?: string` and
      // MUST NOT declare `userMessageId?: never`. Both regex shapes
      // tolerate any whitespace variation.
      expect(/userMessageId\s*\?\s*:\s*string\b/.test(ifaceBody)).toBe(true);
      expect(/userMessageId\s*\?\s*:\s*never\b/.test(ifaceBody)).toBe(false);
    });

    it('source-level pin: `assistantSupersedesCanonical` is declared on AssistantReplyChatTurnOptions (matches the runtime branch in actions.ts)', () => {
      // the in actions.ts:1265 reads
      // `optsAny.assistantSupersedesCanonical === true` to emit the
      // `dkg:supersedesCanonicalAssistant` marker on the headless
      // branch. Pin the public type declaration so the runtime read
      // path can never drift from the declared API again.
      const servicePath = new URL('../src/service.ts', import.meta.url).pathname;
      const src = readFileSync(servicePath, 'utf-8');
      const ifaceIdx = src.indexOf('export interface AssistantReplyChatTurnOptions');
      expect(ifaceIdx).toBeGreaterThan(-1);
      const bodyClose = src.indexOf('}', ifaceIdx);
      expect(bodyClose).toBeGreaterThan(ifaceIdx);
      const ifaceBody = src.slice(ifaceIdx, bodyClose);
      expect(/assistantSupersedesCanonical\s*\?\s*:\s*boolean\b/.test(ifaceBody)).toBe(true);
    });
  });
});
