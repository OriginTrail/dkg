/**
 * HookSurface — tri-partition hook installer for the OpenClaw gateway.
 *
 * The OpenClaw runtime has three distinct hook dispatch paths that never
 * cross (plan §2.7 / A3):
 *
 *   - `'typed'` kind     — `before_prompt_build`, `agent_end`, `before_compaction`,
 *                          `before_reset`. Dispatched via `registry.typedHooks`,
 *                          populated ONLY by `api.on` and mode-gated to `full`
 *                          at `registry.ts:1150`.
 *
 *   - `'internal'` kind  — `message:received`, `message:sent`. Dispatched by the
 *                          runtime into `globalThis[Symbol.for("openclaw.internalHookHandlers")]`.
 *                          Mode-independent. The PR #216 mechanism. Not a
 *                          fallback for typed hooks.
 *
 *   - `'legacy'` kind    — `session_end` and other pre-typed-hook names.
 *                          `api.registerHook` pushes to `registry.hooks`.
 *                          Mode-independent.
 *
 * `install(kind, event, handler)` picks exactly ONE path per `(kind, event)`
 * pair per the strategy table. No cross-class fallback: if `api.on` is
 * absent for a `'typed'` hook, install returns `null` and callers log a
 * loud warn. Using `api.registerHook` for a typed event would silently land
 * in the legacy registry and never dispatch.
 *
 * Kill-switch `strategyOverride`:
 *   - `'auto'` (default) — use the table.
 *   - `'api-on'`         — force `api.on` path for `'typed'` and `'legacy'`.
 *                          For `'internal'` kind, warn and fall back to
 *                          globalThis (N9 footgun guard) — internal events
 *                          are dispatched by the runtime into the globalThis
 *                          map, not the typed-hook dispatcher.
 *   - `'off'`            — skip all installs, return `null` from every call.
 *                          Emergency kill switch for prod gateway surprises.
 *
 * I4 — deterministic commit timing. After first observed fire OR a 30s
 * grace period (whichever first), each event's `commitState` flips to
 * `committed-by-fire` or `committed-by-timeout`. Callers can surface a
 * warn if a typed-hook event never fires within the grace period.
 *
 * C5 — double-registration guard. The same `(kind, event, handler)` triple
 * is a no-op on repeat install; we return the existing unsubscribe.
 *
 * Never throws. All failures are recorded in `getDispatchStats()`.
 */

import type { OpenClawPluginApi } from './types.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type HookKind = 'typed' | 'internal' | 'legacy';
export type HookStrategy = 'auto' | 'api-on' | 'off';
export type HookHandler = (...args: any[]) => unknown | Promise<unknown>;
export type Unsubscribe = () => void;

/** Symbol the gateway uses to expose the internal hook registry. */
export const INTERNAL_HOOK_SYMBOL = Symbol.for('openclaw.internalHookHandlers');

/** Which surface actually received the install, if any. */
export type InstalledVia = 'on' | 'registerHook' | 'globalThis' | 'none';

/** Commit state per I4 — frozen after first fire or 30s grace. */
export type CommitState = 'pending' | 'committed-by-fire' | 'committed-by-timeout';

export interface DispatchStats {
  installedVia: InstalledVia;
  fireCount: number;
  commitState: CommitState;
  installError?: string;
}

/** Minimum logger shape used by HookSurface. */
export interface HookSurfaceLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

/**
 * Grace period after which a pending typed-hook commit flips to
 * `committed-by-timeout`. Callers can surface a warn then. Exported for
 * test override via the constructor `opts.commitGraceMs`.
 */
const DEFAULT_COMMIT_GRACE_MS = 30_000;

// ---------------------------------------------------------------------------
// HookSurface
// ---------------------------------------------------------------------------

export class HookSurface {
  private readonly api: OpenClawPluginApi;
  private readonly logger: HookSurfaceLogger;
  private readonly strategyOverride: HookStrategy;
  private readonly commitGraceMs: number;

  /**
   * Per-event stats. Keyed on `${kind}:${event}` so the same event name
   * registered under two different kinds stays separate.
   */
  private readonly stats = new Map<string, DispatchStats>();

  /**
   * Double-registration guard (C5). Maps `${kind}:${event}` to the
   * `{ handler, unsubscribe }` tuple. Repeat installs with the same
   * handler identity return the existing unsubscribe; different-handler
   * installs against the same event are rejected with a warn — we want
   * exactly one handler per surface slot to keep dispatch observable.
   */
  private readonly installedHandlers = new Map<string, { handler: HookHandler; unsubscribe: Unsubscribe }>();
  /**
   * R21.1 — Soft "destroyed" flag. OpenClaw's `api.on` and `api.registerHook`
   * have no unsubscribe primitives, so `destroy()`'s no-op unsubscribes for
   * typed and legacy hooks leave handlers live in the upstream registry.
   * Each wrapped handler checks this flag and short-circuits BEFORE
   * invoking the user handler when the surface has been torn down. Without
   * this gate, `before_prompt_build` / `agent_end` / `session_end` would
   * keep firing the old plugin's logic after `destroy()` returned.
   */
  private destroyed = false;

  /** Timers for the I4 grace-period commit path. Cleared on first fire or destroy. */
  private readonly commitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly rareFireKeys = new Set<string>();

  constructor(
    api: OpenClawPluginApi,
    logger: HookSurfaceLogger,
    strategyOverride: HookStrategy = 'auto',
    opts: { commitGraceMs?: number } = {},
  ) {
    this.api = api;
    this.logger = logger;
    this.strategyOverride = strategyOverride;
    this.commitGraceMs = opts.commitGraceMs ?? DEFAULT_COMMIT_GRACE_MS;
  }

  /**
   * Install a handler for a `(kind, event)` pair.
   * Returns an unsubscribe callback, or `null` when the install failed
   * (e.g. `api.on` absent for a typed hook). Never throws.
   *
   * `opts.rareFireExpected` marks hooks that normally don't fire during
   * routine traffic (e.g. `before_compaction`, `before_reset`). Their
   * 30s commit-by-timeout message downgrades to debug instead of warn —
   * a healthy startup otherwise surfaces noise warnings that drown out
   * real install failures.
   */
  install(
    kind: HookKind,
    event: string,
    handler: HookHandler,
    opts: { rareFireExpected?: boolean } = {},
  ): Unsubscribe | null {
    const key = `${kind}:${event}`;
    if (opts.rareFireExpected) this.rareFireKeys.add(key);

    if (this.strategyOverride === 'off') {
      this.setStat(key, { installedVia: 'none', commitState: 'committed-by-timeout', installError: 'hookStrategy=off' });
      this.logger.debug?.(`[hook-surface] skipping install (strategyOverride=off): ${key}`);
      return null;
    }

    const existing = this.installedHandlers.get(key);
    if (existing) {
      if (existing.handler === handler) {
        this.logger.debug?.(`[hook-surface] install dedup (same handler): ${key}`);
        return existing.unsubscribe;
      }
      this.logger.warn?.(
        `[hook-surface] install REJECTED: ${key} already has a different handler registered. ` +
          `Unsubscribe the prior install before re-installing.`,
      );
      return null;
    }

    let unsubscribe: Unsubscribe | null;
    switch (kind) {
      case 'typed':
        unsubscribe = this.installTyped(event, handler, key);
        break;
      case 'internal':
        unsubscribe = this.installInternal(event, handler, key);
        break;
      case 'legacy':
        unsubscribe = this.installLegacy(event, handler, key);
        break;
      default: {
        const never: never = kind;
        this.logger.warn?.(`[hook-surface] install REJECTED: unknown kind=${String(never)} for ${event}`);
        this.setStat(key, {
          installedVia: 'none',
          commitState: 'committed-by-timeout',
          installError: `unknown kind: ${String(never)}`,
        });
        return null;
      }
    }

    if (!unsubscribe) return null;

    this.installedHandlers.set(key, { handler, unsubscribe });

    const timer = setTimeout(() => {
      const s = this.stats.get(key);
      if (s && s.commitState === 'pending') {
        this.stats.set(key, { ...s, commitState: 'committed-by-timeout' });
        const msg =
          `[hook-surface] commit-by-timeout: ${key} never fired within ${this.commitGraceMs}ms. ` +
          `installedVia=${s.installedVia}, fireCount=0.`;
        // Rare-fire hooks (e.g. before_compaction, before_reset) don't
        // fire in routine traffic; surface at debug so real install
        // failures on frequent hooks aren't drowned out by startup noise.
        if (this.rareFireKeys.has(key)) {
          this.logger.debug?.(msg);
        } else {
          this.logger.warn?.(msg);
        }
      }
      this.commitTimers.delete(key);
    }, this.commitGraceMs);
    (timer as { unref?: () => void }).unref?.();
    this.commitTimers.set(key, timer);

    return unsubscribe;
  }

  /**
   * Read-only snapshot of per-event dispatch stats. Keys are `${kind}:${event}`.
   */
  getDispatchStats(): Record<string, DispatchStats> {
    const out: Record<string, DispatchStats> = {};
    for (const [key, stat] of this.stats) out[key] = { ...stat };
    return out;
  }

  /**
   * Tear down all installed handlers and cancel pending commit timers.
   * Idempotent. Called from `DkgNodePlugin.stop()` via the existing
   * `session_end` legacy hook.
   */
  destroy(): void {
    // R21.1 — Set the soft-destroyed flag FIRST so any handler invocation
    // already in flight will short-circuit when its wrapper checks the
    // flag. Internal-hook unsubscribes actually remove handlers from the
    // global map; typed and legacy unsubscribes are documented no-ops
    // (OpenClaw `api.on` / `api.registerHook` have no unsub primitive),
    // so the flag is the only thing that prevents post-destroy dispatches
    // from re-entering the plugin.
    this.destroyed = true;
    for (const { unsubscribe } of this.installedHandlers.values()) {
      try {
        unsubscribe();
      } catch {
        /* best-effort teardown */
      }
    }
    this.installedHandlers.clear();
    for (const timer of this.commitTimers.values()) clearTimeout(timer);
    this.commitTimers.clear();
  }

  // -------------------------------------------------------------------------
  // Kind installers
  // -------------------------------------------------------------------------

  private installTyped(event: string, handler: HookHandler, key: string): Unsubscribe | null {
    if (typeof this.api.on !== 'function') {
      const msg =
        `[hook-surface] install FAILED: typed hook ${event} requires api.on (registrationMode=full), ` +
        `but api.on is ${typeof this.api.on}. Typed hooks will not dispatch. ` +
        `NOTE: api.registerHook is a DIFFERENT registry (legacy hooks) and is NOT a fallback for typed events.`;
      this.logger.warn?.(msg);
      this.setStat(key, { installedVia: 'none', commitState: 'committed-by-timeout', installError: 'api.on not a function' });
      return null;
    }

    // R16.1 — Return-value propagation contract. OpenClaw's typed-hook
    // dispatcher (`openclaw/src/plugins/hooks.ts:runModifyingHook` ~L362)
    // sequentially awaits each handler and reads its return value:
    // modifying hooks like `before_prompt_build` consume
    // `{ appendSystemContext, ... }`; fire-and-forget hooks like
    // `agent_end` ignore it. Forwarding the handler's return through
    // this wrapper is therefore load-bearing — DO NOT rewrite to a
    // void-returning wrapped form. The `OpenClawPluginApi.on` signature
    // in `types.ts` reflects this `unknown | Promise<unknown>` contract.
    const wrapped = (...args: unknown[]) => {
      // R21.1 — Soft-destroyed gate. The upstream `api.on` registry has no
      // unsubscribe primitive, so a stop/re-register cycle leaves THIS
      // wrapped handler live in the dispatcher. Without this gate, an
      // `agent_end` / `before_prompt_build` arriving after `destroy()`
      // would still re-enter the user handler and execute against the
      // torn-down `chatTurnWriter` / `memoryPlugin`. Returning undefined
      // makes modifying hooks (`before_prompt_build`) a no-op (no
      // `appendSystemContext`); fire-and-forget hooks just drop the call.
      if (this.destroyed) return undefined;
      this.recordFire(key);
      return (handler as (...a: unknown[]) => unknown)(...args);
    };

    try {
      this.api.on(event, wrapped);
    } catch (err) {
      const msg = errorMessage(err);
      this.logger.warn?.(`[hook-surface] api.on threw for typed hook ${event}: ${msg}`);
      this.setStat(key, { installedVia: 'none', commitState: 'committed-by-timeout', installError: msg });
      return null;
    }

    this.setStat(key, { installedVia: 'on', commitState: 'pending' });
    this.logger.debug?.(`[hook-surface] installed typed hook via api.on: ${event}`);

    // `api.on` in the OpenClaw contract has no unsubscribe primitive.
    // Surface a clear debug log so ops are not misled.
    return () => {
      this.logger.debug?.(
        `[hook-surface] unsubscribe() is a no-op for typed hook ${event} — api.on has no unsubscribe in the OpenClaw contract.`,
      );
    };
  }

  private installInternal(event: string, handler: HookHandler, key: string): Unsubscribe | null {
    if (this.strategyOverride === 'api-on') {
      this.logger.warn?.(
        `[hook-surface] hookStrategy='api-on' is ignored for 'internal' kind: ${event}. ` +
          `Internal events dispatch via globalThis[Symbol.for("openclaw.internalHookHandlers")], not api.on. ` +
          `Falling back to globalThis path.`,
      );
    }

    const g = globalThis as unknown as Record<symbol, unknown>;
    const existing = g[INTERNAL_HOOK_SYMBOL];
    if (!(existing instanceof Map)) {
      const msg = `globalThis[Symbol.for("openclaw.internalHookHandlers")] is ${
        existing === undefined ? 'absent' : 'not a Map'
      }`;
      this.logger.debug?.(`[hook-surface] internal hook ${event} skipped: ${msg}`);
      this.setStat(key, { installedVia: 'none', commitState: 'committed-by-timeout', installError: msg });
      return null;
    }

    const hookMap = existing as Map<string, HookHandler[]>;
    if (!hookMap.has(event)) hookMap.set(event, []);

    const wrapped: HookHandler = (...args: any[]) => {
      this.recordFire(key);
      return handler(...args);
    };

    hookMap.get(event)!.push(wrapped);
    this.setStat(key, { installedVia: 'globalThis', commitState: 'pending' });
    this.logger.debug?.(`[hook-surface] installed internal hook via globalThis: ${event}`);

    return () => {
      const arr = hookMap.get(event);
      if (!arr) return;
      hookMap.set(event, arr.filter((h) => h !== wrapped));
    };
  }

  private installLegacy(event: string, handler: HookHandler, key: string): Unsubscribe | null {
    // R20.3 — Honor `strategyOverride === 'api-on'`. The class contract
    // (file header) documents that 'api-on' forces both 'typed' AND
    // 'legacy' onto the `api.on` path; previously this branch ignored
    // the override and always used `registerHook`, so the documented
    // override was unreachable. When forced to api-on we fall back to
    // the typed-install code path so behavior matches the docstring.
    if (this.strategyOverride === 'api-on') {
      if (typeof this.api.on !== 'function') {
        const msg =
          `[hook-surface] install FAILED: legacy hook ${event} forced to api.on by ` +
          `strategyOverride='api-on', but api.on is ${typeof this.api.on}.`;
        this.logger.warn?.(msg);
        this.setStat(key, { installedVia: 'none', commitState: 'committed-by-timeout', installError: 'api.on not a function' });
        return null;
      }
      return this.installTyped(event, handler, key);
    }

    if (typeof this.api.registerHook !== 'function') {
      const msg = `api.registerHook is ${typeof this.api.registerHook}`;
      this.logger.warn?.(`[hook-surface] install FAILED: legacy hook ${event} requires api.registerHook: ${msg}`);
      this.setStat(key, { installedVia: 'none', commitState: 'committed-by-timeout', installError: msg });
      return null;
    }

    const wrapped = async (...args: unknown[]) => {
      // R21.1 — Soft-destroyed gate. `api.registerHook` (legacy registry)
      // has no unsubscribe primitive, so a stop/re-register cycle leaves
      // THIS wrapped handler live in the dispatcher. Drop the call when
      // the surface is torn down.
      if (this.destroyed) return;
      this.recordFire(key);
      await (handler as (...a: unknown[]) => unknown)(...args);
    };

    try {
      this.api.registerHook(event, wrapped as (...args: any[]) => Promise<void>, { name: `dkg-${event}` });
    } catch (err) {
      const msg = errorMessage(err);
      this.logger.warn?.(`[hook-surface] api.registerHook threw for legacy hook ${event}: ${msg}`);
      this.setStat(key, { installedVia: 'none', commitState: 'committed-by-timeout', installError: msg });
      return null;
    }

    this.setStat(key, { installedVia: 'registerHook', commitState: 'pending' });
    this.logger.debug?.(`[hook-surface] installed legacy hook via api.registerHook: ${event}`);
    return () => {
      this.logger.debug?.(
        `[hook-surface] unsubscribe() is a no-op for legacy hook ${event} — api.registerHook has no unsubscribe primitive.`,
      );
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private setStat(key: string, stat: Omit<DispatchStats, 'fireCount'>): void {
    const prev = this.stats.get(key);
    this.stats.set(key, {
      installedVia: stat.installedVia,
      fireCount: prev?.fireCount ?? 0,
      commitState: stat.commitState,
      installError: stat.installError ?? prev?.installError,
    });
  }

  private recordFire(key: string): void {
    const prev = this.stats.get(key);
    if (!prev) return;
    const fireCount = prev.fireCount + 1;
    const nextState: CommitState =
      prev.commitState === 'pending' ? 'committed-by-fire' : prev.commitState;
    this.stats.set(key, { ...prev, fireCount, commitState: nextState });

    if (fireCount === 1) {
      const timer = this.commitTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        this.commitTimers.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Module-local helpers
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return '<unstringifiable error>';
  }
}
