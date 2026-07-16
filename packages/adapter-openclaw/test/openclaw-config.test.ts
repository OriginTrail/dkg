import { describe, expect, it } from 'vitest';
import {
  extractAdapterPluginConfigOverlay,
  isPartialAdapterConfigOverlay,
  isStateMetadataOnlyAdapterConfig,
  looksLikeAdapterPluginConfig,
  mergeAdapterPluginConfigs,
  resolveOpenClawMergedConfig,
  resolveOpenClawRouteMetadataConfig,
} from '../src/openclaw-config.js';

describe('openclaw-config helpers', () => {
  it('classifies adapter plugin configs without treating full workspace config as plugin config', () => {
    expect(looksLikeAdapterPluginConfig({
      daemonUrl: 'http://127.0.0.1:9200',
      stateDir: '/workspace/.dkg-adapter',
      memory: { enabled: true },
    })).toBe(true);
    expect(looksLikeAdapterPluginConfig({
      plugins: {},
      agents: {},
    })).toBe(false);
    expect(looksLikeAdapterPluginConfig({
      workspace: '/workspace',
      stateDir: '/workspace/.dkg-adapter',
    })).toBe(false);
    expect(looksLikeAdapterPluginConfig({
      session: { dmScope: 'main' },
      stateDir: '/workspace/.dkg-adapter',
    })).toBe(false);
    expect(isStateMetadataOnlyAdapterConfig({
      stateDir: '/workspace/.dkg-adapter',
      stateDirSource: 'setup-default',
      installedWorkspace: '/workspace',
    })).toBe(true);
    expect(isStateMetadataOnlyAdapterConfig({
      stateDir: '/workspace/.dkg-adapter',
      memory: { enabled: true },
    })).toBe(false);
  });

  it('selects the full merged config when api.config is adapter plugin config', () => {
    const fullConfig = {
      plugins: {
        slots: {
          memory: 'adapter-openclaw',
        },
      },
    };
    const api = {
      config: {
        stateDir: '/workspace/.dkg-adapter',
        memory: { enabled: true },
      },
      runtime: {
        config: fullConfig,
      },
    } as any;

    expect(resolveOpenClawMergedConfig(api)).toBe(fullConfig);
  });

  it('keeps full api.config ahead of stale runtime config', () => {
    const fullConfig = {
      plugins: {
        slots: {
          memory: 'adapter-openclaw',
        },
      },
    };
    const staleRuntimeConfig = {
      plugins: {
        slots: {
          memory: 'other-plugin',
        },
      },
    };
    const api = {
      config: fullConfig,
      runtime: {
        config: staleRuntimeConfig,
      },
    } as any;

    expect(resolveOpenClawMergedConfig(api)).toBe(fullConfig);
  });

  it('keeps live api.cfg ahead of stale api.config when both are exposed', () => {
    const liveConfig = {
      plugins: {
        slots: {
          memory: 'adapter-openclaw',
        },
      },
    };
    const staleConfig = {
      plugins: {
        slots: {
          memory: 'other-plugin',
        },
      },
    };
    const api = {
      cfg: liveConfig,
      config: staleConfig,
    } as any;

    expect(resolveOpenClawMergedConfig(api)).toBe(liveConfig);
  });

  it('prefers plugin-bearing api.config over route-only api.cfg', () => {
    const fullConfig = {
      plugins: {
        slots: {
          memory: 'adapter-openclaw',
        },
      },
    };
    const routeConfig = {
      agents: {},
      session: {
        dmScope: 'main',
      },
    };
    const api = {
      cfg: routeConfig,
      config: fullConfig,
    } as any;

    expect(resolveOpenClawMergedConfig(api)).toBe(fullConfig);
  });

  it('does not treat route-only api.cfg as merged plugin config', () => {
    const routeConfig = {
      agents: {},
      session: {
        dmScope: 'main',
      },
    };
    const api = {
      config: {},
      cfg: routeConfig,
    } as any;

    expect(resolveOpenClawMergedConfig(api)).toBeUndefined();
    expect(resolveOpenClawRouteMetadataConfig(api)).toEqual(routeConfig);
  });

  it('keeps route metadata separate from direct plugin config fallback', () => {
    const routeConfig = {
      agents: {
        defaults: {
          workspace: '/workspace',
        },
      },
    };
    const directPluginConfig = {
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: true, port: 0 },
    };
    const api = {
      cfg: routeConfig,
      pluginConfig: directPluginConfig,
    } as any;

    expect(resolveOpenClawMergedConfig(api)).toBeUndefined();
    expect(resolveOpenClawRouteMetadataConfig(api)).toEqual(routeConfig);
  });

  it('T364 round 6 — extractAdapterPluginConfigOverlay splits mixed gateway payloads into adapter overlay', () => {
    // Pre-fix `looksLikeAdapterPluginConfig` blanket-rejected any
    // object carrying `workspaceDir` (or any route-metadata key), so
    // a legitimate gateway payload like `{ workspaceDir, channel: {...} }`
    // dropped its channel/memory overrides on the floor and bootstrap
    // kept stale settings. The new helper splits the route-metadata
    // portion (handled separately by route-metadata recognition) from
    // the adapter-config portion and returns just the latter.
    expect(extractAdapterPluginConfigOverlay({
      workspaceDir: '/legacy-workspace',
      channel: { port: 9801 },
    })).toEqual({ channel: { port: 9801 } });
    expect(extractAdapterPluginConfigOverlay({
      workspaceDir: '/legacy-workspace',
      memory: { enabled: false },
    })).toEqual({ memory: { enabled: false } });
    // Pure adapter config — return original reference (identity preserved)
    // so consumers comparing by `toBe(candidate)` keep working.
    const pure = { daemonUrl: 'http://127.0.0.1:9200', channel: { enabled: true, port: 0 } };
    expect(extractAdapterPluginConfigOverlay(pure)).toBe(pure);
    // Pure route metadata (no adapter keys) → undefined.
    expect(extractAdapterPluginConfigOverlay({ workspaceDir: '/just-metadata' })).toBeUndefined();
    expect(extractAdapterPluginConfigOverlay({ agents: { defaults: { workspace: '/x' } } })).toBeUndefined();
    // Merged-config-shaped input (has `plugins`) → undefined; that's
    // a full snapshot, not a direct overlay.
    expect(extractAdapterPluginConfigOverlay({
      plugins: { entries: { 'adapter-openclaw': { config: { channel: { port: 9801 } } } } },
    })).toBeUndefined();
    expect(extractAdapterPluginConfigOverlay(undefined)).toBeUndefined();
    expect(extractAdapterPluginConfigOverlay(null)).toBeUndefined();
    expect(extractAdapterPluginConfigOverlay({})).toBeUndefined();
  });

  it('T364 round 10 — empty-string workspace aliases do not count as route-metadata signal', () => {
    // Pre-fix `hasRouteMetadataConfigSignal` accepted any string for
    // `workspace`/`workspaceDir`, so an empty string (or whitespace-
    // only value) counted as a workspace signal. That suppressed the
    // fallback chain, the resolver could land on an empty workspace,
    // and `syncSkillToWorkspace` would write to `./skills/...` under
    // the process CWD instead of an actual workspace. Post-fix the
    // signal requires a non-empty trimmed value across all three
    // alias slots — empty-only candidates fall through to the next
    // priority source.
    const api = {
      cfg: { workspaceDir: '   ' },  // whitespace-only — should NOT trigger
      runtime: { config: { workspace: '/real-fallback' } },
    } as any;
    const result = resolveOpenClawRouteMetadataConfig(api);
    // Empty-only `cfg` should not crowd out the real fallback workspace.
    expect(result?.workspace).toBe('/real-fallback');
  });

  it('T364 round 10 — newer config with empty-string workspace alias does not scrub older real alias', () => {
    // Anti-test for the alias scrubber: a "newer" config supplying
    // an empty workspace alias must NOT be treated as asserting a
    // workspace signal; otherwise it would scrub the older REAL
    // alias and leave the resolver with no workspace at all.
    const api = {
      runtime: { config: { agents: { defaults: { workspace: '/old-real' } } } },
      cfg: { workspaceDir: '' },  // empty string — no real signal
    } as any;
    const result = resolveOpenClawRouteMetadataConfig(api);
    expect(result).toBeDefined();
    expect((result?.agents as any)?.defaults?.workspace).toBe('/old-real');
  });

  it('T364 round 8 — newer workspaceDir-only route config supersedes older agents.defaults.workspace alias', () => {
    // Pre-fix `mergeRouteMetadataConfigs` did `Object.assign(merged, config)`
    // verbatim, so an older `agents.defaults.workspace = '/old'` survived
    // alongside a newer `workspaceDir = '/new'`. Consumers following the
    // documented `agents.defaults.workspace -> workspace -> workspaceDir`
    // fallback chain (setup.ts:166-190) then resolved the STALE `/old`
    // because it sits first in the chain — silently ignoring the newer
    // route's intent.
    const oldRoute = { agents: { defaults: { workspace: '/old', model: 'gpt-4' } } };
    const newRoute = { workspaceDir: '/new' };
    const api = {
      runtime: { config: oldRoute },
      cfg: newRoute,
    } as any;
    const result = resolveOpenClawRouteMetadataConfig(api);
    expect(result).toBeDefined();
    // workspaceDir from newer config wins.
    expect(result?.workspaceDir).toBe('/new');
    // older `agents.defaults.workspace` MUST be scrubbed so the resolver
    // chain doesn't pick the stale value.
    expect((result?.agents as any)?.defaults?.workspace).toBeUndefined();
    // Other agents.defaults fields (e.g. model) preserved across the merge.
    expect((result?.agents as any)?.defaults?.model).toBe('gpt-4');
  });

  it('T364 round 8 — newer workspace-only route config supersedes older workspaceDir alias', () => {
    // Symmetric case: newer config asserts `workspace`, older has only
    // `workspaceDir`. The newer signal must win, so the older
    // `workspaceDir` is scrubbed.
    const api = {
      runtime: { config: { workspaceDir: '/old' } },
      cfg: { workspace: '/new' },
    } as any;
    const result = resolveOpenClawRouteMetadataConfig(api);
    expect(result).toBeDefined();
    expect(result?.workspace).toBe('/new');
    expect(result?.workspaceDir).toBeUndefined();
  });

  it('T364 round 8 — preserves older workspace alias when newer config asserts none', () => {
    // Anti-test: if the newer config carries no workspace signal at all,
    // the older alias must survive (no spurious scrubs).
    const api = {
      runtime: { config: { workspaceDir: '/persistent' } },
      cfg: { session: { dmScope: 'main' } },
    } as any;
    const result = resolveOpenClawRouteMetadataConfig(api);
    expect(result).toBeDefined();
    expect(result?.workspaceDir).toBe('/persistent');
    expect((result?.session as any)?.dmScope).toBe('main');
  });

  it('T364 follow-up — recognizes legacy `workspaceDir`-only route config as route metadata', () => {
    // Codex follow-up regression: pre-fix `hasRouteMetadataConfigSignal`
    // checked only `agents`/`session`/`workspace`. A runtime cfg
    // carrying just `workspaceDir` (the third entry in setup.ts's
    // recognized fallback chain `agents.defaults.workspace -> workspace
    // -> workspaceDir`) was dropped from route metadata, so
    // `resolveChannelDispatchConfig` lost the workspace path entirely
    // on those layouts. Including `workspaceDir` in the signal check
    // keeps setup-time and runtime recognition aligned.
    const routeConfig = {
      workspaceDir: '/legacy-workspace',
    };
    const api = {
      config: {},
      cfg: routeConfig,
    } as any;

    expect(resolveOpenClawMergedConfig(api)).toBeUndefined();
    expect(resolveOpenClawRouteMetadataConfig(api)).toEqual(routeConfig);
  });

  it('keeps session-only route metadata separate from merged plugin config', () => {
    const routeConfig = {
      session: {
        dmScope: 'main',
      },
    };
    const runtimeConfig = {
      plugins: {
        slots: {
          memory: 'other-plugin',
        },
      },
    };
    const api = {
      config: routeConfig,
      runtime: {
        config: runtimeConfig,
      },
    } as any;

    expect(resolveOpenClawMergedConfig(api)).toBe(runtimeConfig);
    expect(resolveOpenClawRouteMetadataConfig(api)).toEqual(routeConfig);
  });

  it('merges session-only route metadata with lower-priority workspace route metadata', () => {
    const api = {
      cfg: {
        session: {
          dmScope: 'main',
        },
      },
      config: {
        agents: {
          defaults: {
            workspace: '/workspace',
          },
        },
        session: {
          ttlMs: 30_000,
        },
      },
    } as any;

    expect(resolveOpenClawRouteMetadataConfig(api)).toEqual({
      agents: {
        defaults: {
          workspace: '/workspace',
        },
      },
      session: {
        ttlMs: 30_000,
        dmScope: 'main',
      },
    });
  });

  it('deep-merges memory and channel partials without dropping prior subconfig', () => {
    expect(mergeAdapterPluginConfigs(
      {
        daemonUrl: 'http://127.0.0.1:9200',
        memory: { enabled: true, memoryDir: '/memory' },
        channel: { enabled: true, port: 9201 },
      },
      {
        memory: { enabled: false },
        channel: { port: 9202 },
      },
    )).toEqual({
      daemonUrl: 'http://127.0.0.1:9200',
      memory: { enabled: false, memoryDir: '/memory' },
      channel: { enabled: true, port: 9202 },
    });
  });

  it('classifies module objects without enabled as partial overlays', () => {
    expect(isPartialAdapterConfigOverlay({
      channel: { port: 9801 },
    })).toBe(true);
    expect(isPartialAdapterConfigOverlay({
      memory: { memoryDir: '/memory' },
      channel: { port: 9801 },
    })).toBe(true);
    expect(isPartialAdapterConfigOverlay({
      channel: { enabled: false },
    })).toBe(true);
    expect(isPartialAdapterConfigOverlay({
      memory: { enabled: true },
    })).toBe(true);
    expect(isPartialAdapterConfigOverlay({
      daemonUrl: 'http://127.0.0.1:9200',
      memory: { enabled: true },
    })).toBe(false);
  });
});
