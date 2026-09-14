import {
  probePrimeAgentChannelHealth,
  targetFromDescriptor,
  transportPatchFromPrimeAgentTarget,
} from '../prime-agent.js';
import {
  cancelPendingAndDrain,
  isCancelled,
  scheduleAttachJob,
} from '../local-agent-attach-jobs.js';
import type {
  LocalAgentConnectorStrategy,
} from './types.js';

export interface PrimeAgentConnectorDeps {
  runPrimeAgentSetup?: () => Promise<{ ok: boolean; errors: string[]; warnings: string[] }>;
  onAttachScheduled?: (id: string, job: Promise<void>) => void;
}

async function runPrimeAgentUiSetup(
  deps: PrimeAgentConnectorDeps,
): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  if (deps.runPrimeAgentSetup) return deps.runPrimeAgentSetup();
  try {
    const { runPrimeAgentSetup } = await import('@origintrail-official/dkg-adapter-prime-agent');
    const result = await runPrimeAgentSetup({ verify: false });
    return { ok: result.ok, errors: result.errors ?? [], warnings: result.warnings ?? [] };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`Prime Agent setup unavailable: ${message}`], warnings: [] };
  }
}

export function createPrimeAgentConnector(deps: PrimeAgentConnectorDeps = {}): LocalAgentConnectorStrategy {
  const createPlan: LocalAgentConnectorStrategy['createPlan'] = async ({ requested, bridgeAuthToken }) => {
    // Setup is deferred: the registration's `connecting` runtime stands until
    // the attach job persists its result.
    return {
      ok: true,
      state: {},
      afterCommit: (sink) => {
        const attachJob = scheduleAttachJob(requested.id, async (attachJob) => {
          try {
            const setup = await runPrimeAgentUiSetup(deps);
            if (isCancelled(attachJob)) return;
            if (!setup.ok) {
              await sink.persist({
                runtime: {
                  status: 'error',
                  ready: false,
                  lastError: setup.errors.join('; ') || 'Prime Agent setup failed',
                },
              });
              return;
            }

            const health = await probePrimeAgentChannelHealth(bridgeAuthToken, { timeoutMs: 3_000 });
            if (isCancelled(attachJob)) return;
            const live = health.sessions.find((session) => session.sessionId === health.target)
              ?? health.sessions[0];
            const activeSessionId = health.sessions[0]?.sessionId ?? null;
            const activeMemorySessionId = health.sessions[0]?.memorySessionId ?? null;

            if (health.ok && live) {
              await sink.persist({
                transport: transportPatchFromPrimeAgentTarget(targetFromDescriptor(live)),
                runtime: { status: 'ready', ready: true, lastError: null },
                metadata: { sessionCount: health.sessionCount, activeSessionId, activeMemorySessionId },
              });
              return;
            }

            await sink.persist({
              runtime: {
                status: 'degraded',
                ready: false,
                lastError: health.error ?? 'no live Prime Agent session',
              },
              metadata: { sessionCount: health.sessionCount, activeSessionId, activeMemorySessionId },
            });
          } catch (err: unknown) {
            if (isCancelled(attachJob)) return;
            await sink.persist({
              runtime: {
                status: 'error',
                ready: false,
                lastError: err instanceof Error ? err.message : 'Prime Agent attach failed',
              },
            });
          }
        }, deps.onAttachScheduled);
        return {
          attachJob,
          notice: attachJob.started
            ? 'Prime Agent setup started. This chat tab will come online automatically once Prime Agent finishes setting up.'
            : 'Prime Agent setup is already in progress. This chat tab will come online automatically once Prime Agent finishes setting up.',
        };
      },
    };
  };
  const createDisconnectPlan: LocalAgentConnectorStrategy['createDisconnectPlan'] = async () => {
    let restoreError: string | undefined;
    try {
      const { restorePrimeAgentProfile } = await import('@origintrail-official/dkg-adapter-prime-agent');
      const result = await restorePrimeAgentProfile({});
      if (!result?.ok) restoreError = result?.restoreError ?? 'restore reported failure';
    } catch (err: unknown) {
      restoreError = `Prime Agent restore failed: ${err instanceof Error ? err.message : 'unknown error'}`;
    }
    return {
      state: {
        runtime: {
          status: 'disconnected',
          ready: false,
          lastError: restoreError ?? null,
        },
      },
    };
  };
  return { createPlan, cancelPending: cancelPendingAndDrain, createDisconnectPlan };
}
