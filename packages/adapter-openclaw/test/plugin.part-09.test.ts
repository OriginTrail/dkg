import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { homedir, tmpdir } from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { toEip55Checksum } from '@origintrail-official/dkg-core';
import { DkgNodePlugin } from '../src/DkgNodePlugin.js';
import { DkgChannelPlugin } from '../src/DkgChannelPlugin.js';
import { ChatTurnWriter } from '../src/ChatTurnWriter.js';
import { INTERNAL_HOOK_SYMBOL } from '../src/HookSurface.js';
import type { OpenClawPluginApi, OpenClawTool } from '../src/types.js';

describe("DkgNodePlugin", () => {


  it('clears stored local-agent bridge state when disable races with a completed in-flight stop', async () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const getLocalAgentIntegration = vi.fn().mockResolvedValue({
      id: 'openclaw',
      enabled: true,
      runtime: { status: 'configured', ready: true },
      metadata: { transportMode: 'openclaw-channel' },
    });
    const updateLocalAgentIntegration = vi.fn().mockResolvedValue({});
    (plugin as any).client = { getLocalAgentIntegration, updateLocalAgentIntegration };
    (plugin as any).channelPlugin = null;
    (plugin as any).channelPluginStopInFlight = Promise.resolve(true);
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };

    (plugin as any).registerIntegrationModules(mockApi, {
      enableFullRuntime: true,
      registrationMode: 'full',
    });

    await vi.waitFor(() => {
      expect(updateLocalAgentIntegration).toHaveBeenCalledWith(
        'openclaw',
        expect.objectContaining({
          enabled: false,
          capabilities: expect.objectContaining({
            localChat: false,
            chatAttachments: false,
            connectFromUi: false,
          }),
          metadata: expect.objectContaining({ transportMode: 'disabled' }),
          runtime: expect.objectContaining({ status: 'configured', ready: false }),
        }),
      );
    });
  });


  it('clears stored local-agent bridge state on cold runtime registration with channel disabled', async () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const getLocalAgentIntegration = vi.fn().mockResolvedValue({
      id: 'openclaw',
      enabled: true,
      runtime: { status: 'configured', ready: true },
      metadata: { transportMode: 'openclaw-channel' },
    });
    const updateLocalAgentIntegration = vi.fn().mockResolvedValue({});
    (plugin as any).client = { getLocalAgentIntegration, updateLocalAgentIntegration };
    (plugin as any).channelPlugin = null;
    (plugin as any).channelPluginStopInFlight = null;
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };

    (plugin as any).registerIntegrationModules(mockApi, {
      enableFullRuntime: true,
      registrationMode: 'full',
    });

    await vi.waitFor(() => {
      expect(updateLocalAgentIntegration).toHaveBeenCalledWith(
        'openclaw',
        expect.objectContaining({
          enabled: false,
          capabilities: expect.objectContaining({
            localChat: false,
            chatAttachments: false,
            connectFromUi: false,
          }),
          metadata: expect.objectContaining({ transportMode: 'disabled' }),
          runtime: expect.objectContaining({ status: 'configured', ready: false }),
        }),
      );
    });
  });


  it('skips disabled-channel cleanup on cold runtime registration when no local-agent record exists', async () => {
    const debug = vi.fn();
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const getLocalAgentIntegration = vi.fn().mockResolvedValue(null);
    const updateLocalAgentIntegration = vi.fn().mockResolvedValue({});
    (plugin as any).client = { getLocalAgentIntegration, updateLocalAgentIntegration };
    (plugin as any).channelPlugin = null;
    (plugin as any).channelPluginStopInFlight = null;
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug },
    };

    (plugin as any).registerIntegrationModules(mockApi, {
      enableFullRuntime: true,
      registrationMode: 'full',
    });

    await vi.waitFor(() => {
      expect(getLocalAgentIntegration).toHaveBeenCalledWith('openclaw');
    });
    expect(updateLocalAgentIntegration).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('nothing to clear'));
  });


  it('retries disabled-channel local-agent cleanup after a transient stored-state load failure', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const debug = vi.fn();
    const info = vi.fn();
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const getLocalAgentIntegration = vi.fn()
      .mockRejectedValueOnce(new Error('daemon cold start'))
      .mockResolvedValueOnce({
        id: 'openclaw',
        enabled: true,
        runtime: { status: 'configured', ready: true },
        metadata: { transportMode: 'openclaw-channel' },
      });
    const updateLocalAgentIntegration = vi.fn().mockResolvedValue({});
    (plugin as any).client = { getLocalAgentIntegration, updateLocalAgentIntegration };
    (plugin as any).channelPlugin = null;
    (plugin as any).channelPluginStopInFlight = null;
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info, warn, debug },
    };

    try {
      (plugin as any).registerIntegrationModules(mockApi, {
        enableFullRuntime: true,
        registrationMode: 'full',
      });
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }

      expect(getLocalAgentIntegration).toHaveBeenCalledTimes(1);
      expect(updateLocalAgentIntegration).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('retrying disabled-channel status update'));

      await vi.advanceTimersByTimeAsync(4_999);
      expect(getLocalAgentIntegration).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }

      expect(getLocalAgentIntegration).toHaveBeenCalledTimes(2);
      expect(updateLocalAgentIntegration).toHaveBeenCalledWith(
        'openclaw',
        expect.objectContaining({
          enabled: false,
          metadata: expect.objectContaining({ transportMode: 'disabled' }),
          runtime: expect.objectContaining({ status: 'configured', ready: false }),
        }),
      );
      expect(info).toHaveBeenCalledWith(expect.stringContaining('loaded for disabled-channel cleanup after 1 retry attempt'));
    } finally {
      vi.useRealTimers();
      await plugin.stop();
    }
  });


  it('stops disabled-channel cleanup retry when the stored local-agent record is still missing', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const info = vi.fn();
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const getLocalAgentIntegration = vi.fn()
      .mockRejectedValueOnce(new Error('daemon cold start'))
      .mockResolvedValueOnce(null);
    const updateLocalAgentIntegration = vi.fn().mockResolvedValue({});
    (plugin as any).client = { getLocalAgentIntegration, updateLocalAgentIntegration };
    (plugin as any).channelPlugin = null;
    (plugin as any).channelPluginStopInFlight = null;
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info, warn, debug: vi.fn() },
    };

    try {
      (plugin as any).registerIntegrationModules(mockApi, {
        enableFullRuntime: true,
        registrationMode: 'full',
      });
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }

      expect(getLocalAgentIntegration).toHaveBeenCalledTimes(1);
      expect(updateLocalAgentIntegration).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('retrying disabled-channel status update'));

      await vi.advanceTimersByTimeAsync(5_000);
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }

      expect(getLocalAgentIntegration).toHaveBeenCalledTimes(2);
      expect(updateLocalAgentIntegration).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(expect.stringContaining('nothing to clear'));
      expect((plugin as any).localAgentIntegrationRetryTimer).toBeNull();
    } finally {
      vi.useRealTimers();
      await plugin.stop();
    }
  });


  it('does not let a stale disabled-channel cleanup retry overwrite a later re-enable', async () => {
    vi.useFakeTimers();
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const getLocalAgentIntegration = vi.fn()
      .mockRejectedValueOnce(new Error('daemon cold start'))
      .mockResolvedValueOnce(null);
    const updateLocalAgentIntegration = vi.fn().mockResolvedValue({});
    (plugin as any).client = { getLocalAgentIntegration, updateLocalAgentIntegration };
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };

    try {
      (plugin as any).registerIntegrationModules(mockApi, {
        enableFullRuntime: true,
        registrationMode: 'full',
      });
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }
      expect(getLocalAgentIntegration).toHaveBeenCalledTimes(1);

      (plugin as any).config.channel = { enabled: true, port: 0 };
      await vi.advanceTimersByTimeAsync(5_000);

      expect(getLocalAgentIntegration).toHaveBeenCalledTimes(1);
      expect(updateLocalAgentIntegration).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await plugin.stop();
    }
  });


  it('cancels a pending local-agent retry when clearing a disabled channel', async () => {
    vi.useFakeTimers();
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: true },
    });
    const getLocalAgentIntegration = vi.fn().mockResolvedValue({
      id: 'openclaw',
      enabled: true,
      runtime: { status: 'configured', ready: true },
      metadata: { transportMode: 'openclaw-channel' },
    });
    const updateLocalAgentIntegration = vi.fn().mockResolvedValue({});
    (plugin as any).client = { getLocalAgentIntegration, updateLocalAgentIntegration };
    const syncLocalAgentIntegrationState = vi
      .spyOn(plugin as any, 'syncLocalAgentIntegrationState')
      .mockResolvedValue(undefined);
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };

    try {
      (plugin as any).scheduleLocalAgentIntegrationRetry(mockApi, 'full');
      expect((plugin as any).localAgentIntegrationRetryTimer).not.toBeNull();

      (plugin as any).clearLocalAgentChannelIntegration(mockApi, 'full');

      expect((plugin as any).localAgentIntegrationRetryTimer).toBeNull();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(syncLocalAgentIntegrationState).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(updateLocalAgentIntegration).toHaveBeenCalledWith(
          'openclaw',
          expect.objectContaining({
            enabled: false,
            capabilities: expect.objectContaining({ localChat: false, connectFromUi: false }),
            metadata: expect.objectContaining({ transportMode: 'disabled' }),
          }),
        );
      });
    } finally {
      vi.useRealTimers();
      syncLocalAgentIntegrationState.mockRestore();
    }
  });


  it('does not re-enable an explicitly disconnected stored bridge when channel is disabled', async () => {
    const info = vi.fn();
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const getLocalAgentIntegration = vi.fn().mockResolvedValue({
      id: 'openclaw',
      enabled: false,
      runtime: { status: 'disconnected', ready: false },
      metadata: { userDisabled: true },
    });
    const updateLocalAgentIntegration = vi.fn().mockResolvedValue({});
    (plugin as any).client = { getLocalAgentIntegration, updateLocalAgentIntegration };
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info, warn: vi.fn(), debug: vi.fn() },
    };

    (plugin as any).registerIntegrationModules(mockApi, {
      enableFullRuntime: true,
      registrationMode: 'full',
    });

    await vi.waitFor(() => {
      expect(getLocalAgentIntegration).toHaveBeenCalledWith('openclaw');
    });
    expect(updateLocalAgentIntegration).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('explicitly disconnected by the user'));
  });


  it('does not advertise memory capabilities when clearing a disabled channel during memory disable', async () => {
    const plugin = new DkgNodePlugin({
      daemonUrl: 'http://localhost:9200',
      channel: { enabled: false },
      memory: { enabled: false },
    });
    const getLocalAgentIntegration = vi.fn().mockResolvedValue({
      id: 'openclaw',
      enabled: true,
      runtime: { status: 'configured', ready: true },
      metadata: { transportMode: 'openclaw-channel' },
    });
    const updateLocalAgentIntegration = vi.fn().mockResolvedValue({});
    const memoryPlugin = {
      isRegistered: vi.fn(() => true),
      disable: vi.fn(() => true),
      close: vi.fn(async () => {}),
    };
    (plugin as any).client = { getLocalAgentIntegration, updateLocalAgentIntegration };
    (plugin as any).memoryPlugin = memoryPlugin;
    const mockApi: OpenClawPluginApi = {
      config: {},
      registrationMode: 'full',
      registerTool: () => {},
      registerHook: () => {},
      on: () => {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    };

    (plugin as any).registerIntegrationModules(mockApi, {
      enableFullRuntime: true,
      registrationMode: 'full',
    });

    await vi.waitFor(() => {
      expect(updateLocalAgentIntegration).toHaveBeenCalledWith(
        'openclaw',
        expect.objectContaining({
          capabilities: expect.objectContaining({
            localChat: false,
            chatAttachments: false,
            connectFromUi: false,
            dkgPrimaryMemory: false,
            wmImportPipeline: false,
          }),
        }),
      );
    });
    expect(memoryPlugin.disable).toHaveBeenCalledWith(mockApi);
  });
});
