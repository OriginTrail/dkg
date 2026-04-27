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

    it("R20.3 — api-on strategy override forces legacy hooks onto api.on (not registerHook)", () => {
      // Regression for R20.3: the class contract documents that
      // `strategyOverride: 'api-on'` forces both 'typed' AND 'legacy'
      // onto the `api.on` path, but `installLegacy` previously ignored
      // the override and always called `registerHook`. The fix reroutes
      // legacy installs through `api.on` when the override is set.
      const api = mkApi();
      const hs = new HookSurface(api, mkLogger(), "api-on");
      const unsub = hs.install("legacy", "session_end", vi.fn());
      expect(unsub).not.toBeNull();
      // api.on must have been called; api.registerHook must NOT.
      expect(api.on).toHaveBeenCalled();
      expect(api.registerHook).not.toHaveBeenCalled();
    });

    it("R20.3 — api-on strategy override returns null when api.on is absent", () => {
      // The override reroutes to api.on, but if api.on isn't a function
      // we should fail loud (not silently fall back to registerHook).
      const api = mkApi({ on: undefined as any });
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
