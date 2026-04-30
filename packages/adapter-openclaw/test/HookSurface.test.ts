import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HookSurface, INTERNAL_HOOK_SYMBOL } from "../src/HookSurface";
import type { OpenClawPluginApi } from "../src/types";

const mkLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
});

const mkApi = (overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi =>
  ({
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    config: {},
    ...overrides,
  }) as unknown as OpenClawPluginApi;

describe("HookSurface", () => {
  let hookMapSym: Map<string, any[]>;

  beforeEach(() => {
    hookMapSym = new Map();
    (globalThis as any)[INTERNAL_HOOK_SYMBOL] = hookMapSym;
  });

  afterEach(() => {
    delete (globalThis as any)[INTERNAL_HOOK_SYMBOL];
  });

  describe("typed kind (api.on)", () => {
    it("installs via api.on when available", () => {
      const api = mkApi();
      const hs = new HookSurface(api, mkLogger());
      const handler = vi.fn();
      const unsub = hs.install("typed", "before_prompt_build", handler);
      expect(unsub).not.toBeNull();
      expect(api.on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
    });

    it("returns null + warn when api.on absent", () => {
      const logger = mkLogger();
      const api = mkApi({ on: undefined as any });
      const hs = new HookSurface(api, logger);
      const unsub = hs.install("typed", "agent_end", vi.fn());
      expect(unsub).toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });

    it("does NOT fall back to registerHook for typed hooks", () => {
      const api = mkApi({ on: undefined as any });
      const hs = new HookSurface(api, mkLogger());
      hs.install("typed", "agent_end", vi.fn());
      expect(api.registerHook).not.toHaveBeenCalled();
    });
  });

  describe("internal kind (globalThis)", () => {
    it("pushes handler onto globalThis internal-hook map", () => {
      const hs = new HookSurface(mkApi(), mkLogger());
      const handler = vi.fn();
      const unsub = hs.install("internal", "message:sent", handler);
      expect(unsub).not.toBeNull();
      expect(hookMapSym.get("message:sent")?.length).toBe(1);
    });

    it("unsubscribe removes only this handler", () => {
      const hs = new HookSurface(mkApi(), mkLogger());
      const h1 = vi.fn();
      const h2 = vi.fn();
      const unsub1 = hs.install("internal", "message:sent", h1);
      hs.install("internal", "message:received", h2);
      expect(hookMapSym.get("message:sent")?.length).toBe(1);
      unsub1?.();
      expect(hookMapSym.get("message:sent")?.length).toBe(0);
      expect(hookMapSym.get("message:received")?.length).toBe(1);
    });

    it("returns null when globalThis map absent and records error in stats", () => {
      delete (globalThis as any)[INTERNAL_HOOK_SYMBOL];
      const hs = new HookSurface(mkApi(), mkLogger());
      const unsub = hs.install("internal", "message:sent", vi.fn());
      expect(unsub).toBeNull();
      const stats = hs.getDispatchStats();
      expect(stats["internal:message:sent"]?.installedVia).toBe("none");
      expect(stats["internal:message:sent"]?.installError).toMatch(/absent/);
    });

    it("api-on strategy override for internal kind warns and falls back to globalThis", () => {
      const logger = mkLogger();
      const hs = new HookSurface(mkApi(), logger, "api-on");
      const unsub = hs.install("internal", "message:sent", vi.fn());
      expect(unsub).not.toBeNull();
      expect(hookMapSym.get("message:sent")?.length).toBe(1);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe("legacy kind (api.registerHook)", () => {
    it("installs via api.registerHook", () => {
      const api = mkApi();
      const hs = new HookSurface(api, mkLogger());
      const unsub = hs.install("legacy", "session_end", vi.fn());
      expect(unsub).not.toBeNull();
      expect(api.registerHook).toHaveBeenCalled();
    });

    it("returns null when api.registerHook absent", () => {
      const api = mkApi({ registerHook: undefined as any });
      const logger = mkLogger();
      const hs = new HookSurface(api, logger);
      const unsub = hs.install("legacy", "session_end", vi.fn());
      expect(unsub).toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });

    it("T50 — api-on strategy override does NOT route legacy hooks through api.on (would silently never fire)", () => {
      // T50 supersedes R20.3. The earlier R20.3 routed legacy installs
      // through api.on when the override was set (per the original
      // docstring), but legacy events (e.g. `session_end`) dispatch
      // from `registry.hooks`, NOT `registry.typedHooks`. An api.on
      // install for a legacy event lands in typedHooks, where the
      // dispatcher never looks for legacy events — silent no-fire,
      // shutdown/cleanup hooks broken. The override is now narrowed
      // to typed hooks only; legacy continues to use registerHook
      // regardless.
      const api = mkApi();
      const hs = new HookSurface(api, mkLogger(), "api-on");
      const unsub = hs.install("legacy", "session_end", vi.fn());
      expect(unsub).not.toBeNull();
      expect(api.registerHook).toHaveBeenCalled();
      expect(api.on).not.toHaveBeenCalled();
    });

    it("T50 — api-on strategy override on legacy returns null when registerHook is absent (fails loud)", () => {
      // Same fail-loud shape as the typed branch when api.on is
      // missing. Pre-T50 this case would have routed to api.on under
      // the override; post-T50 it must surface the genuine missing-
      // registerHook condition.
      const api = mkApi({ registerHook: undefined as any });
      const logger = mkLogger();
      const hs = new HookSurface(api, logger, "api-on");
      const unsub = hs.install("legacy", "session_end", vi.fn());
      expect(unsub).toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe("strategy override = off", () => {
    it("all kinds return null", () => {
      const hs = new HookSurface(mkApi(), mkLogger(), "off");
      expect(hs.install("typed", "agent_end", vi.fn())).toBeNull();
      expect(hs.install("internal", "message:sent", vi.fn())).toBeNull();
      expect(hs.install("legacy", "session_end", vi.fn())).toBeNull();
    });
  });

  describe("destroy() soft-destroyed gate (R21.1)", () => {
    it("R21.1 — typed handler short-circuits after destroy() (api.on has no unsubscribe)", () => {
      const api = mkApi();
      const hs = new HookSurface(api, mkLogger());
      const userHandler = vi.fn();
      hs.install("typed", "agent_end", userHandler);
      // Capture the wrapped handler that was registered with api.on.
      const onCall = (api.on as any).mock.calls[0];
      const wrapped = onCall[1] as (...args: unknown[]) => unknown;
      // Pre-destroy: wrapped invokes the user handler.
      wrapped({ messages: [] }, {});
      expect(userHandler).toHaveBeenCalledTimes(1);
      // Destroy.
      hs.destroy();
      // Post-destroy: same wrapped (still live in upstream registry due
      // to api.on no-unsub) must short-circuit and NOT invoke the user
      // handler.
      wrapped({ messages: [] }, {});
      expect(userHandler).toHaveBeenCalledTimes(1);
    });

    it("R23.1 — internal handler short-circuits after destroy() even if dispatcher snapshotted the array pre-destroy", () => {
      // Regression for R23.1: the OpenClaw runtime can snapshot
      // `globalThis[hookSym].get(event)` into a local array BEFORE
      // invoking each handler. If `destroy()` runs after the snapshot
      // but before dispatch reaches the wrapper, the wrapper still
      // gets called even though we already pulled it from the live
      // array. The destroyed-flag short-circuit prevents the late
      // dispatch from re-entering ChatTurnWriter.
      const api = mkApi();
      const hs = new HookSurface(api, mkLogger());
      const userHandler = vi.fn();
      hs.install("internal", "message:sent", userHandler);
      // Capture the wrapped handler from the globalThis hook map.
      const wrappers = hookMapSym.get("message:sent")!;
      expect(wrappers).toHaveLength(1);
      const wrapped = wrappers[0] as (...args: any[]) => unknown;
      // Pre-destroy: invocation reaches user handler.
      wrapped({});
      expect(userHandler).toHaveBeenCalledTimes(1);
      // Destroy.
      hs.destroy();
      // Post-destroy: invoking the captured wrapped (simulating a late
      // dispatch from a pre-destroy snapshot) must short-circuit.
      wrapped({});
      expect(userHandler).toHaveBeenCalledTimes(1);
    });

    it("R21.1 — legacy handler short-circuits after destroy() (registerHook has no unsubscribe)", async () => {
      const api = mkApi();
      const hs = new HookSurface(api, mkLogger());
      const userHandler = vi.fn();
      hs.install("legacy", "session_end", userHandler);
      const regCall = (api.registerHook as any).mock.calls[0];
      const wrapped = regCall[1] as (...args: unknown[]) => Promise<void>;
      await wrapped({}, {});
      expect(userHandler).toHaveBeenCalledTimes(1);
      hs.destroy();
      await wrapped({}, {});
      expect(userHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe("C5 double-registration guard", () => {
    it("same handler identity returns existing unsubscribe", () => {
      const hs = new HookSurface(mkApi(), mkLogger());
      const handler = vi.fn();
      const unsub1 = hs.install("typed", "agent_end", handler);
      const unsub2 = hs.install("typed", "agent_end", handler);
      expect(unsub2).toBe(unsub1);
    });

    it("different handler for same slot is rejected with warn", () => {
      const logger = mkLogger();
      const hs = new HookSurface(mkApi(), logger);
      hs.install("typed", "agent_end", vi.fn());
      const unsub2 = hs.install("typed", "agent_end", vi.fn());
      expect(unsub2).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("REJECTED"));
    });
  });

  describe("destroy()", () => {
    it("unsubscribes internal-kind handlers from globalThis", () => {
      const hs = new HookSurface(mkApi(), mkLogger());
      hs.install("internal", "message:sent", vi.fn());
      expect(hookMapSym.get("message:sent")?.length).toBe(1);
      hs.destroy();
      expect(hookMapSym.get("message:sent")?.length).toBe(0);
    });

    it("is idempotent", () => {
      const hs = new HookSurface(mkApi(), mkLogger());
      hs.install("internal", "message:sent", vi.fn());
      expect(() => {
        hs.destroy();
        hs.destroy();
      }).not.toThrow();
    });
  });

  describe("getDispatchStats()", () => {
    it("records successful typed install as installedVia='on'", () => {
      const hs = new HookSurface(mkApi(), mkLogger());
      hs.install("typed", "agent_end", vi.fn());
      const stats = hs.getDispatchStats();
      expect(stats["typed:agent_end"]?.installedVia).toBe("on");
      expect(stats["typed:agent_end"]?.fireCount).toBe(0);
      expect(stats["typed:agent_end"]?.commitState).toBe("pending");
    });

    it("records failed typed install error string", () => {
      const hs = new HookSurface(mkApi({ on: undefined as any }), mkLogger());
      hs.install("typed", "agent_end", vi.fn());
      const stats = hs.getDispatchStats();
      expect(stats["typed:agent_end"]?.installError).toBeDefined();
      expect(stats["typed:agent_end"]?.installedVia).toBe("none");
    });
  });

  describe("I4 commit-by-timeout", () => {
    it("flips commitState to committed-by-timeout after grace period", async () => {
      const hs = new HookSurface(mkApi(), mkLogger(), "auto", { commitGraceMs: 10 });
      hs.install("typed", "agent_end", vi.fn());
      await new Promise((r) => setTimeout(r, 30));
      const stats = hs.getDispatchStats();
      expect(stats["typed:agent_end"]?.commitState).toBe("committed-by-timeout");
    });

    it("logs non-rare commit timeouts at warn", async () => {
      const logger = mkLogger();
      const hs = new HookSurface(mkApi(), logger, "auto", { commitGraceMs: 10 });
      hs.install("typed", "agent_end", vi.fn());
      await new Promise((r) => setTimeout(r, 30));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("typed:agent_end"));
      expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining("typed:agent_end"));
    });

    it("logs rare-fire commit timeouts at debug for infrequent hooks", async () => {
      const logger = mkLogger();
      const hs = new HookSurface(mkApi(), logger, "auto", { commitGraceMs: 10 });
      hs.install("legacy", "session_end", vi.fn(), { rareFireExpected: true });
      hs.install("internal", "message:received", vi.fn(), { rareFireExpected: true });
      hs.install("internal", "message:sent", vi.fn(), { rareFireExpected: true });
      await new Promise((r) => setTimeout(r, 30));

      const debugMessages = logger.debug.mock.calls.map((args) => String(args[0]));
      const warnMessages = logger.warn.mock.calls.map((args) => String(args[0]));
      expect(debugMessages.some((msg) => msg.includes("legacy:session_end"))).toBe(true);
      expect(debugMessages.some((msg) => msg.includes("internal:message:received"))).toBe(true);
      expect(debugMessages.some((msg) => msg.includes("internal:message:sent"))).toBe(true);
      expect(warnMessages.some((msg) => msg.includes("legacy:session_end"))).toBe(false);
      expect(warnMessages.some((msg) => msg.includes("internal:message:received"))).toBe(false);
      expect(warnMessages.some((msg) => msg.includes("internal:message:sent"))).toBe(false);
    });
  });

  describe("N5 partial-install policy", () => {
    it("typed fails but internal+legacy succeed — each tracked independently", () => {
      const api = mkApi({ on: undefined as any });
      const hs = new HookSurface(api, mkLogger());
      const typedUnsub = hs.install("typed", "agent_end", vi.fn());
      const internalUnsub = hs.install("internal", "message:sent", vi.fn());
      const legacyUnsub = hs.install("legacy", "session_end", vi.fn());
      expect(typedUnsub).toBeNull();
      expect(internalUnsub).not.toBeNull();
      expect(legacyUnsub).not.toBeNull();
      const stats = hs.getDispatchStats();
      expect(stats["typed:agent_end"]?.installedVia).toBe("none");
      expect(stats["internal:message:sent"]?.installedVia).toBe("globalThis");
      expect(stats["legacy:session_end"]?.installedVia).toBe("registerHook");
    });
  });
});
