import { DKGEvent, type EventBus } from '@origintrail-official/dkg-core';
import { parseProjectSyncedReadinessPayload, type ProjectSyncedReadinessPayload } from './context-graph-project-synced-payload.js';

/** Keep internal verification requests separate from externally visible completion. */
export function registerContextGraphReadinessEvents(input: {
  eventBus: EventBus;
  verifyCatalog: (contextGraphId: string) => Promise<boolean>;
  persistProject: (payload: ProjectSyncedReadinessPayload) => Promise<boolean>;
  log: (message: string) => void;
}): void {
  input.eventBus.on(DKGEvent.CATALOG_READINESS_CHECK_REQUESTED, (data: unknown) => {
    if (data === null || typeof data !== 'object' || !('contextGraphId' in data)
      || typeof data.contextGraphId !== 'string') return;
    void input.verifyCatalog(data.contextGraphId).catch((err) => {
      input.log(`[warn] Failed to verify catalog readiness: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  input.eventBus.on(DKGEvent.PROJECT_SYNCED, (data: unknown) => {
    const payload = parseProjectSyncedReadinessPayload(data);
    if (!payload) return;
    void input.persistProject(payload).catch((err) => {
      input.log(`[warn] Failed to persist PROJECT_SYNCED readiness: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
}
