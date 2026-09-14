import { daemonState } from '../state.js';
import {
  formatOpenClawUiAttachFailure,
  isOpenClawMemorySlotElected,
  isOpenClawUiAttachCancelled,
  probeOpenClawChannelHealth,
  restartOpenClawGateway,
  runOpenClawUiSetup,
  scheduleOpenClawUiAttachJob,
  transportPatchFromOpenClawTarget,
  waitForOpenClawChatReady,
} from '../openclaw.js';
import type { OpenClawUiAttachDeps } from '../openclaw.js';
import type { LocalAgentConnectorStrategy } from './types.js';

export type OpenClawConnectorDeps = OpenClawUiAttachDeps;

export function createOpenClawConnector(deps: OpenClawConnectorDeps = {}): LocalAgentConnectorStrategy {
  const createPlan: LocalAgentConnectorStrategy['createPlan'] = async (context) => {
    const {
      config,
      requested,
      bridgeAuthToken,
      existingBeforeConnect,
      hadStoredTransportBeforeConnect,
    } = context;
    const probeHealth = deps.probeHealth ?? probeOpenClawChannelHealth;
    const waitForReady = deps.waitForReady ?? waitForOpenClawChatReady;
    const runSetup = deps.runSetup ?? runOpenClawUiSetup;
    const restartGateway = deps.restartGateway ?? restartOpenClawGateway;
    const verifyMemorySlot = deps.verifyMemorySlot ?? isOpenClawMemorySlotElected;

    const health = await probeHealth(config, bridgeAuthToken, { ignoreBridgeCache: true });
    if (health.ok && hadStoredTransportBeforeConnect) {
      return {
        ok: true,
        state: {
          transport: transportPatchFromOpenClawTarget(config, health.target),
          runtime: { status: 'ready', ready: true, lastError: null },
        },
        notice: `${requested.name} is connected and chat-ready.`,
      };
    }

    // Setup is deferred: the registration's `connecting` runtime stands until
    // the attach job persists its result.
    return {
      ok: true,
      state: {},
      afterCommit: (sink) => {
        const { started } = scheduleOpenClawUiAttachJob(requested.id, async (attachJob) => {
          try {
            daemonState.openClawBridgeHealth = null;
            await runSetup(attachJob.controller.signal);
            if (isOpenClawUiAttachCancelled(attachJob)) return;
            daemonState.openClawBridgeHealth = null;

            if (!verifyMemorySlot()) {
              await sink.persist({
                runtime: {
                  status: 'error',
                  ready: false,
                  lastError: 'OpenClaw memory slot election failed after setup — adapter-openclaw not elected to plugins.slots.memory',
                },
              });
              return;
            }

            let currentConfig = sink.current();
            let latest = await probeHealth(currentConfig, bridgeAuthToken, {
              ignoreBridgeCache: true,
              timeoutMs: 3_000,
            });
            if (isOpenClawUiAttachCancelled(attachJob)) return;
            if (!latest.ok) {
              await restartGateway(attachJob.controller.signal);
              if (isOpenClawUiAttachCancelled(attachJob)) return;
              daemonState.openClawBridgeHealth = null;
              currentConfig = sink.current();
              latest = await waitForReady(currentConfig, bridgeAuthToken, attachJob.controller.signal);
            }
            if (isOpenClawUiAttachCancelled(attachJob)) return;

            currentConfig = sink.current();
            await sink.persist({
              transport: transportPatchFromOpenClawTarget(currentConfig, latest.target),
              runtime: latest.ok
                ? { status: 'ready', ready: true, lastError: null }
                : { status: 'connecting', ready: false, lastError: latest.error ?? null },
            });
          } catch (err: unknown) {
            if (isOpenClawUiAttachCancelled(attachJob)) return;
            await sink.persist({
              enabled: hadStoredTransportBeforeConnect ? true : false,
              ...(hadStoredTransportBeforeConnect && existingBeforeConnect?.transport
                ? { transport: existingBeforeConnect.transport }
                : {}),
              runtime: {
                status: 'error',
                ready: false,
                lastError: formatOpenClawUiAttachFailure(err),
              },
            });
          } finally {
            daemonState.openClawBridgeHealth = null;
          }
        }, deps.onAttachScheduled);
        return started
          ? 'OpenClaw attach started. This chat tab will come online automatically once OpenClaw finishes reloading.'
          : 'OpenClaw attach is already in progress. This chat tab will come online automatically once OpenClaw finishes reloading.';
      },
    };
  };
  return { createPlan };
}
